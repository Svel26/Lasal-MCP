import { describe, it, expect } from "vitest";
import { buildVisuScript, type VisuOp } from "../src/utils/visuScript.js";

describe("buildVisuScript", () => {
  const lvp = "C:\\proj\\test.lvp";
  const log = "C:\\tmp\\visu.log";
  const steps = "C:\\tmp\\visu.steps";

  it("generates a valid Python script preamble", () => {
    const { script } = buildVisuScript(lvp, [], log, steps);
    expect(script).toContain("import sigmatek.lasal.lvd as lvd");
    expect(script).toContain("lvd.SetExceptionOnError(True)");
    expect(script).toContain("lvd.LoadProject(");
    expect(script).toContain("lvd.CloseProject(prj)");
  });

  it("includes LoadProject and CloseProject in expectedSteps", () => {
    const { expectedSteps } = buildVisuScript(lvp, [], log, steps);
    expect(expectedSteps).toContain("LoadProject");
    expect(expectedSteps).toContain("CloseProject");
  });

  it("includes SaveProject when saveAtEnd is true", () => {
    const { script, expectedSteps } = buildVisuScript(lvp, [], log, steps, true);
    expect(script).toContain("lvd.SaveProject(prj)");
    expect(expectedSteps).toContain("SaveProject");
  });

  it("omits SaveProject when saveAtEnd is false", () => {
    const { script, expectedSteps } = buildVisuScript(lvp, [], log, steps, false);
    expect(script).not.toContain("lvd.SaveProject(prj)");
    expect(expectedSteps).not.toContain("SaveProject");
  });

  it("emits update_all_stations", () => {
    const ops: VisuOp[] = [{ type: "update_all_stations" }];
    const { script } = buildVisuScript(lvp, ops, log, steps);
    expect(script).toContain("lvd.UpdateAllStations(prj)");
  });

  it("emits publish with debug flag", () => {
    const ops: VisuOp[] = [{ type: "publish", debug: true }];
    const { script } = buildVisuScript(lvp, ops, log, steps);
    expect(script).toContain("lvd.PublishProject(prj, True)");
  });

  it("emits add_text_lists", () => {
    const ops: VisuOp[] = [{
      type: "add_text_lists",
      text_lists: [{ name: "MyList", texts: [{ id: "t1", en: "Hello", de: "Hallo" }] }],
    }];
    const { script } = buildVisuScript(lvp, ops, log, steps);
    expect(script).toContain("lvd.AddTextLists(prj,");
    expect(script).toContain("lvd.TextList(");
    expect(script).toContain("lvd.TextElement(");
  });

  it("emits download with connection and flags", () => {
    const ops: VisuOp[] = [{ type: "download", connection: "TCPIP:10.0.0.1", flags: 2, add_runtime: true }];
    const { script } = buildVisuScript(lvp, ops, log, steps);
    expect(script).toContain("lvd.DownloadProject(prj,");
    expect(script).toContain("True"); // add_runtime
  });

  it("emits set_datapoint_properties", () => {
    const ops: VisuOp[] = [{
      type: "set_datapoint_properties",
      properties: [{ element: "dp1", property: "visible", value: true }],
    }];
    const { script } = buildVisuScript(lvp, ops, log, steps);
    expect(script).toContain("lvd.SetDatapointProperties(prj,");
    expect(script).toContain("lvd.PropertySet(");
  });

  it("emits add_schemes", () => {
    const ops: VisuOp[] = [{
      type: "add_schemes",
      schemes: [{ scheme_type: "ColorSchemes", name: "MyScheme", entries: [{ position: 0, property: "bg", value: "#fff" }] }],
    }];
    const { script } = buildVisuScript(lvp, ops, log, steps);
    expect(script).toContain("lvd.AddSchemes(prj,");
    expect(script).toContain("lvd.Scheme(");
    expect(script).toContain("lvd.SchemeEntry(");
  });

  it("emits add_media_items with overwrite", () => {
    const ops: VisuOp[] = [{
      type: "add_media_items",
      items: [{ media_type: "image", path: "C:\\img\\logo.png" }],
      overwrite: true,
    }];
    const { script } = buildVisuScript(lvp, ops, log, steps);
    expect(script).toContain("lvd.AddMediaItems(prj,");
    expect(script).toContain("True"); // overwrite
  });

  it("emits step markers for each operation", () => {
    const ops: VisuOp[] = [
      { type: "update_all_stations" },
      { type: "publish" },
    ];
    const { expectedSteps } = buildVisuScript(lvp, ops, log, steps);
    expect(expectedSteps).toContain("0_update_all_stations");
    expect(expectedSteps).toContain("1_publish");
  });

  it("wraps in try/except", () => {
    const { script } = buildVisuScript(lvp, [], log, steps);
    expect(script).toContain("except Exception as e:");
    expect(script).toContain("traceback.print_exc()");
    expect(script).toContain("sys.exit(1)");
  });
});
