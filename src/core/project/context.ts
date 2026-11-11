import { createHash } from "crypto";
import { existsSync, realpathSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { getCurrentProject } from "../../state.js";
import type { StationInfo } from "../../utils/projectScanner.js";
import { detectProjectShape, type ProjectCapabilities, type RecommendedProfile } from "./capabilities.js";

/**
 * Minimal project context for the action-catalog layer.
 *
 * Phase 2 will add a project registry and lock ownership. The important
 * property already established here is that a project is identified by a
 * stable hash of its canonical path, not by its display name.
 */
export interface ProjectContext {
  id: string;
  root: string;
  lsmPath?: string;
  stations: StationInfo[];
  capabilities: ProjectCapabilities;
  recommendedProfile: RecommendedProfile;
}

const CONTEXT_CACHE_TTL_MS = 2000;
const contextCache = new Map<string, { at: number; context: ProjectContext }>();

/** Force a fresh capability/station scan on the next call. */
export function clearProjectContextCache(root?: string): void {
  if (!root) {
    contextCache.clear();
    return;
  }
  contextCache.delete(canonicalProjectRoot(root));
}

function stripTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

/** Canonicalise a project path (directory or a file inside the project). */
export function canonicalProjectRoot(input: string): string {
  const absolute = resolve(input);
  let root = absolute;
  try {
    if (!statSync(absolute).isDirectory()) {
      root = dirname(absolute);
    }
  } catch {
    // Keep the supplied path; resolveProjectContext will report it as missing.
  }
  try {
    root = realpathSync.native(root);
  } catch {
    // Fall back to the absolute path when the path does not exist yet.
  }
  return stripTrailingSeparators(root);
}

/** Stable, process-independent project identifier. */
export function projectIdFor(root: string): string {
  return createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 12);
}

export function resolveProjectContext(projectRef?: string): ProjectContext | { error: string } {
  const ref = projectRef ?? getCurrentProject();
  if (!ref) {
    return { error: "No project selected. Call select_project first or pass project." };
  }

  const root = canonicalProjectRoot(ref);
  if (!existsSync(root)) {
    return { error: `Project path not found: ${root}` };
  }

  const cached = contextCache.get(root);
  if (cached && Date.now() - cached.at < CONTEXT_CACHE_TTL_MS) {
    return cached.context;
  }

  const shape = detectProjectShape(root);
  const context: ProjectContext = {
    id: projectIdFor(root),
    root,
    ...shape,
  };
  contextCache.set(root, { at: Date.now(), context });
  return context;
}

export function currentProjectContext(): ProjectContext | null {
  const resolved = resolveProjectContext();
  return "error" in resolved ? null : resolved;
}
