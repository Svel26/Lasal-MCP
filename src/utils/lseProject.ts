import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";

// ─── LASAL Screen project helpers ────────────────────────────────────────────
//
// `.lpr` projects are binary containers (screens `.lsn`, windows `.lwn`, data
// pools `.lse`) — never edit them by hand; use the `lse_project` tool (COM
// automation) or the editor. Only these plain-XML/text sidecars are safe to edit:
//   - `LSEOnlineConfig.xml` (per project folder) — online/download target, the
//     same <TCPIP .../> schema used in station `.lss` files.

const TCPIP_ATTR_RE = (name: string) => new RegExp(`(\\b${name}\\s*=\\s*")[^"]*(")`);

function setAttr(tag: string, name: string, value: string): string {
  const re = TCPIP_ATTR_RE(name);
  if (re.test(tag)) return tag.replace(re, `$1${value}$2`);
  // Attribute not present — insert before the closing >
  return tag.replace(/(\/?>)$/, ` ${name}="${value}"$1`);
}

/** Locate the `LSEOnlineConfig.xml` next to a `.lpr` (exact name first, then case-insensitive scan). */
export function findLseOnlineConfig(lprPath: string): string | null {
  const dir = dirname(lprPath);
  const exact = join(dir, "LSEOnlineConfig.xml");
  if (existsSync(exact)) return exact;
  try {
    for (const f of readdirSync(dir)) {
      if (f.toLowerCase().endsWith("onlineconfig.xml")) return join(dir, f);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Read the first <TCPIP .../> target from an LSEOnlineConfig.xml. */
export function readLseOnlineConfigTarget(cfgPath: string): { ip: string; port: string } | { error: string } {
  if (!existsSync(cfgPath)) return { error: `LSE online config not found: ${cfgPath}` };
  try {
    const content = readFileSync(cfgPath, "latin1");
    const m = content.match(/<TCPIP\s[^>]*?IP="([^"]*)"[^>]*?PORT="([^"]*)"/);
    if (m?.[1] && m[2] !== undefined) return { ip: m[1], port: m[2] || "1954" };
    const m2 = content.match(/<TCPIP\s[^>]*?IP="([^"]*)"/);
    if (m2?.[1]) return { ip: m2[1], port: "1954" };
    return { error: `No <TCPIP .../> element found in ${cfgPath}` };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Failed to parse ${cfgPath}: ${msg}` };
  }
}

/**
 * Surgically update every <TCPIP .../> element of an LSEOnlineConfig.xml
 * (IP/PORT/SSLTLS), byte-preserving the rest of the file. latin1 like the
 * other LASAL config files.
 */
export function updateLseOnlineConfig(cfgPath: string, updates: { ip?: string; port?: string; ssltls?: string }): void {
  let content = readFileSync(cfgPath, "latin1");
  if (!/<TCPIP\s/.test(content)) {
    throw new Error(`No <TCPIP .../> element found in ${cfgPath}`);
  }
  content = content.replace(/<TCPIP\s[^>]*\/?>/g, (tag) => {
    let t = tag;
    if (updates.ip !== undefined) t = setAttr(t, "IP", updates.ip);
    if (updates.port !== undefined) t = setAttr(t, "PORT", updates.port);
    if (updates.ssltls !== undefined) t = setAttr(t, "SSLTLS", updates.ssltls);
    return t;
  });
  writeFileSync(cfgPath, content, "latin1");
}

// ─── Compiled runtime output ──────────────────────────────────────────────────

export interface LseRuntimeInfo {
  runtimeDir: string;
  exists: boolean;
  fileCount: number;
  lastModifiedMs: number;
}

/**
 * Inspect the compiled LSE output folder. `IProject::Compile` (and LSE's
 * Build > Rebuild All) writes the deployable runtime into `<lpr dir>\Runtime`.
 * MachineManager's DwnLdLSE accepts either the `.lpr` or this folder.
 */
export function lseRuntimeInfo(lprPath: string): LseRuntimeInfo {
  const runtimeDir = join(dirname(lprPath), "Runtime");
  let fileCount = 0;
  let lastModifiedMs = 0;
  const walk = (d: string): void => {
    let entries: Array<{ name: string; isDir: boolean }> = [];
    try {
      entries = readdirSync(d, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDir) {
        walk(full);
      } else {
        fileCount += 1;
        try {
          const st = statSync(full);
          if (st.mtimeMs > lastModifiedMs) lastModifiedMs = st.mtimeMs;
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (existsSync(runtimeDir)) walk(runtimeDir);
  return { runtimeDir, exists: existsSync(runtimeDir), fileCount, lastModifiedMs };
}
