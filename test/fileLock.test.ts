import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { acquireFileLockSync, withFileLockSync } from "../src/utils/fileLock.js";

describe("fileLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lasal-mcp-lock-"));
    lockPath = join(dir, "test.lock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates and removes the lock directory", () => {
    let seenInside = false;
    withFileLockSync(lockPath, () => {
      seenInside = existsSync(lockPath);
      expect(JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf-8")).pid).toBe(process.pid);
    });
    expect(seenInside).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock when the callback throws", () => {
    expect(() =>
      withFileLockSync(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("times out while another holder owns the lock", () => {
    const release = acquireFileLockSync(lockPath);
    try {
      expect(() => withFileLockSync(lockPath, () => undefined, { timeoutMs: 60 })).toThrow(/waiting for lock/);
    } finally {
      release();
    }
  });

  it("takes over a lock whose owner pid is dead", () => {
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 999_999, startedAt: Date.now(), label: "dead" }),
      "utf-8",
    );

    let ran = false;
    withFileLockSync(
      lockPath,
      () => {
        ran = true;
      },
      { timeoutMs: 1_000 },
    );
    expect(ran).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});
