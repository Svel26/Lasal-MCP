import { existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { z } from "zod";
import { resolveLvpPath } from "../utils/resolvePaths.js";

export const inspectVisuProjectSchema = {
  lvp_path: z
    .string()
    .optional()
    .describe("Full path to the .lvp file. Omit to auto-detect from the selected project."),
  all_datapoints: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Return the full flat list of all datapoint paths. Default false returns only top-level objects. " +
      "Use true when you need to see every channel (can be large for big projects)."
    ),
};

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function flattenDatapoints(
  nodes: any[],
  parentPath = ""
): Array<{ path: string; datatype: string }> {
  const result: Array<{ path: string; datatype: string }> = [];
  for (const node of nodes ?? []) {
    if (node.type !== "datapoint") continue;
    const path = parentPath ? `${parentPath}.${node.name}` : node.name;
    const datatype = node.datatype?.value ?? "?";
    result.push({ path, datatype });
    if (node.children?.length) {
      result.push(...flattenDatapoints(node.children, path));
    }
  }
  return result;
}

export async function inspectVisuProjectHandler(args: { lvp_path?: string; all_datapoints?: boolean }) {
  const resolved = resolveLvpPath(args.lvp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  const lvpPath = resolved.path;
  // The .lvp is a file whose parent dir is the project folder-database
  // e.g. .../VisuPalletizerLVD/VisuPalletizerLVD.lvp → project dir is .../VisuPalletizerLVD/
  const projectDir = dirname(lvpPath);

  const result: Record<string, unknown> = {
    lvpPath,
    projectName: basename(lvpPath, ".lvp"),
  };
  const errors: string[] = [];

  // ── Stations ─────────────────────────────────────────────────────────────
  const stationsFile = join(projectDir, "Stations", "Stations.json");
  if (existsSync(stationsFile)) {
    try {
      const data: any = readJson(stationsFile);
      result.stations = (data.stations ?? []).map((s: any) => ({
        name: s.name,
        connection: s.connection,
        importFilePath: s.importFilePath,
        isRequired: s.isRequired,
      }));
    } catch (e: any) {
      errors.push(`stations: ${e.message}`);
    }
  }

  // ── Languages ────────────────────────────────────────────────────────────
  const locDir = join(projectDir, "Localization");
  if (existsSync(locDir)) {
    try {
      result.languages = readdirSync(locDir).filter((d) => {
        try { return readdirSync(join(locDir, d)).length > 0; } catch { return false; }
      });
    } catch (e: any) {
      errors.push(`languages: ${e.message}`);
    }
  }

  // ── Datapoints ────────────────────────────────────────────────────────────
  const dpFile = join(projectDir, "Datapoints", "0_Datapoints.json");
  if (existsSync(dpFile)) {
    try {
      const data: any = readJson(dpFile);
      const allDps = flattenDatapoints(data.datapoints ?? []);
      if (args.all_datapoints) {
        result.datapoints = allDps;
      } else {
        // Top-level only (no dot in path = root objects)
        result.datapointRoots = allDps
          .filter((dp) => !dp.path.includes("."))
          .map((dp) => ({ name: dp.path, datatype: dp.datatype }));
        result.totalDatapoints = allDps.length;
        result.hint_datapoints = "Set all_datapoints:true to see all nested paths.";
      }
    } catch (e: any) {
      errors.push(`datapoints: ${e.message}`);
    }
  }

  // ── Text lists ────────────────────────────────────────────────────────────
  const langs = (result.languages as string[] | undefined) ?? [];
  const textLists: string[] = [];
  for (const lang of langs) {
    const tlDir = join(locDir, lang, "Textlists");
    if (!existsSync(tlDir)) continue;
    try {
      for (const f of readdirSync(tlDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const data: any = readJson(join(tlDir, f));
          const name: string = data.name ?? basename(f, ".json");
          if (!textLists.includes(name)) textLists.push(name);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  if (textLists.length > 0) result.textLists = textLists;

  // ── Schemes ───────────────────────────────────────────────────────────────
  const schemesDir = join(projectDir, "Schemes");
  if (existsSync(schemesDir)) {
    try {
      const schemes: Array<{ type: string; name: string }> = [];
      for (const typeDir of readdirSync(schemesDir)) {
        const typeFullPath = join(schemesDir, typeDir);
        try {
          for (const schemeFile of readdirSync(typeFullPath)) {
            if (!schemeFile.endsWith(".json")) continue;
            schemes.push({ type: typeDir, name: basename(schemeFile, ".json") });
          }
        } catch { /* skip */ }
      }
      if (schemes.length) result.schemes = schemes;
    } catch (e: any) {
      errors.push(`schemes: ${e.message}`);
    }
  }

  if (errors.length) result.errors = errors;

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
