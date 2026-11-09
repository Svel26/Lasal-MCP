import { statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { acquireFileLock } from "../../utils/fileLock.js";

export interface FileStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

export class FileChangedError extends Error {
  readonly path: string;

  constructor(stamp: FileStamp, current: FileStamp | null) {
    super(
      `File changed since it was read: ${stamp.path}` +
        (current
          ? ` (expected mtime=${stamp.mtimeMs}/size=${stamp.size}, got mtime=${current.mtimeMs}/size=${current.size})`
          : " (file no longer exists)"),
    );
    this.name = "FileChangedError";
    this.path = stamp.path;
  }
}

function lockRoot(): string {
  return process.env.LASAL_MCP_LOCK_DIR || join(tmpdir(), "lasal-mcp", "locks");
}

export function projectLockPath(projectId: string): string {
  return join(lockRoot(), `project-${projectId}.lock`);
}

/**
 * Serialize mutating actions for one project across all MCP server processes.
 *
 * A project lock is held while an action runs and is released on completion.
 * Read-only actions do not take it. The lock is separate from the engine lock:
 * it prevents two agents from editing the same project concurrently, while the
 * engine lock protects the vendor executable.
 */
export async function withProjectWriteLock<T>(
  projectId: string,
  actionId: string,
  fn: () => Promise<T>,
  timeoutMs = 30 * 60 * 1000,
): Promise<T> {
  const release = await acquireFileLock(projectLockPath(projectId), {
    timeoutMs,
    staleMs: 30 * 60 * 1000,
    label: `project=${projectId} action=${actionId}`,
  });
  try {
    return await fn();
  } finally {
    release();
  }
}

export function stampFile(path: string): FileStamp {
  const stat = statSync(path);
  return { path, mtimeMs: stat.mtimeMs, size: stat.size };
}

export function currentStamp(path: string): FileStamp | null {
  try {
    return stampFile(path);
  } catch {
    return null;
  }
}

/** Optimistic concurrency guard for a file that is about to be rewritten. */
export function assertUnchanged(stamp: FileStamp): void {
  const current = currentStamp(stamp.path);
  if (!current || current.mtimeMs !== stamp.mtimeMs || current.size !== stamp.size) {
    throw new FileChangedError(stamp, current);
  }
}
