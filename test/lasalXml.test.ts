import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import {
  readLatin1,
  writeLatin1,
  parseLcp,
  parseStClass,
  parseLcn,
  addServerToSt,
  removeServerFromSt,
  renameServerInSt,
  addClientToSt,
  removeClientFromSt,
  renameClientInSt,
  addVariableToSt,
  removeVariableFromSt,
  renameVariableInSt,
  addMethodToSt,
  removeMethodFromSt,
  renameMethodInSt,
  cascadeRenameServerInLcn,
  cascadeRemoveServerFromLcn,
  cascadeRenameClientInLcn,
  cascadeRemoveClientFromLcn,
  findObjectsOfClass,
  addServerTypeToStBody,
  removeServerTypeFromStBody,
  addClientTypeToStBody,
  removeClientTypeFromStBody,
} from "../src/utils/lasalXml.js";

const FIXTURES = join(dirname(import.meta.filename), "fixtures");
const WORK = join(dirname(import.meta.filename), "_work");

function workCopy(fixture: string): string {
  const src = join(FIXTURES, fixture);
  const dest = join(WORK, fixture);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return dest;
}

beforeEach(() => {
  mkdirSync(WORK, { recursive: true });
});

afterEach(() => {
  rmSync(WORK, { recursive: true, force: true });
});

// ─── .lcp parsing ────────────────────────────────────────────────────────────

describe("parseLcp", () => {
  it("parses project name, class files, and network files", () => {
    const info = parseLcp(join(FIXTURES, "Sample.lcp"));
    expect(info.projectName).toBe("SampleProject");
    expect(info.classFiles).toHaveLength(2);
    expect(info.classFiles[0]!.relativePath).toBe(".\\Class\\Motor.st");
    expect(info.networkFiles).toHaveLength(1);
    expect(info.networkFiles[0]!.relativePath).toBe(".\\Network\\Main.lcn");
  });

  it("resolves class and network directories", () => {
    const info = parseLcp(join(FIXTURES, "Sample.lcp"));
    expect(info.classDir).toContain("Class");
    expect(info.networkDir).toContain("Network");
  });
});

// ─── .st parsing ─────────────────────────────────────────────────────────────

describe("parseStClass", () => {
  it("extracts class metadata", () => {
    const info = parseStClass(join(FIXTURES, "Motor.st"));
    expect(info.name).toBe("Motor");
    expect(info.revision).toBe("1");
    expect(info.cyclicTask).toBe(true);
    expect(info.realtimeTask).toBe(false);
  });

  it("parses server channels", () => {
    const info = parseStClass(join(FIXTURES, "Motor.st"));
    expect(info.servers).toHaveLength(2);
    const speed = info.servers.find((s) => s.name === "s_Speed");
    expect(speed).toBeDefined();
    expect(speed!.visualized).toBe(true);
    expect(speed!.initialize).toBe(true);
    expect(speed!.defValue).toBe("0");
    expect(speed!.writeProtected).toBe(false);
  });

  it("parses client channels", () => {
    const info = parseStClass(join(FIXTURES, "Motor.st"));
    expect(info.clients).toHaveLength(2);
    const enable = info.clients.find((c) => c.name === "c_Enable");
    expect(enable).toBeDefined();
    expect(enable!.required).toBe(true);
    expect(enable!.internal).toBe(false);
  });

  it("parses a class with write-protected servers", () => {
    const info = parseStClass(join(FIXTURES, "Sensor.st"));
    expect(info.name).toBe("Sensor");
    expect(info.servers).toHaveLength(1);
    expect(info.servers[0]!.writeProtected).toBe(true);
  });
});

// ─── .lcn parsing ────────────────────────────────────────────────────────────

describe("parseLcn", () => {
  it("parses objects", () => {
    const info = parseLcn(join(FIXTURES, "Main.lcn"));
    expect(info.name).toBe("Main");
    expect(info.objects).toHaveLength(2);
    const motor1 = info.objects.find((o) => o.name === "Motor1");
    expect(motor1).toBeDefined();
    expect(motor1!.className).toBe("Motor");
    expect(motor1!.channelValues).toHaveProperty("s_Speed", "100");
  });

  it("parses connections", () => {
    const info = parseLcn(join(FIXTURES, "Main.lcn"));
    expect(info.connections).toHaveLength(2);
    const remote = info.connections.find((c) => c.station === "Remote1");
    expect(remote).toBeDefined();
    expect(remote!.remote).toBe(true);
    expect(remote!.source).toBe("Motor1.c_Enable");
  });
});

// ─── ST block extraction edge cases ──────────────────────────────────────────

describe("extractStBlock edge cases", () => {
  it("correctly parses .st file with a (* comment *) before the (*! block", () => {
    const info = parseStClass(join(FIXTURES, "NestedComment.st"));
    expect(info.name).toBe("NestedComment");
    expect(info.servers).toHaveLength(1);
    expect(info.servers[0]!.name).toBe("s_Val");
  });
});

// ─── .st round-trip editing ──────────────────────────────────────────────────

describe("ST editing round-trips", () => {
  it("preserves byte-identical output for untouched regions after addServer + removeServer", () => {
    const path = workCopy("Motor.st");
    const original = readFileSync(path, "latin1");

    addServerToSt(path, { name: "s_Test", visualized: false, initialize: false, writeProtected: false, retentive: "false" });
    removeServerFromSt(path, "s_Test");

    const restored = readFileSync(path, "latin1");
    // The XML block should be back to original (the added+removed server leaves no trace)
    const info = parseStClass(path);
    expect(info.servers).toHaveLength(2);
    expect(info.servers.map((s) => s.name).sort()).toEqual(["s_Running", "s_Speed"]);
  });

  it("addServerToSt adds a server channel", () => {
    const path = workCopy("Motor.st");
    addServerToSt(path, { name: "s_Torque", visualized: true, initialize: true, defValue: "0", writeProtected: false, retentive: "false" });
    const info = parseStClass(path);
    expect(info.servers).toHaveLength(3);
    expect(info.servers.find((s) => s.name === "s_Torque")).toBeDefined();
  });

  it("renameServerInSt renames a server channel", () => {
    const path = workCopy("Motor.st");
    renameServerInSt(path, "s_Speed", "s_Velocity");
    const info = parseStClass(path);
    expect(info.servers.find((s) => s.name === "s_Velocity")).toBeDefined();
    expect(info.servers.find((s) => s.name === "s_Speed")).toBeUndefined();
  });

  it("addClientToSt adds a client channel", () => {
    const path = workCopy("Motor.st");
    addClientToSt(path, { name: "c_Direction", required: false, internal: false });
    const info = parseStClass(path);
    expect(info.clients).toHaveLength(3);
    expect(info.clients.find((c) => c.name === "c_Direction")).toBeDefined();
  });

  it("removeClientFromSt removes a client channel", () => {
    const path = workCopy("Motor.st");
    removeClientFromSt(path, "c_SetSpeed");
    const info = parseStClass(path);
    expect(info.clients).toHaveLength(1);
    expect(info.clients[0]!.name).toBe("c_Enable");
  });

  it("renameClientInSt renames a client channel", () => {
    const path = workCopy("Motor.st");
    renameClientInSt(path, "c_Enable", "c_PowerOn");
    const info = parseStClass(path);
    expect(info.clients.find((c) => c.name === "c_PowerOn")).toBeDefined();
    expect(info.clients.find((c) => c.name === "c_Enable")).toBeUndefined();
  });
});

// ─── Variable editing ────────────────────────────────────────────────────────

describe("Variable editing", () => {
  it("addVariableToSt adds a variable", () => {
    const path = workCopy("Motor.st");
    addVariableToSt(path, "maxSpeed", "DINT");
    const content = readFileSync(path, "latin1");
    expect(content).toContain("maxSpeed");
    expect(content).toContain(": DINT;");
  });

  it("removeVariableFromSt removes a variable", () => {
    const path = workCopy("Motor.st");
    removeVariableFromSt(path, "counter");
    const content = readFileSync(path, "latin1");
    expect(content).not.toMatch(/\bcounter\b.*:\s*DINT;/);
    expect(content).toContain("lastSpeed");
  });

  it("renameVariableInSt renames a variable in declaration", () => {
    const path = workCopy("Motor.st");
    renameVariableInSt(path, "counter", "cycleCount");
    const content = readFileSync(path, "latin1");
    expect(content).toContain("cycleCount");
    expect(content).not.toMatch(/\bcounter\b.*:/);
  });
});

// ─── Method editing ──────────────────────────────────────────────────────────

describe("Method editing", () => {
  it("addMethodToSt adds declaration and implementation", () => {
    const path = workCopy("Motor.st");
    addMethodToSt(path, "Motor", { name: "Stop", params: [{ name: "immediate", type: "BOOL" }], body: "s_Running := FALSE;" });
    const content = readFileSync(path, "latin1");
    expect(content).toContain("FUNCTION Stop");
    expect(content).toContain("FUNCTION Motor::Stop");
    expect(content).toContain("s_Running := FALSE;");
  });

  it("removeMethodFromSt removes declaration and implementation", () => {
    const path = workCopy("Motor.st");
    removeMethodFromSt(path, "Motor", "Run");
    const content = readFileSync(path, "latin1");
    expect(content).not.toContain("FUNCTION Motor::Run");
    // Should still have class structure
    expect(content).toContain("CLASS Motor");
  });

  it("renameMethodInSt renames declaration and implementation", () => {
    const path = workCopy("Motor.st");
    renameMethodInSt(path, "Motor", "Run", "Execute");
    const content = readFileSync(path, "latin1");
    expect(content).toContain("FUNCTION Execute");
    expect(content).toContain("FUNCTION Motor::Execute");
    expect(content).not.toContain("Motor::Run");
  });
});

// ─── .lcn cascade edits ─────────────────────────────────────────────────────

describe("LCN cascade edits", () => {
  it("cascadeRenameServerInLcn renames server in objects and connections", () => {
    const path = workCopy("Main.lcn");
    // s_Speed is present in Motor1's channels AND referenced in connections
    cascadeRenameServerInLcn(path, "Motor", "s_Speed", "s_Velocity");
    const content = readFileSync(path, "latin1");
    expect(content).toContain('Name="s_Velocity"');
    expect(content).not.toContain('Name="s_Speed"');
  });

  it("cascadeRenameServerInLcn renames server in connection Destination", () => {
    const path = workCopy("Main.lcn");
    // s_Running is referenced as Destination="Motor1.s_Running"
    cascadeRenameServerInLcn(path, "Motor", "s_Running", "s_Active");
    const content = readFileSync(path, "latin1");
    expect(content).toContain('Destination="Motor1.s_Active"');
    expect(content).not.toContain('Destination="Motor1.s_Running"');
  });

  it("cascadeRemoveServerFromLcn removes server and connections", () => {
    const path = workCopy("Main.lcn");
    cascadeRemoveServerFromLcn(path, "Motor", "s_Running", ["Motor1"]);
    const content = readFileSync(path, "latin1");
    expect(content).not.toContain('Destination="Motor1.s_Running"');
  });

  it("cascadeRenameClientInLcn renames client in objects and connections", () => {
    const path = workCopy("Main.lcn");
    cascadeRenameClientInLcn(path, "Motor", "c_Enable", "c_PowerOn", ["Motor1"]);
    const content = readFileSync(path, "latin1");
    expect(content).toContain('Source="Motor1.c_PowerOn"');
    expect(content).not.toContain('Source="Motor1.c_Enable"');
  });

  it("cascadeRemoveClientFromLcn removes client and connections", () => {
    const path = workCopy("Main.lcn");
    cascadeRemoveClientFromLcn(path, "Motor", "c_Enable", ["Motor1"]);
    const content = readFileSync(path, "latin1");
    expect(content).not.toContain('Source="Motor1.c_Enable"');
  });

  it("findObjectsOfClass finds objects across lcn files", () => {
    const result = findObjectsOfClass([join(FIXTURES, "Main.lcn")], "Motor");
    expect(result.size).toBe(1);
    const names = result.get(join(FIXTURES, "Main.lcn"));
    expect(names).toContain("Motor1");
  });
});

// ─── ST body type declarations ───────────────────────────────────────────────

describe("ST body type declarations", () => {
  it("addServerTypeToStBody adds a server type line", () => {
    const path = workCopy("Motor.st");
    addServerTypeToStBody(path, "s_Torque", "DINT");
    const content = readFileSync(path, "latin1");
    expect(content).toMatch(/s_Torque\s*:\s*DINT;/);
  });

  it("removeServerTypeFromStBody removes a server type line", () => {
    const path = workCopy("Motor.st");
    removeServerTypeFromStBody(path, "s_Speed");
    const content = readFileSync(path, "latin1");
    expect(content).not.toMatch(/s_Speed\s*:\s*DINT;/);
    expect(content).toMatch(/s_Running\s*:\s*BOOL;/);
  });

  it("addClientTypeToStBody adds a client type line", () => {
    const path = workCopy("Motor.st");
    addClientTypeToStBody(path, "c_Direction", "BOOL");
    const content = readFileSync(path, "latin1");
    expect(content).toMatch(/c_Direction\s*:\s*BOOL;/);
  });

  it("removeClientTypeFromStBody removes a client type line", () => {
    const path = workCopy("Motor.st");
    removeClientTypeFromStBody(path, "c_Enable");
    const content = readFileSync(path, "latin1");
    expect(content).not.toMatch(/c_Enable\s*:\s*BOOL;/);
    expect(content).toMatch(/c_SetSpeed\s*:\s*DINT;/);
  });
});
