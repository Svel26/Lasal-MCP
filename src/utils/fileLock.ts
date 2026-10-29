import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isPidAlive } from "./pid.js";

/**
 * Cross-process file lock.
 *
 * The MCP server is spawned once per agent session, so an in-process mutex is
 * not enough: two agents can run engine operations or edit `lasal-state.json`
 * at the same time. Locks are directories (mkdir is atomic on every platform)
 * containing an `owner.json` so a crashed holder can be detected and bypassed.
 */

export interface FileLockOptions {
  /** Give up after this long. Default 15 s for state writes, callers may raise it. */
  timeoutMs?: number;
  /** A live holder older than this is considered hung. Default 6 h. */
  staleMs?: number;
  /** Free-form description shown in timeout errors. */
  label?: string;
}

interface LockOwner {
  pid: number;
  startedAt: number;
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;

// Atomics.wait gives a synchronous sleep in Node without burning the CPU.
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf-8")) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return { pid: parsed.pid, startedAt: parsed.startedAt, ...(parsed.label ? { label: parsed.label } : {}) };
    }
  } catch {
    // Owner file missing (lock being created) or unreadable.
  }
  return undefined;
}

function isStale(lockPath: string, owner: LockOwner | undefined, staleMs: number): boolean {
  if (owner) {
    if (!isPidAlive(owner.pid)) return true;
    return Date.now() - owner.startedAt > staleMs;
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function tryAcquire(lockPath: string, label?: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    const owner: LockOwner = { pid: process.pid, startedAt: Date.now(), ...(label ? { label } : {}) };
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify(owner), "utf-8");
  } catch {
    // Metadata is best-effort; the directory itself is the lock.
  }
  return true;
}

function timeoutError(lockPath: string, owner: LockOwner | undefined, timeoutMs: number): Error {
  const held = owner ? ` (held by PID ${owner.pid}${owner.label ? `, ${owner.label}` : ""})` : "";
  return new Error(`Timed out after ${timeoutMs} ms waiting for lock ${lockPath}${held}`);
}

/** Acquire a lock synchronously. Returns a release function. */
export function acquireFileLockSync(lockPath: string, opts: FileLockOptions = {}): () => void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const started = Date.now();

  for (;;) {
    if (tryAcquire(lockPath, opts.label)) break;
    const owner = readOwner(lockPath);
    if (isStale(lockPath, owner, staleMs)) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* another process may have removed it already */
      }
      continue;
    }
    if (Date.now() - started >= timeoutMs) throw timeoutError(lockPath, owner, timeoutMs);
    sleepSync(20 + Math.floor(Math.random() * 30));
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
}

/** Run `fn` while holding a cross-process lock. */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const release = acquireFileLockSync(lockPath, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

/** Async variant for long-running engine operations. Returns a release function. */
export async function acquireFileLock(lockPath: string, opts: FileLockOptions = {}): Promise<() => void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const started = Date.now();

  for (;;) {
    if (tryAcquire(lockPath, opts.label)) break;
    const owner = readOwner(lockPath);
    if (isStale(lockPath, owner, staleMs)) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      continue;
    }
    if (Date.now() - started >= timeoutMs) throw timeoutError(lockPath, owner, timeoutMs);
    await sleep(25 + Math.floor(Math.random() * 50));
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };
}
