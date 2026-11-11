import { describe, expect, it } from "vitest";
import { diagnoseLarsWorkspaces } from "../src/tools/larsDoctor.js";
import type { LarsWorkspace } from "../src/utils/lars.js";

function workspace(over: Partial<LarsWorkspace> = {}): LarsWorkspace {
  return {
    name: "PLC",
    onlinePort: 1954,
    comlinkServerPort: 1955,
    comlinkBasePort: 1000,
    alarmPort: 1957,
    dataServiceTcpPort: 2402,
    activeData: "C:\\",
    autoexec: "C:\\Autoexec.lsl",
    lslWork: "C:\\LSLWORK",
    sramData: "C:\\",
    dataRoot: "C:\\Temp\\lars-plc",
    dataLenMb: 40,
    codeLenMb: 8,
    ...over,
  };
}

describe("LARS doctor diagnostics", () => {
  it("reports a healthy configuration", () => {
    const issues = diagnoseLarsWorkspaces([workspace()], {}, { larsExists: true, configExists: true });
    expect(issues).toEqual([]);
  });

  it("reports duplicate ports and data roots", () => {
    const issues = diagnoseLarsWorkspaces(
      [workspace(), workspace({ name: "HMI", onlinePort: 1954, dataRoot: "c:\\temp\\LARS-PLC" })],
      {},
      { larsExists: true, configExists: true },
    );
    expect(issues.join("\n")).toContain("Port 1954");
    expect(issues.join("\n")).toContain("dataRoot");
  });

  it("reports missing screen projects, drive roots and orphan instances", () => {
    const issues = diagnoseLarsWorkspaces(
      [
        workspace({
          dataRoot: "C:\\",
          screenProjectPath: "C:\\missing\\panel.lpr",
        }),
      ],
      {
        Ghost: {
          name: "Ghost",
          onlinePort: 2000,
          pid: 999_999,
        },
      },
      { larsExists: false, configExists: false },
    );
    const text = issues.join("\n");
    expect(text).toContain("dataRoot is a host drive root");
    expect(text).toContain("screen project not found");
    expect(text).toContain("no matching workspace config");
    expect(text).toContain("LARS executable not found");
    expect(text).toContain("LARS config not found");
  });
});
