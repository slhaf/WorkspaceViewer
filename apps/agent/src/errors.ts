import { workspaceError, type WorkspaceToolError } from "@workspace-viewer/protocol";

export class WorkspaceToolException extends Error {
  readonly toolError: WorkspaceToolError;

  constructor(error: WorkspaceToolError) {
    super(error.message);
    this.toolError = error;
  }
}

export function fail(code: WorkspaceToolError["code"], message: string, details?: Record<string, unknown>): never {
  throw new WorkspaceToolException(workspaceError(code, message, details));
}

export function toWorkspaceError(error: unknown): WorkspaceToolError {
  if (error instanceof WorkspaceToolException) {
    return error.toolError;
  }
  if (error instanceof Error) {
    return workspaceError("INTERNAL_ERROR", error.message);
  }
  return workspaceError("INTERNAL_ERROR", "Unknown internal error");
}
