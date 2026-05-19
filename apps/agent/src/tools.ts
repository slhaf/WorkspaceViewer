import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  LIMITS,
  type AgentToolName,
  batchExecInputSchema,
  describeWorkspaceInputSchema,
  inspectFileInputSchema,
  listTreeInputSchema,
  searchFileInputSchema,
  workspaceError
} from "@workspace-viewer/protocol";
import type { AgentConfig, WorkspaceConfig } from "./config.js";
import { fail, toWorkspaceError } from "./errors.js";
import { isIgnored, normalizeRelative, resolveWorkspacePath, safeLstat } from "./pathGuard.js";
import { countLines, detectLanguage, fileSize, isProbablyBinary, jsonByteLength } from "./utils.js";

type ToolResult = unknown;

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
