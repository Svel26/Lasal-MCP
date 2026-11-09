import { existsSync, statSync } from "fs";
import { isAbsolute, parse as parsePath, resolve } from "path";
import type { LarsInstanceInfo } from "../state.js";
import { readState } from "../state.js";
import { LARS_EXE, larsConfigPath, readLarsWorkspaces, type LarsWorkspace } from "../utils/lars.js";
import { isPidRunning } from "../core/process.js";
import type { ActionResult } from "../core/actions/types.js";

export interface LarsDoctorReport {
  healthy: boolean;
  larsExe: { path: string; exists: boolean };
  config: { path: string; exists: boolean; size?: number };
  workspaces: Array<{
    name: string;
    onlinePort: number;
    effectiveOnlinePort?: number;
    dataRoot?: string;
    screenProjectPath?: string;
    driveMaps: Array<{ drive: string; path: string }>;
    running: boolean;
    pid?: number;
  }>;
  instances: Record<string, LarsInstanceInfo>;
  issues: string[];
}

function configuredPorts(workspace: LarsWorkspace): Array<[string, number]> {
  return [
    ["onlinePort", workspace.onlinePort],
    ["comlinkServerPort", workspace.comlinkServerPort],
    ["comlinkBasePort", workspace.comlinkBasePort],
    ["alarmPort", workspace.alarmPort],
    ...(workspace.dataServiceTcpPort
      ? ([["dataServiceTcpPort", workspace.dataServiceTcpPort]] as Array<[string, number]>)
      : []),
  ];
}

/** Pure diagnostics over workspace config + MCP runtime state. */
export function diagnoseLarsWorkspaces(
  workspaces: LarsWorkspace[],
  instances: Record<string, LarsInstanceInfo>,
  options: { larsExists: boolean; configExists: boolean },
): string[] {
  const issues: string[] = [];
  if (!options.larsExists) issues.push(`LARS executable not found at ${LARS_EXE}. Set LASAL_LARS_EXE.`);
  if (!options.configExists) issues.push(`LARS config not found at ${larsConfigPath()}.`);

  const portOwners = new Map<number, string>();
  const rootOwners = new Map<string, string>();
  for (const workspace of workspaces) {
    for (const [label, port] of configuredPorts(workspace)) {
      const owner = portOwners.get(port);
      if (owner) issues.push(`Port ${port} (${label}) is used by both '${owner}' and '${workspace.name}'.`);
      else portOwners.set(port, workspace.name);
    }
    if (workspace.dataRoot) {
      const key = resolve(workspace.dataRoot).toLowerCase();
      const owner = rootOwners.get(key);
      if (owner) issues.push(`dataRoot '${workspace.dataRoot}' is shared by '${owner}' and '${workspace.name}'.`);
      else rootOwners.set(key, workspace.name);
      if (!isAbsolute(workspace.dataRoot)) issues.push(`Workspace '${workspace.name}': dataRoot is not absolute.`);
      else if (
        resolve(workspace.dataRoot).toLowerCase() === parsePath(resolve(workspace.dataRoot)).root.toLowerCase()
      ) {
        issues.push(`Workspace '${workspace.name}': dataRoot is a host drive root.`);
      }
    } else {
      issues.push(`Workspace '${workspace.name}': no isolated dataRoot configured.`);
    }
    if (workspace.screenProjectPath && !existsSync(workspace.screenProjectPath)) {
      issues.push(`Workspace '${workspace.name}': screen project not found: ${workspace.screenProjectPath}`);
    }
  }

  for (const [name, instance] of Object.entries(instances)) {
    const workspace = workspaces.find((candidate) => candidate.name === name);
    if (!workspace) issues.push(`Runtime instance '${name}' has no matching workspace config.`);
    if (instance.pid && !isPidRunning(instance.pid)) {
      issues.push(`Runtime instance '${name}' records PID ${instance.pid}, which is not running.`);
    }
  }

  return issues;
}

export async function larsDoctorHandler(): Promise<ActionResult> {
  const configPath = larsConfigPath();
  const configExists = existsSync(configPath);
  let size: number | undefined;
  if (configExists) {
    try {
      size = statSync(configPath).size;
    } catch {
      /* best-effort */
    }
  }

  const workspaces = readLarsWorkspaces();
  const instances = readState().larsInstances ?? {};
  const issues = diagnoseLarsWorkspaces(workspaces, instances, {
    larsExists: existsSync(LARS_EXE),
    configExists,
  });

  return {
    ok: true,
    data: {
      healthy: issues.length === 0,
      larsExe: { path: LARS_EXE, exists: existsSync(LARS_EXE) },
      config: { path: configPath, exists: configExists, ...(size !== undefined ? { size } : {}) },
      workspaces: workspaces.map((workspace) => {
        const instance = instances[workspace.name];
        return {
          name: workspace.name,
          onlinePort: workspace.onlinePort,
          ...(instance?.effectiveOnlinePort ? { effectiveOnlinePort: instance.effectiveOnlinePort } : {}),
          ...(workspace.dataRoot ? { dataRoot: workspace.dataRoot } : {}),
          ...(workspace.screenProjectPath ? { screenProjectPath: workspace.screenProjectPath } : {}),
          driveMaps: workspace.driveMaps ?? [],
          running: Boolean(instance?.pid && isPidRunning(instance.pid)),
          ...(instance?.pid ? { pid: instance.pid } : {}),
        };
      }),
      instances,
      issues,
    },
    ...(issues.length ? { warnings: issues } : {}),
  };
}
