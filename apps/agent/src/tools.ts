import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  LIMITS,
  type AgentToolName,
  batchExecInputSchema,
  describeWorkspaceChangesInputSchema,
  describeWorkspaceInputSchema,
  inspectWorkspaceDiffInputSchema,
  inspectFileInputSchema,
  listTreeInputSchema,
  searchFileInputSchema,
  workspaceError
} from "@workspace-viewer/protocol";
import type { AgentConfig, WorkspaceConfig } from "./config.js";
import { fail, toWorkspaceError } from "./errors.js";
import { isIgnored, normalizeRelative, normalizeUserRelativePathForGit, resolveWorkspacePath, safeLstat } from "./pathGuard.js";
import { countLines, detectLanguage, fileSize, isProbablyBinary, jsonByteLength } from "./utils.js";

type ToolResult = unknown;
const execFileAsync = promisify(execFile);

export async function executeTool(
  config: AgentConfig,
  tool: AgentToolName,
  input: unknown
): Promise<ToolResult> {
  switch (tool) {
    case "describeWorkspace":
      return describeWorkspace(config, describeWorkspaceInputSchema.parse(input));
    case "listTree":
      return listTree(config, listTreeInputSchema.parse(input));
    case "inspectFile":
      return inspectFile(config, inspectFileInputSchema.parse(input));
    case "searchFile":
      return searchFile(config, searchFileInputSchema.parse(input));
    case "batchExec":
      return batchExec(config, batchExecInputSchema.parse(input));
    case "describeWorkspaceChanges":
      return describeWorkspaceChanges(config, describeWorkspaceChangesInputSchema.parse(input));
    case "inspectWorkspaceDiff":
      return inspectWorkspaceDiff(config, inspectWorkspaceDiffInputSchema.parse(input));
  }
}

function getWorkspace(config: AgentConfig, workspaceId: string): WorkspaceConfig {
  const workspace = config.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
  if (!workspace) {
    fail("WORKSPACE_NOT_FOUND", "Workspace is not configured on this agent", { workspaceId });
  }
  return workspace;
}

async function describeWorkspace(config: AgentConfig, input: { workspaceId: string }) {
  const workspace = getWorkspace(config, input.workspaceId);
  const resolved = await resolveWorkspacePath(workspace);
  const entries = await readdir(resolved.realPath, { withFileTypes: true });
  const rootEntries = entries
    .filter((entry) => !isIgnored(workspace, entry.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" as const : "file" as const
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    workspaceId: workspace.workspaceId,
    displayName: workspace.displayName,
    languages: workspace.languages,
    rootEntries,
    markers: await detectMarkers(resolved.realPath)
  };
}

async function detectMarkers(root: string): Promise<string[]> {
  const markerFiles: Array<[string, string]> = [
    ["package.json", "node-package"],
    ["pyproject.toml", "python-project"],
    ["pom.xml", "maven"],
    ["build.gradle", "gradle"],
    [".git", "git-repository"]
  ];
  const markers: string[] = [];
  const entries = new Set((await readdir(root)).map(String));
  for (const [file, marker] of markerFiles) {
    if (entries.has(file)) markers.push(marker);
  }
  return markers;
}

async function listTree(config: AgentConfig, input: {
  workspaceId: string;
  path?: string | undefined;
  depth?: number | undefined;
  includeFiles?: boolean | undefined;
}) {
  const workspace = getWorkspace(config, input.workspaceId);
  const depth = Math.min(input.depth ?? 1, LIMITS.listTree.maxDepth);
  const includeFiles = input.includeFiles ?? true;
  const resolved = await resolveWorkspacePath(workspace, input.path);
  const entriesCount = { value: 0 };
  const rootEntries = await readTree(workspace, resolved.rootRealPath, resolved.realPath, depth, includeFiles, entriesCount);
  return {
    path: resolved.relativePath,
    depth,
    entries: rootEntries.entries,
    truncated: rootEntries.truncated
  };
}

async function readTree(
  workspace: WorkspaceConfig,
  root: string,
  current: string,
  depthRemaining: number,
  includeFiles: boolean,
  entriesCount: { value: number }
): Promise<{ entries: unknown[]; truncated: boolean }> {
  let truncated = false;
  const dirents = await readdir(current, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(current, dirent.name);
    const relativePath = normalizeRelative(path.relative(root, fullPath));
    if (isIgnored(workspace, relativePath)) continue;
    if (!dirent.isDirectory() && !includeFiles) continue;
    entriesCount.value += 1;
    if (entriesCount.value > LIMITS.listTree.maxEntries) {
      truncated = true;
      break;
    }

    const entry: { name: string; path: string; type: "file" | "directory"; children?: unknown[] } = {
      name: dirent.name,
      path: relativePath,
      type: dirent.isDirectory() ? "directory" : "file"
    };
    if (dirent.isDirectory() && depthRemaining > 0) {
      const child = await readTree(workspace, root, fullPath, depthRemaining - 1, includeFiles, entriesCount);
      entry.children = child.entries;
      truncated ||= child.truncated;
    }
    entries.push(entry);
  }
  return { entries, truncated };
}

async function inspectFile(config: AgentConfig, input: {
  workspaceId: string;
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
}) {
  const workspace = getWorkspace(config, input.workspaceId);
  const resolved = await resolveWorkspacePath(workspace, input.path);
  const stat = await safeLstat(resolved.realPath);
  if (!stat.isFile()) fail("INVALID_PARAMS", "Path is not a file", { path: input.path });
  if (stat.size > LIMITS.inspectFile.maxFileBytes) {
    fail("FILE_TOO_LARGE", "File exceeds inspect size limit", { path: input.path, sizeBytes: stat.size });
  }
  if (await isProbablyBinary(resolved.realPath)) {
    fail("INVALID_PARAMS", "Binary files cannot be inspected", { path: input.path });
  }

  const totalLines = await countLines(resolved.realPath);
  const startLine = input.startLine ?? 1;
  const requestedEnd = input.endLine ?? Math.min(totalLines, startLine + LIMITS.inspectFile.maxLines - 1);
  const endLine = Math.min(requestedEnd, startLine + LIMITS.inspectFile.maxLines - 1, totalLines);
  const contentLines: string[] = [];
  let lineNumber = 0;
  const rl = createInterface({ input: createReadStream(resolved.realPath), crlfDelay: Infinity });
  for await (const line of rl) {
    lineNumber += 1;
    if (lineNumber >= startLine && lineNumber <= endLine) contentLines.push(line);
    if (lineNumber > endLine) break;
  }

  return {
    path: resolved.relativePath,
    language: detectLanguage(resolved.realPath),
    sizeBytes: stat.size,
    totalLines,
    startLine,
    endLine,
    content: contentLines.join("\n"),
    truncated: requestedEnd < totalLines || endLine < totalLines
  };
}

async function searchFile(config: AgentConfig, input: {
  workspaceId: string;
  mode: "path" | "content";
  query: string;
  pathPrefix?: string | undefined;
  fileGlob?: string[] | undefined;
  maxResults?: number | undefined;
  contextLines?: number | undefined;
}) {
  const workspace = getWorkspace(config, input.workspaceId);
  const base = await resolveWorkspacePath(workspace, input.pathPrefix);
  const maxResults = Math.min(input.maxResults ?? LIMITS.searchFile.maxResults, LIMITS.searchFile.maxResults);
  const deadline = Date.now() + LIMITS.searchFile.searchTimeoutMs;

  if (input.mode === "path") {
    const matches: Array<{ path: string; name: string; type: "file" | "directory" }> = [];
    let truncated = false;
    for await (const entry of walk(workspace, base.rootRealPath, base.realPath, deadline)) {
      if (entry.relativePath.toLowerCase().includes(input.query.toLowerCase())) {
        matches.push({ path: entry.relativePath, name: path.basename(entry.relativePath), type: entry.type });
      }
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
    }
    return { mode: "path", query: input.query, matches, truncated };
  }

  return searchContent(workspace, base.rootRealPath, base.realPath, input, maxResults, deadline);
}

async function searchContent(
  workspace: WorkspaceConfig,
  root: string,
  basePath: string,
  input: {
    query: string;
    fileGlob?: string[] | undefined;
    contextLines?: number | undefined;
  },
  maxResults: number,
  deadline: number
) {
  const matches: Array<{ path: string; line: number; preview: string; before?: string[]; after?: string[] }> = [];
  let truncated = false;
  const contextLines = Math.min(input.contextLines ?? 0, LIMITS.searchFile.maxContextLines);
  const queryLower = input.query.toLowerCase();

  for await (const entry of walk(workspace, root, basePath, deadline)) {
    if (entry.type !== "file") continue;
    if (!matchesGlob(entry.relativePath, input.fileGlob)) continue;
    const size = await fileSize(entry.fullPath);
    if (size > LIMITS.searchFile.maxFileBytes) continue;
    if (await isProbablyBinary(entry.fullPath)) continue;

    const pendingAfter: Array<{ matchIndex: number; remaining: number }> = [];
    const beforeBuffer: string[] = [];
    let lineNumber = 0;
    const rl = createInterface({ input: createReadStream(entry.fullPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (Date.now() > deadline) fail("SEARCH_TIMEOUT", "Content search exceeded timeout");
      lineNumber += 1;

      for (const pending of [...pendingAfter]) {
        const target = matches[pending.matchIndex];
        if (target) target.after = [...(target.after ?? []), line];
        pending.remaining -= 1;
        if (pending.remaining <= 0) pendingAfter.splice(pendingAfter.indexOf(pending), 1);
      }

      if (line.toLowerCase().includes(queryLower)) {
        const match: { path: string; line: number; preview: string; before?: string[]; after?: string[] } = {
          path: entry.relativePath,
          line: lineNumber,
          preview: line
        };
        if (contextLines > 0) {
          match.before = [...beforeBuffer];
          match.after = [];
        }
        matches.push(match);
        if (contextLines > 0) pendingAfter.push({ matchIndex: matches.length - 1, remaining: contextLines });
        if (matches.length >= maxResults) {
          truncated = true;
          rl.close();
          break;
        }
      }

      beforeBuffer.push(line);
      while (beforeBuffer.length > contextLines) beforeBuffer.shift();
    }
    if (matches.length >= maxResults) break;
    if (jsonByteLength({ mode: "content", query: input.query, matches, truncated }) > LIMITS.searchFile.maxUncompressedResultBytes) {
      truncated = true;
      break;
    }
  }

  return { mode: "content", query: input.query, matches, truncated };
}

async function batchExec(config: AgentConfig, input: {
  workspaceId: string;
  operations: Array<{ id: string; tool: Exclude<AgentToolName, "batchExec">; input: unknown }>;
}) {
  const results = [];
  for (const operation of input.operations) {
    try {
      const result = await executeTool(config, operation.tool, {
        ...(operation.input as object),
        workspaceId: input.workspaceId
      });
      results.push({ id: operation.id, ok: true, result });
    } catch (error) {
      results.push({ id: operation.id, ok: false, error: toWorkspaceError(error) });
    }
  }
  return { results };
}

async function describeWorkspaceChanges(config: AgentConfig, input: {
  workspaceId: string;
  includeUntracked?: boolean | undefined;
  maxFiles?: number | undefined;
}) {
  const workspace = getWorkspace(config, input.workspaceId);
  const resolved = await resolveWorkspacePath(workspace);
  const maxFiles = Math.min(input.maxFiles ?? LIMITS.gitStatus.maxFiles, LIMITS.gitStatus.maxFiles);
  const untrackedMode = input.includeUntracked === false ? "no" : "normal";
  const result = await runGit(resolved.realPath, [
    "status",
    "--porcelain=v2",
    "--branch",
    `--untracked-files=${untrackedMode}`
  ], LIMITS.gitStatus.timeoutMs, LIMITS.gitStatus.maxUncompressedResultBytes);

  if (result.exitCode !== 0 && isNotGitRepository(result.stderr)) {
    return { isGitRepository: false, files: [], truncated: false };
  }
  if (result.exitCode !== 0) {
    fail("GIT_COMMAND_FAILED", "Git status failed", { stderr: trimError(result.stderr) });
  }

  const parsed = parsePorcelainV2Status(result.stdout, maxFiles);
  return {
    isGitRepository: true,
    ...parsed
  };
}

async function inspectWorkspaceDiff(config: AgentConfig, input: {
  workspaceId: string;
  path?: string | undefined;
  staged?: boolean | undefined;
  maxBytes?: number | undefined;
}) {
  const workspace = getWorkspace(config, input.workspaceId);
  const root = await resolveWorkspacePath(workspace);
  const staged = input.staged ?? false;
  const maxBytes = Math.min(input.maxBytes ?? LIMITS.gitDiff.maxBytes, LIMITS.gitDiff.maxBytes);
  const args = ["diff"];
  if (staged) args.push("--cached");
  let gitPath: string | undefined;
  if (input.path) {
    const resolvedPath = await normalizeUserRelativePathForGit(workspace, input.path);
    gitPath = resolvedPath.relativePath;
    args.push("--", gitPath);
  }

  const result = await runGit(root.realPath, args, LIMITS.gitDiff.timeoutMs, maxBytes);
  if (result.exitCode !== 0 && isNotGitRepository(result.stderr)) {
    fail("GIT_COMMAND_FAILED", "Workspace is not a Git repository", { code: "NOT_GIT_REPOSITORY" });
  }
  if (result.exitCode !== 0) {
    fail("GIT_COMMAND_FAILED", "Git diff failed", { stderr: trimError(result.stderr) });
  }

  return {
    ...(gitPath ? { path: gitPath } : {}),
    staged,
    diff: result.stdout,
    truncated: result.truncated
  };
}

async function* walk(
  workspace: WorkspaceConfig,
  root: string,
  current: string,
  deadline: number
): AsyncGenerator<{ fullPath: string; relativePath: string; type: "file" | "directory" }> {
  if (Date.now() > deadline) fail("SEARCH_TIMEOUT", "Search exceeded timeout");
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(current, entry.name);
    const relativePath = normalizeRelative(path.relative(root, fullPath));
    if (isIgnored(workspace, relativePath)) continue;
    const type = entry.isDirectory() ? "directory" as const : "file" as const;
    yield { fullPath, relativePath, type };
    if (entry.isDirectory()) {
      yield* walk(workspace, root, fullPath, deadline);
    }
  }
}

function matchesGlob(relativePath: string, globs?: string[]): boolean {
  if (!globs || globs.length === 0) return true;
  return globs.some((glob) => {
    if (glob === "*") return true;
    if (glob.startsWith("*.")) return relativePath.endsWith(glob.slice(1));
    return relativePath.includes(glob.replaceAll("*", ""));
  });
}

async function runGit(
  cwd: string,
  args: string[],
  timeoutMs: number,
  maxStdoutBytes: number
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: maxStdoutBytes + 64 * 1024,
      encoding: "utf8"
    });
    return truncateGitOutput(stdout, stderr, 0, maxStdoutBytes);
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    if (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
      fail("GIT_TIMEOUT", "Git command timed out");
    }
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return truncateGitOutput(String(err.stdout ?? ""), String(err.stderr ?? ""), 0, maxStdoutBytes);
    }
    return truncateGitOutput(String(err.stdout ?? ""), String(err.stderr ?? err.message ?? ""), numericExitCode(err.code), maxStdoutBytes);
  }
}

function truncateGitOutput(stdout: string, stderr: string, exitCode: number, maxStdoutBytes: number) {
  const encoded = Buffer.from(stdout, "utf8");
  if (encoded.byteLength <= maxStdoutBytes) {
    return { stdout, stderr, exitCode, truncated: false };
  }
  return {
    stdout: encoded.subarray(0, maxStdoutBytes).toString("utf8"),
    stderr,
    exitCode,
    truncated: true
  };
}

function numericExitCode(code: number | string | undefined): number {
  return typeof code === "number" ? code : 1;
}

function isNotGitRepository(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return normalized.includes("not a git repository") ||
    normalized.includes("not in a git directory") ||
    normalized.includes("不是 git 仓库");
}

function trimError(value: string): string {
  return value.trim().slice(0, 1000);
}

function parsePorcelainV2Status(stdout: string, maxFiles: number) {
  const files: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged";
    staged: boolean;
    unstaged: boolean;
    oldPath?: string;
  }> = [];
  let branch: string | undefined;
  let head: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  let truncated = false;

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# ")) {
      const branchInfo = parseBranchLine(line);
      branch = branchInfo.branch ?? branch;
      head = branchInfo.head ?? head;
      upstream = branchInfo.upstream ?? upstream;
      ahead = branchInfo.ahead ?? ahead;
      behind = branchInfo.behind ?? behind;
      continue;
    }

    const change = parseStatusLine(line);
    if (!change) continue;
    if (files.length >= maxFiles) {
      truncated = true;
      continue;
    }
    files.push(change);
  }

  return { branch, head, upstream, ahead, behind, files, truncated };
}

function parseBranchLine(line: string): {
  branch?: string;
  head?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
} {
  if (line.startsWith("# branch.oid ")) return { head: line.slice("# branch.oid ".length) };
  if (line.startsWith("# branch.head ")) {
    const value = line.slice("# branch.head ".length);
    return value === "(detached)" ? {} : { branch: value };
  }
  if (line.startsWith("# branch.upstream ")) return { upstream: line.slice("# branch.upstream ".length) };
  if (line.startsWith("# branch.ab ")) {
    const match = /^\# branch\.ab \+(\d+) -(\d+)$/.exec(line);
    return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : {};
  }
  return {};
}

function parseStatusLine(line: string): {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged";
  staged: boolean;
  unstaged: boolean;
  oldPath?: string;
} | undefined {
  if (line.startsWith("? ")) {
    return { path: line.slice(2), status: "untracked", staged: false, unstaged: true };
  }
  if (line.startsWith("u ")) {
    const parts = line.split(" ");
    return { path: parts.slice(10).join(" "), status: "unmerged", staged: true, unstaged: true };
  }
  if (line.startsWith("1 ")) {
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    return {
      path: parts.slice(8).join(" "),
      status: statusFromCodes(xy),
      staged: xy[0] !== ".",
      unstaged: xy[1] !== "."
    };
  }
  if (line.startsWith("2 ")) {
    const parts = line.split(" ");
    const xy = parts[1] ?? "..";
    const pathPart = parts.slice(9).join(" ");
    const [pathValue, oldPath] = pathPart.split("\t");
    if (!pathValue) return undefined;
    return {
      path: pathValue,
      ...(oldPath ? { oldPath } : {}),
      status: xy[0] === "C" ? "copied" : "renamed",
      staged: true,
      unstaged: xy[1] !== "."
    };
  }
  return undefined;
}

function statusFromCodes(xy: string): "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unmerged" {
  if (xy.includes("A")) return "added";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("C")) return "copied";
  return "modified";
}
