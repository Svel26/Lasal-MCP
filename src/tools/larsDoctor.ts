import { existsSync, statSync } from "fs";
import type { LarsInstanceInfo } from "../state.js";
import { readState } from "../state.js";
import {
  DEFAULT_ONLINE_PORT,
  LARS_EXE,
  getLarsPids,
  getLarsVersion,
  isLarsHealthy,
  larsConfigPath,
  parseLarsConfig,
  readLarsConfigRaw,
  readLarsWorkspaces,
  validateLarsWorkspaces,
  type LarsWorkspace,
} from "../utils/lars.js";
import { isPidRunning } from "../core/process.js";
import type { ActionResult } from "../core/actions/types.js";

export interface LarsDoctorReport {
  healthy: boolean;
  larsExe: { path: string; exists: boolean; version: string | null };
  config: {
    path: string;
    exists: boolean;
    size?: number;
    configVersion?: string;
    workspaceCount?: number;
    unknownElements?: Array<{ workspace: string; element: string }>;
  };
  workspaces: Array<{
    name: string;
    onlinePort: number;
    effectiveOnlinePort?: number;
    effectiveDiffersFromConfigured: boolean;
    dataRoot?: string;
    screenProjectPath?: string;
    driveMaps: Array<{ drive: string; path: string }>;
    running: boolean;
    healthy?: boolean;
    pid?: number;
  }>;
  compatibility: {
    larsVersion: string | null;
    multiInstanceSupported: "yes" | "no" | "unknown";
    note: string;
  };
  instances: Record<string, LarsInstanceInfo>;
  issues: string[];
}

/**
 * Pure diagnostics over workspace config + MCP runtime state. Warnings that do
 * not block a write (such as a screen project missing on this workstation) are
 * included so `lars.doctor` stays a single actionable list.
 */
export function diagnoseLarsWorkspaces(
  workspaces: LarsWorkspace[],
  instances: Record<string, LarsInstanceInfo>,
  options: { larsExists: boolean; configExists: boolean },
): string[] {
  const issues: string[] = [];
  if (!options.larsExists) issues.push(`LARS executable not found at ${LARS_EXE}. Set LASAL_LARS_EXE.`);
  if (!options.configExists) issues.push(`LARS config not found at ${larsConfigPath()}.`);

  const validation = validateLarsWorkspaces(workspaces);
  issues.push(...validation.errors, ...validation.warnings);

  for (const [name, instance] of Object.entries(instances)) {
    const workspace = workspaces.find((candidate) => candidate.name === name);
    if (!workspace) issues.push(`Runtime instance '${name}' has no matching workspace config.`);
    if (instance.pid && !isPidRunning(instance.pid)) {
      issues.push(`Runtime instance '${name}' records PID ${instance.pid}, which is not running.`);
    }
  }

  return [...new Set(issues)];
}

function compatibility(larsVersion: string | null): LarsDoctorReport["compatibility"] {
  if (!larsVersion) {
    return {
      larsVersion,
      multiInstanceSupported: "unknown",
      note: "LARS version could not be read. The server probes configured and default online ports at start.",
    };
  }
  if (/^01\.03\.216/.test(larsVersion)) {
    return {
      larsVersion,
      multiInstanceSupported: "no",
      note: "Field-tested build 01.03.216 ignores the workspace ONLINE table: one instance binds 1954 and a second exposes no online port. Use an older build for multi-station simulation.",
    };
  }
  if (/^01\.03\.(?:21[0-5]|20\d|19\d|18\d)/.test(larsVersion)) {
    return {
      larsVersion,
      multiInstanceSupported: "yes",
      note: "This build family honours the workspace ONLINE port (01.03.213 verified). Multi-instance simulation is expected to work.",
    };
  }
  return {
    larsVersion,
    multiInstanceSupported: "unknown",
    note: "No compatibility record for this build. Run `lars.doctor` while instances are running to compare configured and effective ports.",
  };
}

export async function larsDoctorHandler(): Promise<ActionResult> {
  const configPath = larsConfigPath();
  const raw = readLarsConfigRaw();
  const configExists = raw !== undefined;
  let size: number | undefined;
  if (configExists) {
    try {
      size = statSync(configPath).size;
    } catch {
      /* best-effort */
    }
  }

  const parsed = raw !== undefined ? parseLarsConfig(raw) : undefined;
  const workspaces = readLarsWorkspaces();
  const instances = readState().larsInstances ?? {};
  const issues = diagnoseLarsWorkspaces(workspaces, instances, {
    larsExists: existsSync(LARS_EXE),
    configExists,
  });

  if (parsed && !parsed.ok) issues.push(parsed.error);
  if (parsed?.ok) {
    if (parsed.config.unnamedWorkspaceBlocks > 0) {
      issues.push(`${parsed.config.unnamedWorkspaceBlocks} WORKSPACE block(s) have no Name attribute.`);
    }
    if (parsed.config.configVersion && parsed.config.configVersion !== "2") {
      issues.push(`LARS config version is '${parsed.config.configVersion}', expected '2'.`);
    }
    for (const unknown of parsed.config.unknownElements) {
      issues.push(
        `Workspace '${unknown.workspace}' has unmodeled config element '${unknown.element}' (preserved on write).`,
      );
    }
  }

  const workspaceReports = await Promise.all(
    workspaces.map(async (workspace) => {
      const pids = getLarsPids(workspace.name);
      const running = pids.length > 0;
      const instance = instances[workspace.name];
      const effective = instance?.effectiveOnlinePort;
      let healthy = running ? await isLarsHealthy(effective ?? workspace.onlinePort) : undefined;
      if (running && healthy === false && effective === undefined && workspace.onlinePort !== DEFAULT_ONLINE_PORT) {
        healthy = await isLarsHealthy(DEFAULT_ONLINE_PORT);
      }
      return {
        name: workspace.name,
        onlinePort: workspace.onlinePort,
        ...(effective !== undefined ? { effectiveOnlinePort: effective } : {}),
        effectiveDiffersFromConfigured: effective !== undefined && effective !== workspace.onlinePort,
        ...(workspace.dataRoot ? { dataRoot: workspace.dataRoot } : {}),
        ...(workspace.screenProjectPath ? { screenProjectPath: workspace.screenProjectPath } : {}),
        driveMaps: workspace.driveMaps ?? [],
        running,
        ...(healthy !== undefined ? { healthy } : {}),
        ...((pids[0] ?? instance?.pid) ? { pid: pids[0] ?? instance?.pid } : {}),
      };
    }),
  );

  const larsVersion = getLarsVersion();
  const compatibilityReport = compatibility(larsVersion);
  if (workspaceReports.some((workspace) => workspace.running && workspace.effectiveDiffersFromConfigured)) {
    issues.push(
      "At least one running instance serves a different online port than configured (effective vs configured shown above).",
    );
  }

  const uniqueIssues = [...new Set(issues)];
  return {
    ok: true,
    data: {
      healthy: uniqueIssues.length === 0,
      larsExe: { path: LARS_EXE, exists: existsSync(LARS_EXE), version: larsVersion },
      config: {
        path: configPath,
        exists: configExists,
        ...(size !== undefined ? { size } : {}),
        ...(parsed?.ok
          ? {
              configVersion: parsed.config.configVersion ?? "2",
              workspaceCount: parsed.config.workspaces.length,
              unknownElements: parsed.config.unknownElements,
            }
          : {}),
      },
      workspaces: workspaceReports,
      compatibility: compatibilityReport,
      instances,
      issues: uniqueIssues,
    },
    ...(uniqueIssues.length ? { warnings: uniqueIssues } : {}),
  };
}
