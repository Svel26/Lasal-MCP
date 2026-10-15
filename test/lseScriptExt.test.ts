import { describe, it, expect } from "vitest";
import { buildLseScript, resolveLseServerProperty, LSE_SERVER_PROPERTIES } from "../src/utils/lseScript.js";

const opts = {
  logPath: "C:\\tmp\\l.log",
  stepsPath: "C:\\tmp\\l.steps",
  resultPath: "C:\\tmp\\l.json",
  saveAtEnd: false,
};

describe("buildLseScript — extensions", () => {
  it("create mode emits IApplication.New instead of Open", () => {
    const { script } = buildLseScript("C:\\new\\Fresh.lpr", [{ type: "textlist_create", name: "L", text: "Hi" }], {
      ...opts,
      saveAtEnd: true,
      openMode: "new",
    });
    expect(script).toContain("$prj = $app.New('C:\\new\\Fresh.lpr')");
    expect(script).not.toContain("$app.Open(");
    expect(script).toContain("$prj.TextLists.Insert('L', 'Hi')");
  });

  it("open mode is still the default", () => {
    const { script } = buildLseScript("C:\\p\\x.lpr", [{ type: "info" }], opts);
    expect(script).toContain("$prj = $app.Open('C:\\p\\x.lpr')");
  });

  it("server_set_property enumerates servers by index and assigns Property(id)", () => {
    const { script } = buildLseScript(
      "C:\\p\\x.lpr",
      [{ type: "server_set_property", server: "Motor1.s_Speed", property: "HostName", value: "line7" }],
      opts,
    );
    expect(script).toContain("$n = Get-Count $prj.Servers");
    expect(script).toContain("if ($nm -eq 'Motor1.s_Speed') { $sv = $o; break }");
    expect(script).toContain("$sv.Property(40) = 'line7'");
  });

  it("server_get_property maps names to numeric ids", () => {
    const { script } = buildLseScript(
      "C:\\p\\x.lpr",
      [{ type: "server_get_property", server: "Motor1.s_Speed", property: "refreshtime" }],
      opts,
    );
    expect(script).toContain("$v = $sv.Property(3)");
    expect(script).toContain("server_get_property");
  });

  it("resolveLseServerProperty accepts names, LSSP_ prefixes and numbers", () => {
    expect(resolveLseServerProperty("refreshtime")).toBe(3);
    expect(resolveLseServerProperty("LSSP_Unit")).toBe(14);
    expect(resolveLseServerProperty(40)).toBe(40);
    expect(LSE_SERVER_PROPERTIES.hostname).toBe(40);
    expect(() => resolveLseServerProperty("nope")).toThrow();
  });
});
