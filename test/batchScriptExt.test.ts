import { describe, it, expect } from "vitest";
import { buildBatchScript, type BatchOp } from "../src/utils/batchScript.js";

function build(ops: BatchOp[]): string {
  return buildBatchScript("C:\\p\\x.lcp", ops, "C:\\tmp\\l.log", "C:\\tmp\\l.steps").script;
}

describe("buildBatchScript — CLASS 2 02.04 operation extensions", () => {
  it("copy_class loads the source project, copies and closes it", () => {
    const script = build([
      { type: "copy_class", sourceProject: "C:\\src\\lib.lcp", className: "PbLib", overwrite: true },
    ]);
    expect(script).toContain("src_prj = batch.LoadProject(u\"C:\\\\src\\\\lib.lcp\".encode('mbcs'))");
    expect(script).toContain("batch.CopyClass(prj, src_prj, u\"PbLib\".encode('mbcs'), True, True)");
    expect(script).toContain("batch.CloseProject(src_prj)");
  });

  it("copy_network uses CopyNetwork with overwrite flag", () => {
    const script = build([
      { type: "copy_network", sourceProject: "C:\\src\\lib.lcp", network: "StdNet", overwrite: false },
    ]);
    expect(script).toContain("batch.CopyNetwork(prj, src_prj, u\"StdNet\".encode('mbcs'), False, True)");
  });

  it("replace_object passes connections/name-check flags", () => {
    const script = build([
      {
        type: "replace_object",
        sourceProject: "C:\\src\\lib.lcp",
        network: "Main",
        objectName: "Motor1",
        sourceNetwork: "Lib",
        sourceObject: "MotorNew",
        useSourceConnections: true,
        checkObjectName: true,
      },
    ]);
    expect(script).toContain(
      "batch.ReplaceObject(prj, src_prj, u\"Main\".encode('mbcs'), u\"Motor1\".encode('mbcs'), u\"Lib\".encode('mbcs'), u\"MotorNew\".encode('mbcs'), True, True)",
    );
  });

  it("update_referenced emits classes or networks refresh", () => {
    expect(build([{ type: "update_referenced", scope: "classes" }])).toContain("batch.UpdateReferencedClasses(prj)");
    expect(build([{ type: "update_referenced", scope: "networks" }])).toContain("batch.UpdateReferencedNetworks(prj)");
  });

  it("mm_change_connection and mm_update_server_list", () => {
    const script = build([
      { type: "mm_change_connection", station: "PLC10", newConnection: "PLC20" },
      { type: "mm_update_server_list", station: "PLC10" },
    ]);
    expect(script).toContain(
      "batch.MMChangeConnectionOption(prj, u\"PLC10\".encode('mbcs'), u\"PLC20\".encode('mbcs'))",
    );
    expect(script).toContain("batch.MMUpdateCurrentServerList(prj, u\"PLC10\".encode('mbcs'))");
  });

  it("calculate_resources uses an empty mbcs path when no output is given", () => {
    const script = build([{ type: "calculate_resources" }]);
    expect(script).toContain("batch.CalculateResourcesAndExport(prj, u\"\".encode('mbcs'))");
  });

  it("import_lcz and set_project_revision", () => {
    const script = build([
      { type: "import_lcz", file: "C:\\bundles\\Box.lcz", overwrite: true, keepExistingLinked: false },
      { type: "set_project_revision", revision: "1.2" },
    ]);
    expect(script).toContain(
      "batch.ImportFromFile(prj, u\"C:\\\\bundles\\\\Box.lcz\".encode('mbcs'), True, True, False)",
    );
    expect(script).toContain("batch.SetProjectRevision(prj, u\"1.2\".encode('mbcs'))");
  });

  it("add_library accepts a path or name", () => {
    const script = build([{ type: "add_library", library: "SigCLib" }]);
    expect(script).toContain("batch.AddLibrary(prj, u\"SigCLib\".encode('mbcs'))");
  });
});
