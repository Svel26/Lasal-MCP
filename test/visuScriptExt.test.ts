import { describe, it, expect } from "vitest";
import { buildVisuScript, type VisuOp } from "../src/utils/visuScript.js";

function build(ops: VisuOp[]): string {
  return buildVisuScript("C:\\p\\x.lvp", ops, "C:\\tmp\\l.log", "C:\\tmp\\l.steps").script;
}

describe("buildVisuScript — VISUDesigner 01.04 operation extensions", () => {
  it("update_runtime and delete_station", () => {
    const script = build([{ type: "update_runtime" }, { type: "delete_station", station_nr: 10 }]);
    expect(script).toContain("lvd.UpdateRuntime(prj)");
    expect(script).toContain("lvd.DeleteStation(prj, 10)");
  });

  it("station_details dumps JSON to the output path", () => {
    const script = build([{ type: "station_details", station_nr: 255, output_path: "C:\\tmp\\details.json" }]);
    expect(script).toContain("lvd.GetUpdateStationDetails(prj, 255)");
    expect(script).toContain('open("C:\\\\tmp\\\\details.json", "w", encoding="utf-8")');
    expect(script).toContain("json.dumps(_details");
  });

  it("import_project loads the source, imports and closes it", () => {
    const script = build([
      { type: "import_project", source_path: "C:\\other\\Other.lvp", overwrite: true, deep_merge: true },
    ]);
    expect(script).toContain('lvd.LoadProject("C:\\\\other\\\\Other.lvp")');
    expect(script).toContain("lvd.ImportProject(_src, prj, True, True, True)");
    expect(script).toContain("lvd.CloseProject(_src)");
  });

  it("language add/remove/set-properties", () => {
    const script = build([
      { type: "add_languages", languages: ["De", "En"] },
      { type: "remove_languages", languages: ["Fr"] },
      { type: "set_language_properties", properties: [{ element: "De", property: "Revision", value: "2.0" }] },
    ]);
    expect(script).toContain('lvd.AddLanguages(prj, ["De", "En"])');
    expect(script).toContain('lvd.RemoveLanguages(prj, ["Fr"])');
    expect(script).toContain('lvd.SetLanguageProperties(prj, [lvd.PropertySet("De", "Revision", "2.0")])');
  });

  it("alarm operations emit Alarm factories", () => {
    const script = build([
      { type: "add_alarms", alarms: [{ name: "AL_Overheat", server_or_group: "PLC10", revision: "1.0" }] },
      { type: "remove_alarms", names: ["AL_Old"] },
      { type: "set_alarm_properties", properties: [{ element: "AL_Overheat", property: "Priority", value: 3 }] },
      { type: "set_alarm_servers_or_groups", alarms: [{ name: "AL_Overheat", server_or_group: "PLC20" }] },
      { type: "set_alarm_revisions", alarms: [{ name: "AL_Overheat", revision: "2.0" }] },
    ]);
    expect(script).toContain('lvd.AddAlarms(prj, [lvd.Alarm("AL_Overheat", "PLC10", "1.0")])');
    expect(script).toContain('lvd.RemoveAlarms(prj, ["AL_Old"])');
    expect(script).toContain('lvd.SetAlarmProperties(prj, [lvd.PropertySet("AL_Overheat", "Priority", 3)])');
    expect(script).toContain('lvd.SetAlarmServersOrGroups(prj, [lvd.Alarm("AL_Overheat", "PLC20", None)])');
    expect(script).toContain('lvd.SetAlarmRevisions(prj, [lvd.Alarm("AL_Overheat", None, "2.0")])');
  });
});
