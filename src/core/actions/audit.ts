import { appendFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

const SENSITIVE_KEY = /password|passwd|secret|token|api[_-]?key|credential/i;

function auditFilePath(): string {
  if (process.env.LASAL_MCP_AUDIT_FILE) return process.env.LASAL_MCP_AUDIT_FILE;
  const base = process.env.LOCALAPPDATA || tmpdir();
  return join(base, "lasal-mcp", "audit.jsonl");
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(entry, depth + 1);
    }
    return result;
  }
  return value;
}

/** Best-effort JSONL audit record. Never let auditing break an action. */
export function writeAudit(record: Record<string, unknown>): void {
  try {
    const file = auditFilePath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        ...record,
      })}\n`,
      "utf8",
    );
  } catch {
    // Auditing is best-effort and must never mask the actual action result.
  }
}

export function auditParams(params: unknown): unknown {
  return redact(params);
}
