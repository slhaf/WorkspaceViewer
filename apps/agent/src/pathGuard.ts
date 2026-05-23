import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceConfig } from "./config.js";
import { fail } from "./errors.js";

export const DEFAULT_IGNORE = [".git", ".idea", "target", "build", "node_modules", ".gradle"];

export interface ResolvedWorkspacePath {
  rootRealPath: string;
  absolutePath: string;
  realPath: string;
  relativePath: string;
}

export interface ResolvedGitPath {
  rootRealPath: string;
  absolutePath: string;
  relativePath: string;
}

export async function resolveWorkspacePath(
  workspace: WorkspaceConfig,
  userPath = "."
): Promise<ResolvedWorkspacePath> {
  if (path.isAbsolute(userPath)) {
    fail("PATH_OUTSIDE_WORKSPACE", "Absolute paths are not allowed");
  }

  const rootRealPath = await realpath(workspace.rootPath);
  const absolutePath = path.resolve(rootRealPath, userPath || ".");
  if (!isInside(rootRealPath, absolutePath)) {
    fail("PATH_OUTSIDE_WORKSPACE", "Path escapes workspace root");
  }

  let realTarget: string;
  try {
    realTarget = await realpath(absolutePath);
  } catch {
    fail("FILE_NOT_FOUND", "Path does not exist", { path: userPath });
  }
  if (!isInside(rootRealPath, realTarget)) {
    fail("PATH_OUTSIDE_WORKSPACE", "Resolved path escapes workspace root");
  }

  const relativePath = normalizeRelative(path.relative(rootRealPath, realTarget));
  if (isIgnored(workspace, relativePath)) {
    fail("PATH_IGNORED", "Path is ignored", { path: relativePath });
  }

  return { rootRealPath, absolutePath, realPath: realTarget, relativePath };
}

export async function normalizeUserRelativePathForGit(
  workspace: WorkspaceConfig,
  userPath: string
): Promise<ResolvedGitPath> {
  if (!userPath || userPath === ".") {
    fail("INVALID_PARAMS", "Git path must reference a workspace-relative file or directory");
  }
  if (path.isAbsolute(userPath)) {
    fail("PATH_OUTSIDE_WORKSPACE", "Absolute paths are not allowed");
  }

  const rootRealPath = await realpath(workspace.rootPath);
  const absolutePath = path.resolve(rootRealPath, userPath);
  if (!isInside(rootRealPath, absolutePath)) {
    fail("PATH_OUTSIDE_WORKSPACE", "Path escapes workspace root");
  }

  const relativePath = normalizeRelative(path.relative(rootRealPath, absolutePath));
  if (relativePath === "." || relativePath.startsWith("../")) {
    fail("PATH_OUTSIDE_WORKSPACE", "Path escapes workspace root");
  }
  if (isIgnored(workspace, relativePath)) {
    fail("PATH_IGNORED", "Path is ignored", { path: relativePath });
  }

  return { rootRealPath, absolutePath, relativePath };
}

export async function safeLstat(filePath: string) {
  return lstat(filePath);
}

export function normalizeRelative(value: string): string {
  return value === "" ? "." : value.split(path.sep).join("/");
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isIgnored(workspace: WorkspaceConfig, relativePath: string): boolean {
  const parts = relativePath.split("/").filter(Boolean);
  const ignore = [...DEFAULT_IGNORE, ...(workspace.ignore ?? [])];
  return ignore.some((pattern) => {
    const clean = pattern.replace(/^\/+|\/+$/g, "");
    return clean !== "" && (parts.includes(clean) || relativePath === clean || relativePath.startsWith(`${clean}/`));
  });
}
