import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { resolveProjectContext, type ProjectContext } from "../core/project/context.js";

export interface InitRecommendation {
  profile: ProjectContext["recommendedProfile"];
  bin: string;
  serverName: string;
  config: {
    mcpServers: Record<
      string,
      {
        command: string;
        args: string[];
      }
    >;
  };
  notes: string[];
}

function binInfo(profile: ProjectContext["recommendedProfile"]): { file: string; serverName: string } {
  switch (profile) {
    case "class2":
      return { file: "class2.js", serverName: "lasal-class2" };
    case "visu":
      return { file: "visu.js", serverName: "lasal-visu" };
    case "screen":
      return { file: "screen.js", serverName: "lasal-screen" };
    case "solution":
      return { file: "solution.js", serverName: "lasal-solution" };
  }
}

function serverBinPath(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled: dist/cli -> dist/servers. Unit tests import src/cli directly.
  const serversDir =
    basename(dirname(here)) === "src" ? resolve(here, "..", "..", "dist", "servers") : resolve(here, "..", "servers");
  return resolve(serversDir, file);
}

export function buildInitRecommendation(context: ProjectContext): InitRecommendation {
  const info = binInfo(context.recommendedProfile);
  const bin = serverBinPath(info.file);
  const notes: string[] = [];
  if (context.recommendedProfile === "class2" || context.recommendedProfile === "screen") {
    notes.push("Add the lasal-lars-mcp server when you want local LARS simulation.");
  }
  if (context.recommendedProfile === "solution") {
    notes.push("The solution profile includes CLASS 2, VISU, SCREEN, LARS and deploy actions.");
  }
  notes.push("Destructive and deploy actions are disabled by default; add --allow-destructive when needed.");

  return {
    profile: context.recommendedProfile,
    bin,
    serverName: info.serverName,
    config: {
      mcpServers: {
        [info.serverName]: {
          command: "node",
          args: [bin, "--project", context.root],
        },
      },
    },
    notes,
  };
}

export function renderInitRecommendation(context: ProjectContext, recommendation: InitRecommendation): string {
  const capabilityBits = [
    `class2=${context.capabilities.class2}`,
    `visu=${context.capabilities.visu}`,
    `screen=${context.capabilities.screen}`,
    `machineManager=${context.capabilities.machineManager}`,
  ].join(", ");
  return [
    `Project: ${context.root}`,
    `Project ID: ${context.id}`,
    `Stations: ${context.stations.length}`,
    `Capabilities: ${capabilityBits}`,
    `Recommended profile: ${recommendation.profile}`,
    "",
    "MCP client config:",
    "```json",
    JSON.stringify(recommendation.config, null, 2),
    "```",
    "",
    "Notes:",
    ...recommendation.notes.map((note) => `- ${note}`),
  ].join("\n");
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function main(): void {
  const projectArg =
    argValue("--project") ?? process.argv.slice(2).find((arg) => !arg.startsWith("--") && arg !== argValue("--write"));
  if (!projectArg) {
    process.stderr.write(
      "Usage: lasal-mcp-init --project <solution-dir> [--write <mcp-config.json>] [--force] [--json]\n",
    );
    process.exit(2);
  }

  const context = resolveProjectContext(projectArg);
  if ("error" in context) {
    process.stderr.write(`${context.error}\n`);
    process.exit(2);
  }

  const recommendation = buildInitRecommendation(context);
  const json = process.argv.includes("--json");
  const writePath = argValue("--write");
  if (writePath) {
    const target = resolve(writePath);
    if (existsSync(target) && !process.argv.includes("--force")) {
      process.stderr.write(`Refusing to overwrite ${target} without --force.\n`);
      process.exit(1);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(recommendation.config, null, 2)}\n`, "utf-8");
    process.stdout.write(`Wrote MCP config to ${target}\n`);
    if (!json) process.stdout.write(`\n${renderInitRecommendation(context, recommendation)}\n`);
    return;
  }

  process.stdout.write(
    json
      ? `${JSON.stringify(recommendation.config, null, 2)}\n`
      : `${renderInitRecommendation(context, recommendation)}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
