import { describe, it, expect } from "vitest";
import { buildLutc } from "../src/utils/lutc.js";

describe("buildLutc", () => {
  it("emits targets and instructions with 0-based target ids", () => {
    const xml = buildLutc({
      machineNr: "042",
      targets: [
        { station: "Terminal", ip: "10.0.0.1", port: "1954", ssltls: "0" },
        { station: "Machine", ip: "10.0.0.2", port: "1954", ssltls: "1" },
      ],
      instructions: [
        { kind: "class2", station: "Machine", file: "C:\\d\\m.lcp", savePrj: true, platform: "Arm" },
        { kind: "screen", station: "Terminal", file: "C:\\d\\v.lpr" },
        { kind: "run", station: "Terminal" },
        { kind: "write", station: "Terminal", channel: "TestCls.Srv", value: 20 },
      ],
    });
    expect(xml).toContain('<UpdateConfig TargetId="0" MachineNr="042">');
    expect(xml).toContain('<Target Station="Terminal">');
    expect(xml).toContain('<Target Station="Machine">');
    expect(xml).toContain('<TCPIP ConfigName="Terminal" BUS="3"');
    expect(xml).toContain('SSLTLS="1"');
    expect(xml).toContain('<DwnLdLC2 TargetId="1">');
    expect(xml).toContain('<Param SavePrj="true" Platform="Arm"/>');
    expect(xml).toContain('<DwnLdLSE TargetId="0">');
    expect(xml).toContain('<PrjRun TargetId="0">');
    expect(xml).toContain('<WrNr TargetId="0">');
    expect(xml).toContain('<Param Val="TestCls.Srv"/>');
  });

  it("emits file transfer instructions in the verified schema", () => {
    const xml = buildLutc({
      targets: [{ station: "T", ip: "1.2.3.4", port: "1954" }],
      instructions: [
        { kind: "file", station: "T", direction: "download", localPath: "C:\\local", remotePath: "C:\\remote" },
        { kind: "file", station: "T", direction: "upload", localPath: "C:\\local2", remotePath: "C:\\remote2" },
        { kind: "file", station: "T", direction: "delete", remotePath: "C:\\remote3" },
        { kind: "file", station: "T", direction: "mkdir", remotePath: "C:\\newdir" },
        { kind: "file", station: "T", direction: "move", remotePath: "C:\\a", targetPath: "C:\\b" },
        { kind: "file", station: "T", direction: "exists", remotePath: "C:\\check" },
        { kind: "os", station: "T", file: "C:\\os.lbi", rebootTimeoutMs: 600000 },
        { kind: "boot", station: "T", timeoutMs: 180000 },
        { kind: "cli", station: "T", command: "REXX C:\\ip.rex" },
      ],
    });
    expect(xml).toContain('<DwnLdFile TargetId="0">');
    expect(xml).toContain('<UpLdFile TargetId="0">');
    expect(xml).toContain('<DelFile TargetId="0">');
    expect(xml).toContain('<MkDir TargetId="0">');
    expect(xml).toContain('<MvFile TargetId="0">');
    expect(xml).toContain('<ExistFile TargetId="0">');
    expect(xml).toContain('<DwnLdOS TargetId="0">');
    expect(xml).toContain('<Param Val="600000"/>');
    expect(xml).toContain('<Boot TargetId="0">');
    expect(xml).toContain('<CLICmd TargetId="0">');
  });

  it("escapes XML attribute values", () => {
    const xml = buildLutc({
      targets: [{ station: "A&B", ip: "1.2.3.4", port: "1954" }],
      instructions: [],
    });
    expect(xml).toContain('Station="A&amp;B"');
  });

  it("throws when an instruction references an unknown station", () => {
    expect(() =>
      buildLutc({
        targets: [{ station: "A", ip: "1.2.3.4", port: "1954" }],
        instructions: [{ kind: "run", station: "B" }],
      }),
    ).toThrow(/unknown station/i);
  });
});
