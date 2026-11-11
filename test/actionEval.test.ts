import { describe, expect, it } from "vitest";
import { createPilotRegistry } from "../src/core/actions/pilotCatalog.js";
import { searchActions } from "../src/core/actions/search.js";

interface EvalTask {
  query: string;
  expected: string;
}

/**
 * Deterministic catalog-discovery benchmark. It measures whether an agent can
 * find the intended action from a task description without loading the whole
 * catalog. This is not an LLM eval; it is the fast regression guard for search
 * ranking, aliases and summaries.
 */
const TASKS: EvalTask[] = [
  { query: "compile the plc", expected: "class2.build.compile" },
  { query: "download the project to the plc", expected: "class2.build.download" },
  { query: "read live plc values", expected: "class2.plc.values.read" },
  { query: "write a live plc value", expected: "class2.plc.values.write" },
  { query: "start the plc runtime", expected: "class2.plc.start" },
  { query: "stop the plc runtime", expected: "class2.plc.stop" },
  { query: "inspect the class2 project", expected: "class2.project.inspect" },
  { query: "add a network object", expected: "class2.object.add" },
  { query: "run a class2 python script", expected: "class2.script.run" },
  { query: "export visu text lists", expected: "visu.textlist.export" },
  { query: "start the hmi web simulation", expected: "visu.hmi.start" },
  { query: "publish the visu project", expected: "visu.publish" },
  { query: "compile the screen project", expected: "screen.project.compile" },
  { query: "download the screen to the panel", expected: "screen.project.download" },
  { query: "export screen texts to xml", expected: "screen.text.export_xml" },
  { query: "import class2 variables into the screen", expected: "screen.variables.import" },
  { query: "setup lars workspaces", expected: "lars.workspace.setup" },
  { query: "update lars workspace ports", expected: "lars.workspace.update" },
  { query: "run a lars scenario", expected: "lars.scenario.run" },
  { query: "take a lars screenshot", expected: "lars.instance.screenshot" },
  { query: "export lars config", expected: "lars.workspace.export" },
  { query: "import lars config", expected: "lars.workspace.import" },
  { query: "list lars instances", expected: "lars.instance.list" },
  { query: "restart lars instance", expected: "lars.instance.restart" },
  { query: "validate lars workspace", expected: "lars.workspace.validate" },
  { query: "read lars logs", expected: "lars.instance.logs" },
  { query: "clone lars workspace", expected: "lars.workspace.clone" },
  { query: "create lars workspace", expected: "lars.workspace.create" },
  { query: "lars instance status", expected: "lars.instance.status" },
  { query: "deploy all stations with machinemanager", expected: "deploy.solution.run" },
  { query: "set the station ip address", expected: "project.target_ip.set" },
];

describe("action catalog discovery eval", () => {
  it("keeps the intended action in the top results", () => {
    const registry = createPilotRegistry();
    let top1 = 0;
    let top3 = 0;
    const misses: Array<{ query: string; expected: string; got: string[] }> = [];

    for (const task of TASKS) {
      const hits = searchActions(registry, {
        query: task.query,
        includeExpert: true,
        limit: 3,
      });
      const ids = hits.map((hit) => hit.action.id);
      if (ids[0] === task.expected) top1 += 1;
      if (ids.includes(task.expected)) top3 += 1;
      else misses.push({ query: task.query, expected: task.expected, got: ids });
    }

    expect(misses, JSON.stringify(misses, null, 2)).toEqual([]);
    expect(top1 / TASKS.length).toBeGreaterThanOrEqual(0.8);
    expect(top3).toBe(TASKS.length);
  });

  it("finds the target IP action by its alias", () => {
    const registry = createPilotRegistry();
    expect(registry.get("target_ip")?.id).toBe("project.target_ip.set");
  });
});
