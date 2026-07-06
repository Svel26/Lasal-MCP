import { existsSync, readFileSync, readdirSync, createReadStream } from "fs";
import { join, dirname, basename } from "path";
import { createInterface } from "readline";
import { z } from "zod";
import { resolveLvpPath } from "../utils/resolvePaths.js";

export const inspectVisuProjectSchema = {
  lvp_path: z
    .string()
    .optional()
    .describe("Full path to the .lvp file. Omit to auto-detect from the selected project."),
  scope: z
    .enum(["summary", "dashboards", "function_blocks", "code_modules", "datapoints", "dashboard_detail"])
    .optional()
    .default("summary")
    .describe("Detail scope to inspect. Omit or set to 'summary' for the default summary."),
  filter: z
    .string()
    .optional()
    .describe("Filter/query string (regex) for datapoint scan, or dashboard name/filename for dashboard_detail scope. Required when scope='datapoints' or scope='dashboard_detail'."),
  limit: z
    .number()
    .int()
    .optional()
    .default(50)
    .describe("Maximum matches to return when scope='datapoints'. Default 50."),
};

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

async function scanDatapointsStream(
  filePath: string,
  filterRegex: RegExp,
  limit: number
): Promise<Array<{ path: string; datatype: string }>> {
  const fileStream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const results: Array<{ path: string; datatype: string }> = [];
  const nameStack: string[] = [];

  let currentName: string | null = null;
  let currentDatatype: string | null = null;
  let inDatatype = false;

  for await (const line of rl) {
    if (line.includes('"children": [')) {
      if (currentName) {
        nameStack.push(currentName);
        currentName = null;
        currentDatatype = null;
      }
      continue;
    }

    if (line.trim().startsWith(']')) {
      if (nameStack.length > 0) {
        nameStack.pop();
      }
      continue;
    }

    const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch?.[1]) {
      currentName = nameMatch[1];
    }

    if (line.includes('"datatype"')) {
      inDatatype = true;
      const valMatch = line.match(/"value"\s*:\s*"([^"]+)"/);
      if (valMatch?.[1]) {
        currentDatatype = valMatch[1];
        inDatatype = false;
      }
    } else if (inDatatype) {
      const valMatch = line.match(/"value"\s*:\s*"([^"]+)"/);
      if (valMatch?.[1]) {
        currentDatatype = valMatch[1];
        inDatatype = false;
      }
    }

    if (line.trim().startsWith('}') || line.trim().startsWith('},')) {
      if (currentName) {
        const fullPath = [...nameStack, currentName].join(".");
        if (filterRegex.test(fullPath)) {
          results.push({ path: fullPath, datatype: currentDatatype ?? "unknown" });
          if (results.length >= limit) {
            rl.close();
            fileStream.destroy();
            break;
          }
        }
      }
      currentName = null;
      currentDatatype = null;
    }
  }

  return results;
}

async function getDatapointSummary(
  filePath: string
): Promise<{ roots: Array<{ name: string; datatype: string }>; total: number }> {
  const fileStream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const roots: Array<{ name: string; datatype: string }> = [];
  let total = 0;
  const nameStack: string[] = [];

  let currentName: string | null = null;
  let currentDatatype: string | null = null;
  let inDatatype = false;

  for await (const line of rl) {
    if (line.includes('"children": [')) {
      if (currentName) {
        nameStack.push(currentName);
        currentName = null;
        currentDatatype = null;
      }
      continue;
    }

    if (line.trim().startsWith(']')) {
      if (nameStack.length > 0) {
        nameStack.pop();
      }
      continue;
    }

    const nameMatch = line.match(/"name"\s*:\s*"([^"]+)"/);
    if (nameMatch?.[1]) {
      currentName = nameMatch[1];
    }

    if (line.includes('"datatype"')) {
      inDatatype = true;
      const valMatch = line.match(/"value"\s*:\s*"([^"]+)"/);
      if (valMatch?.[1]) {
        currentDatatype = valMatch[1];
        inDatatype = false;
      }
    } else if (inDatatype) {
      const valMatch = line.match(/"value"\s*:\s*"([^"]+)"/);
      if (valMatch?.[1]) {
        currentDatatype = valMatch[1];
        inDatatype = false;
      }
    }

    if (line.trim().startsWith('}') || line.trim().startsWith('},')) {
      if (currentName) {
        total++;
        if (nameStack.length === 0) {
          roots.push({ name: currentName, datatype: currentDatatype ?? "unknown" });
        }
      }
      currentName = null;
      currentDatatype = null;
    }
  }

  return { roots, total };
}

export async function inspectVisuProjectHandler(args: {
  lvp_path?: string;
  scope?: "summary" | "dashboards" | "function_blocks" | "code_modules" | "datapoints" | "dashboard_detail";
  filter?: string;
  limit?: number;
}) {
  const resolved = resolveLvpPath(args.lvp_path);
  if ("error" in resolved) {
    return { content: [{ type: "text" as const, text: resolved.error }], isError: true };
  }

  const lvpPath = resolved.path;
  const projectDir = dirname(lvpPath);
  const scope = args.scope ?? "summary";

  const result: Record<string, any> = {
    lvpPath,
    projectName: basename(lvpPath, ".lvp"),
    scope,
  };
  const errors: string[] = [];

  // ── 1. Datapoints scope (optimized stream scan) ────────────────────────────
  if (scope === "datapoints") {
    if (!args.filter) {
      return { content: [{ type: "text" as const, text: "filter is required when scope='datapoints'" }], isError: true };
    }
    const dpFile = join(projectDir, "Datapoints", "0_Datapoints.json");
    if (existsSync(dpFile)) {
      try {
        const matches = await scanDatapointsStream(dpFile, new RegExp(args.filter, "i"), args.limit ?? 50);
        result.datapoints = matches;
      } catch (e: any) {
        errors.push(`datapoints scan error: ${e.message}`);
      }
    } else {
      result.datapoints = [];
    }
    if (errors.length) result.errors = errors;
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  // ── 1.5. Dashboard Detail scope ──────────────────────────────────────────
  if (scope === "dashboard_detail") {
    if (!args.filter) {
      return { content: [{ type: "text" as const, text: "filter (dashboard name/filename) is required when scope='dashboard_detail'" }], isError: true };
    }
    let foundPath: string | null = null;
    for (const dirName of ["Dashboards", "GlobalDashboards", "Window", "ControlTemplate"]) {
      const dir = join(projectDir, dirName);
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const name = basename(f, ".json");
          if (name.toLowerCase() === args.filter.toLowerCase()) {
            foundPath = join(dir, f);
            break;
          }
        }
      } catch {}
      if (foundPath) break;
    }

    if (!foundPath) {
      return { content: [{ type: "text" as const, text: `Dashboard/window/template with name '${args.filter}' not found` }], isError: true };
    }

    try {
      const data = readJson(foundPath);
      result.dashboard = {
        name: data.name,
        type: data.type,
        controlId: data.controlId,
        designTimeId: data.designTimeId,
        instanceId: data.instanceId,
        properties: data.properties ?? [],
        elements: (data.dashboardelements ?? []).map((el: any) => ({
          name: el.name,
          controlId: el.controlId,
          designTimeId: el.designTimeId,
          instanceId: el.instanceId,
          properties: el.properties ?? []
        }))
      };
    } catch (e: any) {
      errors.push(`Error reading dashboard: ${e.message}`);
    }
    if (errors.length) result.errors = errors;
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  // ── 2. Dashboards scope (element counts) ───────────────────────────────────
  if (scope === "dashboards") {
    const list: Array<{ name: string; path: string; elementCount: number; type: string }> = [];
    for (const dirName of ["Dashboards", "GlobalDashboards", "Window"]) {
      const dir = join(projectDir, dirName);
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const fullPath = join(dir, f);
          try {
            const data = readJson(fullPath);
            const count = Array.isArray(data.dashboardelements) ? data.dashboardelements.length : 0;
            list.push({
              name: data.name ?? basename(f, ".json"),
              path: fullPath,
              elementCount: count,
              type: dirName.slice(0, -1).toLowerCase(), // dashboard, globaldashboard, window
            });
          } catch {}
        }
      } catch (e: any) {
        errors.push(`${dirName}: ${e.message}`);
      }
    }
    result.dashboards = list;
    if (errors.length) result.errors = errors;
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  // ── 3. Function Blocks scope ───────────────────────────────────────────────
  if (scope === "function_blocks") {
    const fbs: any[] = [];
    const fbDir = join(projectDir, "Functionblocks");
    if (existsSync(fbDir)) {
      try {
        for (const f of readdirSync(fbDir)) {
          if (!f.endsWith(".json")) continue;
          const jsonPath = join(fbDir, f);
          try {
            const data = readJson(jsonPath);
            fbs.push({
              name: data.name ?? basename(f, ".json"),
              jsonPath,
              jsPath: jsonPath.replace(".json", ".js"),
              properties: data.properties ?? [],
            });
          } catch {}
        }
      } catch (e: any) {
        errors.push(`function_blocks: ${e.message}`);
      }
    }
    result.functionBlocks = fbs;
    if (errors.length) result.errors = errors;
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  // ── 4. Code Modules scope ──────────────────────────────────────────────────
  if (scope === "code_modules") {
    const codeModulesDir = join(projectDir, "CodeModules");
    const list: string[] = [];
    if (existsSync(codeModulesDir)) {
      try {
        const modules = readdirSync(codeModulesDir).filter((f) => f.endsWith(".js") || f.endsWith(".ts"));
        list.push(...modules);
      } catch (e: any) {
        errors.push(`codeModules: ${e.message}`);
      }
    }
    result.codeModules = list;
    if (errors.length) result.errors = errors;
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  }

  // ── 5. Default Summary scope ───────────────────────────────────────────────
  // Stations
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

  // Languages
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

  // Datapoints summary (optimized stream)
  const dpFile = join(projectDir, "Datapoints", "0_Datapoints.json");
  if (existsSync(dpFile)) {
    try {
      const summary = await getDatapointSummary(dpFile);
      result.datapointRoots = summary.roots;
      result.totalDatapoints = summary.total;
    } catch (e: any) {
      errors.push(`datapoints summary: ${e.message}`);
    }
  }

  // Text Lists
  const textListsDir = join(projectDir, "Localization");
  if (existsSync(textListsDir)) {
    try {
      const textLists: string[] = [];
      for (const langDir of readdirSync(textListsDir)) {
        const langPath = join(textListsDir, langDir);
        try {
          for (const f of readdirSync(langPath)) {
            if (!f.endsWith(".json")) continue;
            try {
              const data = readJson(join(langPath, f));
              const name = data.name ?? basename(f, ".json");
              if (!textLists.includes(name)) textLists.push(name);
            } catch {}
          }
        } catch {}
      }
      if (textLists.length) result.textLists = textLists;
    } catch (e: any) {
      errors.push(`textLists: ${e.message}`);
    }
  }

  // Schemes
  const schemesDir = join(projectDir, "Schemes");
  if (existsSync(schemesDir)) {
    try {
      const schemes: Array<{ type: string; name: string; designTimeId?: string }> = [];
      for (const typeDir of readdirSync(schemesDir)) {
        const typeFullPath = join(schemesDir, typeDir);
        try {
          for (const schemeFile of readdirSync(typeFullPath)) {
            if (!schemeFile.endsWith(".json")) continue;
            try {
              const data = readJson(join(typeFullPath, schemeFile));
              if (data && Array.isArray(data.schemes)) {
                for (const s of data.schemes) {
                  if (s && s.name) {
                    schemes.push({
                      type: typeDir,
                      name: s.name,
                      designTimeId: s.designTimeId
                    });
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }
      if (schemes.length) result.schemes = schemes;
    } catch (e: any) {
      errors.push(`schemes: ${e.message}`);
    }
  }

  // Alarms
  const alarmsDir = join(projectDir, "Alarms");
  if (existsSync(alarmsDir)) {
    try {
      const alarms: string[] = [];
      for (const f of readdirSync(alarmsDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const data: any = readJson(join(alarmsDir, f));
          const name: string = data.name ?? basename(f, ".json");
          alarms.push(name);
        } catch {}
      }
      if (alarms.length) result.alarms = alarms;
    } catch (e: any) {
      errors.push(`alarms: ${e.message}`);
    }
  }

  if (errors.length) result.errors = errors;

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}
