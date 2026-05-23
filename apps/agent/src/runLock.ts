import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

interface RunLockFile {
  pid: number;
  configPath: string;
  createdAt: string;
}

export interface AgentRunLock {
  path: string;
  release(): Promise<void>;
}

export async function acquireAgentRunLock(configPath: string): Promise<AgentRunLock> {
  const resolvedConfigPath = path.resolve(configPath);
  const lockPath = `${resolvedConfigPath}.run.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await writeLock(handle, lockPath, resolvedConfigPath);
      return {
        path: lockPath,
        release: () => releaseLock(handle, lockPath)
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (await isExistingLockActive(lockPath)) {
        throw new Error(`Workspace Viewer Agent is already running for config: ${resolvedConfigPath}`);
      }
      await unlink(lockPath).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== "ENOENT") throw unlinkError;
      });
    }
  }

  throw new Error(`Unable to acquire Agent run lock: ${lockPath}`);
}

async function writeLock(handle: FileHandle, lockPath: string, configPath: string): Promise<void> {
  const payload: RunLockFile = {
    pid: process.pid,
    configPath,
    createdAt: new Date().toISOString()
  };
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (error) {
    await releaseLock(handle, lockPath).catch(() => undefined);
    throw error;
  }
}

async function releaseLock(handle: FileHandle, lockPath: string): Promise<void> {
  await handle.close().catch(() => undefined);
  await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function isExistingLockActive(lockPath: string): Promise<boolean> {
  const lock = await readLock(lockPath);
  return Boolean(lock && Number.isInteger(lock.pid) && lock.pid > 0 && isProcessAlive(lock.pid));
}

async function readLock(lockPath: string): Promise<RunLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<RunLockFile>;
    return typeof parsed.pid === "number" && typeof parsed.configPath === "string"
      ? {
          pid: parsed.pid,
          configPath: parsed.configPath,
          createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}
