import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, dirname } from "path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { parseConnectionTarget } from "../src/utils/preflight.js";
import {
  readLarsWorkspaces,
  writeLarsWorkspaces,
  upsertLarsWorkspace,
  removeLarsWorkspace,
  allocateLarsPorts,
  pointStationAtLars,
} from "../src/utils/lars.js";
import { readLssConnection, updateLssConnection } from "../src/utils/projectScanner.js";

const FIXTURES = join(dirname(import.meta.filename), "fixtures");

describe("parseConnectionTarget", () => {
  it("parses TCPIP with port", () => {
    const { ip, port } = parseConnectionTarget("TCPIP:10.0.0.5:1964");
    expect(ip).toBe("10.0.0.5");
    expect(port).toBe(1964);
  });

  it("parses TCPIP without port", () => {
    const { ip, port } = parseConnectionTarget("TCPIP:10.0.0.5");
    expect(ip).toBe("10.0.0.5");
    expect(port).toBeUndefined();
  });

  it("parses bare IP", () => {
    const { ip } = parseConnectionTarget("10.0.0.5");
    expect(ip).toBe("10.0.0.5");
  });

  it("handles DNS names", () => {
    const { ip } = parseConnectionTarget("TCPIP:myplc.local");
    expect(ip).toBe("myplc.local");
  });
});

describe("LARS workspace config", () => {
  let configPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-lars-"));
    configPath = join(tempDir, "lasalos2.xml");
    process.env.LASAL_LARS_CONFIG = configPath;
    const sample = `<?xml version="1.0" encoding="UTF-8"?>
<LARSCONFIGURATIONS ConfigVersion="2">
  <WORKSPACE Name="DEFAULT">
    <MEMORY>
      <DATALEN Unit="MiB">40</DATALEN>
      <CODELEN Unit="MiB">8</CODELEN>
    </MEMORY>
    <PATH>
      <ACTIVEDAT>C:\\</ACTIVEDAT>
      <AUTOEXEC>C:\\Autoexec.lsl</AUTOEXEC>
      <LSLWORK>C:\\LSLWORK</LSLWORK>
      <SRAMDAT>C:\\</SRAMDAT>
    </PATH>
    <COMTCP>
      <ONLINE>1954</ONLINE>
      <COMLINK_SRVR>1955</COMLINK_SRVR>
      <COMLINK>1000</COMLINK>
      <ALARM>1957</ALARM>
    </COMTCP>
    <RESOLUTION />
    <DRIVEMAP>
      <DRIVEMAP_ELEMENT>
        <DRIVE>C:</DRIVE>
        <PATH>C:\\Lars</PATH>
      </DRIVEMAP_ELEMENT>
    </DRIVEMAP>
    <IP_MAP>
    </IP_MAP>
  </WORKSPACE>
</LARSCONFIGURATIONS>
`;
    writeFileSync(configPath, sample, "utf-8");
  });

  afterEach(() => {
    delete process.env.LASAL_LARS_CONFIG;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads the DEFAULT workspace", () => {
    const workspaces = readLarsWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.name).toBe("DEFAULT");
    expect(workspaces[0]!.onlinePort).toBe(1954);
    expect(workspaces[0]!.comlinkBasePort).toBe(1000);
    expect(workspaces[0]!.dataLenMb).toBe(40);
  });

  it("allocates distinct ports for a second workspace", () => {
    const workspaces = readLarsWorkspaces();
    const ports = allocateLarsPorts(workspaces);
    expect(ports.onlinePort).toBe(1964);
    expect(ports.comlinkServerPort).toBe(1965);
    expect(ports.comlinkBasePort).toBe(1010);
    expect(ports.alarmPort).toBe(1967);
  });

  it("upserts a new workspace and round-trips it", () => {
    const { workspace } = upsertLarsWorkspace("Proj_PLC", {
      onlinePort: 1964,
      comlinkServerPort: 1965,
      comlinkBasePort: 1010,
      alarmPort: 1967,
      classProjectPath: "C:\\proj\\PLC.lcp",
    });
    expect(workspace.onlinePort).toBe(1964);

    const workspaces = readLarsWorkspaces();
    expect(workspaces).toHaveLength(2);
    const plc = workspaces.find((w) => w.name === "Proj_PLC");
    expect(plc?.classProjectPath).toBe("C:\\proj\\PLC.lcp");
    expect(plc?.comlinkBasePort).toBe(1010);
    // DEFAULT preserved
    expect(workspaces.find((w) => w.name === "DEFAULT")?.onlinePort).toBe(1954);
  });

  it("updates an existing workspace in place", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    const { workspace } = upsertLarsWorkspace("Proj_PLC", { dataLenMb: 80 });
    expect(workspace.dataLenMb).toBe(80);
    expect(workspace.onlinePort).toBe(1964); // unchanged
    expect(readLarsWorkspaces()).toHaveLength(2);
  });

  it("removes a workspace", () => {
    upsertLarsWorkspace("Proj_PLC", {});
    const remaining = removeLarsWorkspace("Proj_PLC");
    expect(remaining.map((w) => w.name)).toEqual(["DEFAULT"]);
    const content = readFileSync(configPath, "utf-8");
    expect(content).not.toContain("Proj_PLC");
  });

  it("creates a backup before the first write", () => {
    upsertLarsWorkspace("Proj_PLC", {});
    expect(existsSync(`${configPath}.bak`)).toBe(true);
  });
});

describe("pointStationAtLars", () => {
  let tempDir: string;
  let lssPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-lss-"));
    lssPath = join(tempDir, "PLC.lss");
    const sample = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<SlnStation Name="PLC" OnlineConnection="PLC50 (Project)" Color="12813661">
\t<OnlineConnectionInfo>
\t\t<TCPIP ConfigName="PLC50" BUS="3" Password="" IP="10.195.0.50" PORT="1954" SomeFlags="129" PLCID="" Repeater="0" SSLTLS="0" Favorite="0"/>
\t</OnlineConnectionInfo>
</SlnStation>
`;
    writeFileSync(lssPath, sample, "latin1");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads the current connection", () => {
    const conn = readLssConnection(lssPath);
    expect(conn).toEqual({ ip: "10.195.0.50", port: "1954" });
  });

  it("points the station at a LARS instance and records the original", () => {
    const result = pointStationAtLars(lssPath, 1964);
    expect(result).toEqual({ previousIp: "10.195.0.50", previousPort: "1954" });
    const conn = readLssConnection(lssPath);
    expect(conn).toEqual({ ip: "127.0.0.1", port: "1964" });
  });

  it("restores the original target", () => {
    pointStationAtLars(lssPath, 1964);
    updateLssConnection(lssPath, { ip: "10.195.0.50", port: "1954" });
    const conn = readLssConnection(lssPath);
    expect(conn).toEqual({ ip: "10.195.0.50", port: "1954" });
  });
});