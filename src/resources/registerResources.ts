import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readState, getHmiForProject } from "../state.js";
import { findLsmPath, parseSolution, findLcpFiles } from "../utils/projectScanner.js";
import { parseLcp, parseStClass } from "../utils/lasalXml.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { completeClassNames } from "../utils/completions.js";
import { existsSync, readFileSync } from "fs";

export function registerResources(server: McpServer, guideText: string) {
  // 1. Static guide resource
  server.resource(
    "LASAL Project Guide",
    "lasal://guide",
    {
      description: "Complete guide to LASAL file formats, file editing, HMI debugging, and the runtime JS API",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [{ uri: "lasal://guide", mimeType: "text/markdown", text: guideText }],
    }),
  );

  // 2. Dynamic project status resource
  server.resource(
    "LASAL Project Status",
    "lasal://project/status",
    {
      description: "Current project selection, discovered stations, runtime URLs, and configuration",
      mimeType: "application/json",
    },
    async () => {
      const state = readState();
      const projDir = state.currentProject;
      const hmi = getHmiForProject(state);
      const lcpPaths = projDir ? findLcpFiles(projDir) : [];
      let stations: unknown[] = [];
      if (projDir) {
        const lsmPath = findLsmPath(projDir);
        if (lsmPath) {
          try {
            const soln = parseSolution(lsmPath);
            stations = soln.stations;
          } catch {}
        }
      }
      return {
        contents: [
          {
            uri: "lasal://project/status",
            mimeType: "application/json",
            text: JSON.stringify(
              {
                currentProject: projDir,
                stations,
                lcpPaths,
                hmiRuntime: hmi ? { running: true, url: hmi.url, port: hmi.port, pid: hmi.pid } : null,
                larsInstances: state.larsInstances ?? {},
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // 3. Dynamic stations resource
  server.resource(
    "LASAL Stations",
    "lasal://stations",
    {
      description: "List of stations in the active LASAL solution and their connection targets",
      mimeType: "application/json",
    },
    async () => {
      const state = readState();
      if (!state.currentProject) {
        return {
          contents: [
            {
              uri: "lasal://stations",
              mimeType: "application/json",
              text: JSON.stringify({ error: "No project selected." }),
            },
          ],
        };
      }
      const lsmPath = findLsmPath(state.currentProject);
      if (!lsmPath) {
        return {
          contents: [
            {
              uri: "lasal://stations",
              mimeType: "application/json",
              text: JSON.stringify({ error: "No .lsm solution file found." }),
            },
          ],
        };
      }
      const soln = parseSolution(lsmPath);
      return {
        contents: [
          {
            uri: "lasal://stations",
            mimeType: "application/json",
            text: JSON.stringify(soln.stations, null, 2),
          },
        ],
      };
    },
  );

  // 4. Resource Template for Classes
  const classTemplate = new ResourceTemplate("lasal://classes/{className}", {
    list: async () => {
      const state = readState();
      if (!state.currentProject) return { resources: [] };
      const resolved = resolveLcpPath();
      if ("error" in resolved) return { resources: [] };
      try {
        const lcp = parseLcp(resolved.path);
        const resources = lcp.classFiles
          .filter((f) => f.absPath.endsWith(".st") && existsSync(f.absPath))
          .map((f) => {
            try {
              const info = parseStClass(f.absPath);
              return {
                uri: `lasal://classes/${info.name}`,
                name: info.name,
                description: `CLASS 2 Structured Text source for ${info.name}`,
                mimeType: "text/plain",
              };
            } catch {
              return null;
            }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        return { resources };
      } catch {
        return { resources: [] };
      }
    },
    complete: {
      className: async (value) => completeClassNames(value),
    },
  });

  server.resource(
    "LASAL Class Source",
    classTemplate,
    {
      description: "Structured Text (.st) class source code by class name",
      mimeType: "text/plain",
    },
    async (uri, { className }) => {
      const name = String(className);
      const state = readState();
      if (!state.currentProject) {
        throw new Error("No project selected.");
      }
      const resolved = resolveLcpPath();
      if ("error" in resolved) {
        throw new Error(resolved.error);
      }
      const lcp = parseLcp(resolved.path);
      for (const cf of lcp.classFiles) {
        if (!cf.absPath.endsWith(".st") || !existsSync(cf.absPath)) continue;
        try {
          const info = parseStClass(cf.absPath);
          if (info.name === name) {
            const text = readFileSync(cf.absPath, "latin1");
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: "text/plain",
                  text,
                },
              ],
            };
          }
        } catch {}
      }
      throw new Error(`Class "${name}" not found in project.`);
    },
  );
}
