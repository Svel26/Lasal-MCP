import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, dirname } from "path";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { parseConnectionTarget } from "../src/utils/preflight.js";
import {
  readLarsWorkspaces,
  writeLarsWorkspaces,
  upsertLarsWorkspace,
  removeLarsWorkspace,
  allocateLarsPorts,
  pointStationAtLars,
  gcLarsWorkspaces,
  mapStationsToLars,
  findLarsInstancesForStation,
  instanceBelongsToProject,
  resolveEffectiveOnlinePort,
  seedDataRoot,
  defaultDataRoot,
  defaultSeedFiles,
  switchProjectTargetToPC,
  restoreProjectTarget,
  type LarsInstanceInfo,
} from "../src/utils/lars.js";
import {
  readLssConnection,
  updateLssConnection,
  setLssActiveProfile,
  readLssActiveProfile,
  pointStationAtProfile,
} from "../src/utils/projectScanner.js";

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

describe("gcLarsWorkspaces", () => {
  let configPath: string;
  let tempDir: string;
  let lssPath: string;

  const notRunning = () => false;
  const emptyInstances: Record<string, LarsInstanceInfo> = {};

  function makeInstance(over: Partial<LarsInstanceInfo> = {}): Record<string, LarsInstanceInfo> {
    return {
      Proj_PLC: {
        name: "Proj_PLC",
        onlinePort: 1964,
        ...over,
      },
    };
  }

  function makeLss(ip: string, port: string = "1964"): string {
    const sample = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<SlnStation Name="PLC" OnlineConnection="PLC50 (Project)" Color="12813661">
\t<OnlineConnectionInfo>
\t\t<TCPIP ConfigName="PLC50" BUS="3" Password="" IP="${ip}" PORT="${port}" SomeFlags="129" PLCID="" Repeater="0" SSLTLS="0" Favorite="0"/>
\t</OnlineConnectionInfo>
</SlnStation>
`;

    writeFileSync(lssPath, sample, "latin1");
    return lssPath;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-gc-"));
    configPath = join(tempDir, "lasalos2.xml");
    process.env.LASAL_LARS_CONFIG = configPath;
    writeFileSync(
      configPath,
      `<?xml version="1.0" encoding="UTF-8"?>
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
`,
      "utf-8",
    );
    lssPath = join(tempDir, "PLC.lss");
  });

  afterEach(() => {
    delete process.env.LASAL_LARS_CONFIG;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("never collects manually configured workspaces", () => {
    const result = gcLarsWorkspaces({
      minAgeH: 0,
      isRunning: notRunning,
      instances: emptyInstances,
      larsGc: {},
    });
    expect(result.removed).toHaveLength(0);
    expect(result.kept.map((k) => k.name)).toContain("DEFAULT");
    expect(readLarsWorkspaces()).toHaveLength(1);
  });

  it("removes an auto-created workspace that is unreferenced", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    makeLss("10.195.0.50");
    const result = gcLarsWorkspaces({
      minAgeH: 0,
      isRunning: notRunning,
      instances: makeInstance({ stationLssPath: lssPath }),
      larsGc: {},
    });
    expect(result.removed.map((r) => r.name)).toEqual(["Proj_PLC"]);
    expect(readLarsWorkspaces().map((w) => w.name)).toEqual(["DEFAULT"]);
  });

  it("keeps a workspace whose station .lss still points at it", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    makeLss("127.0.0.1");
    const result = gcLarsWorkspaces({
      minAgeH: 0,
      isRunning: notRunning,
      instances: makeInstance({ stationLssPath: lssPath }),
      larsGc: {},
    });
    expect(result.removed).toHaveLength(0);
    expect(result.kept.map((k) => k.name)).toContain("Proj_PLC");
    expect(readLarsWorkspaces()).toHaveLength(2);
  });

  it("keeps a workspace referenced by a published DataService stations.json", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    const dataDir = join(tempDir, "dataservice");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "stations.json"),
      JSON.stringify({ stations: [{ name: "PLC", connection: "127.0.0.1:1964" }] }),
      "utf-8",
    );
    const result = gcLarsWorkspaces({
      minAgeH: 0,
      isRunning: notRunning,
      dataDirs: [dataDir],
      instances: makeInstance({ stationName: "PLC" }),
      larsGc: {},
    });
    expect(result.removed).toHaveLength(0);
    expect(result.kept.map((k) => k.name)).toContain("Proj_PLC");
  });

  it("keeps running workspaces even when unreferenced", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    makeLss("10.195.0.50");
    const result = gcLarsWorkspaces({
      minAgeH: 0,
      isRunning: (name) => name === "Proj_PLC",
      instances: makeInstance({ stationLssPath: lssPath }),
      larsGc: {},
    });
    expect(result.removed).toHaveLength(0);
    expect(readLarsWorkspaces()).toHaveLength(2);
  });

  it("defers removal until the min age is reached, tracking candidates", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    makeLss("10.195.0.50");
    const now = Date.now();
    const young = gcLarsWorkspaces({
      minAgeH: 24,
      isRunning: notRunning,
      instances: makeInstance({ stationLssPath: lssPath }),
      larsGc: {},
    });
    expect(young.removed).toHaveLength(0);
    expect(young.candidates.map((c) => c.name)).toEqual(["Proj_PLC"]);
    expect(readLarsWorkspaces()).toHaveLength(2);

    const aged = gcLarsWorkspaces({
      minAgeH: 24,
      isRunning: notRunning,
      instances: makeInstance({ stationLssPath: lssPath }),
      larsGc: { Proj_PLC: { since: now - 25 * 3_600_000 } },
    });
    expect(aged.candidates).toHaveLength(0);
    expect(aged.removed.map((r) => r.name)).toEqual(["Proj_PLC"]);
    expect(readLarsWorkspaces().map((w) => w.name)).toEqual(["DEFAULT"]);
  });

  it("dry run reports removals without deleting", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    makeLss("10.195.0.50");
    const result = gcLarsWorkspaces({
      dryRun: true,
      minAgeH: 0,
      isRunning: notRunning,
      instances: makeInstance({ stationLssPath: lssPath }),
      larsGc: {},
    });
    expect(result.removed.map((r) => r.name)).toEqual(["Proj_PLC"]);
    expect(readLarsWorkspaces()).toHaveLength(2);
  });

  it("never collects workspaces of the protected project", () => {
    upsertLarsWorkspace("Proj_PLC", { onlinePort: 1964 });
    makeLss("10.195.0.50");
    const result = gcLarsWorkspaces({
      minAgeH: 0,
      isRunning: notRunning,
      instances: makeInstance({ stationLssPath: lssPath, projectDir: "C:\\proj" }),
      protectProjects: ["c:/proj/"],
      larsGc: {},
    });
    expect(result.removed).toHaveLength(0);
    const kept = result.kept.find((k) => k.name === "Proj_PLC");
    expect(kept?.reason).toContain("selected project");
    expect(readLarsWorkspaces()).toHaveLength(2);
  });

  it("still collects unreferenced workspaces from other projects when one is protected", () => {
    upsertLarsWorkspace("Other_PLC", { onlinePort: 1964 });
    upsertLarsWorkspace("Prot_PLC", { onlinePort: 1974 });
    makeLss("10.195.0.50");
    const instances: Record<string, LarsInstanceInfo> = {
      Other_PLC: { name: "Other_PLC", onlinePort: 1964, stationLssPath: lssPath, projectDir: "C:\\other" },
      Prot_PLC: { name: "Prot_PLC", onlinePort: 1974, projectDir: "C:\\proj" },
    };
    const result = gcLarsWorkspaces({
      minAgeH: 0,
      isRunning: notRunning,
      instances,
      protectProjects: ["C:\\proj"],
      larsGc: {},
    });
    expect(result.removed.map((r) => r.name)).toEqual(["Other_PLC"]);
    expect(readLarsWorkspaces().map((w) => w.name)).toEqual(["DEFAULT", "Prot_PLC"]);
  });
});

describe("findLarsInstancesForStation / instanceBelongsToProject", () => {
  const instances: Record<string, LarsInstanceInfo> = {
    A_PLC: { name: "A_PLC", onlinePort: 1964, stationName: "PLC", projectDir: "C:\\Projects\\A" },
    B_PLC: { name: "B_PLC", onlinePort: 1974, stationName: "PLC", projectDir: "C:\\Projects\\B" },
    A_HMI: { name: "A_HMI", onlinePort: 1984, stationName: "HMI", projectDir: "C:\\Projects\\A" },
  };

  it("scopes a station to the requested project, case- and slash-insensitively", () => {
    const lookup = findLarsInstancesForStation(instances, "PLC", "c:/projects/a/");
    expect(lookup.matches.map((i) => i.name)).toEqual(["A_PLC"]);
    expect(lookup.foreign.map((i) => i.name)).toEqual(["B_PLC"]);
  });

  it("reports all matches as ambiguous when no project is selected", () => {
    const lookup = findLarsInstancesForStation(instances, "PLC");
    expect(lookup.matches.map((i) => i.name)).toEqual(["A_PLC", "B_PLC"]);
    expect(lookup.foreign).toHaveLength(0);
  });

  it("matches legacy instances without projectDir via their .lcp/.lss paths", () => {
    const legacy: Record<string, LarsInstanceInfo> = {
      L_PLC: { name: "L_PLC", onlinePort: 1994, stationName: "PLC", lcpPath: "C:\\Projects\\B\\Stations\\PLC\\x.lcp" },
    };
    expect(findLarsInstancesForStation(legacy, "PLC", "C:\\Projects\\B").matches.map((i) => i.name)).toEqual(["L_PLC"]);
    expect(findLarsInstancesForStation(legacy, "PLC", "C:\\Projects\\C").matches).toHaveLength(0);
  });

  it("returns no matches for a station that only exists in another project", () => {
    const lookup = findLarsInstancesForStation(instances, "PLC", "C:\\Projects\\C");
    expect(lookup.matches).toHaveLength(0);
    expect(lookup.foreign.map((i) => i.name).sort()).toEqual(["A_PLC", "B_PLC"]);
  });

  it("treats trailing separators and mixed case as the same project", () => {
    expect(instanceBelongsToProject(instances.A_PLC!, "C:\\Projects\\A\\")).toBe(true);
    expect(instanceBelongsToProject(instances.A_PLC!, "c:/PROJECTS/a")).toBe(true);
    expect(instanceBelongsToProject(instances.A_PLC!, "C:\\Projects")).toBe(false);
    expect(instanceBelongsToProject(instances.A_PLC!, null)).toBe(false);
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

  it("points the station at a LARS instance by adding a profile, keeping the original", () => {
    const result = pointStationAtLars(lssPath, 1964);
    expect(result).toMatchObject({ previousConnection: "PLC50 (Project)", previousIp: "10.195.0.50" });

    const raw = readFileSync(lssPath, "latin1");
    // Both profiles survive: the machine address is never overwritten.
    expect(raw).toContain('ConfigName="PLC50"');
    expect(raw).toContain('IP="10.195.0.50"');
    expect(raw).toContain('ConfigName="LARS"');
    expect(raw).toContain('IP="127.0.0.1" PORT="1964"');
    expect(raw).toContain('OnlineConnection="LARS"');
  });

  it("reads the active profile, not merely the first one", () => {
    pointStationAtLars(lssPath, 1964);
    expect(readLssConnection(lssPath)).toEqual({ ip: "127.0.0.1", port: "1964" });
  });

  it("switches back to the original profile without writing an address", () => {
    pointStationAtLars(lssPath, 1964);
    expect(setLssActiveProfile(lssPath, "PLC50 (Project)")).toBe(true);
    expect(readLssConnection(lssPath)).toEqual({ ip: "10.195.0.50", port: "1954" });
  });

  it("updates the existing LARS profile instead of adding a second one", () => {
    pointStationAtLars(lssPath, 1964);
    pointStationAtLars(lssPath, 1974);
    const raw = readFileSync(lssPath, "latin1");
    expect((raw.match(/ConfigName="LARS"/g) ?? []).length).toBe(1);
    expect(raw).toContain('PORT="1974"');
  });

  it("adds an OnlineConnectionInfo block when the station has no TCPIP profile", () => {
    const bare = join(tempDir, "Local.lss");
    writeFileSync(bare, `<SlnStation Name="Local" Color="0">\n</SlnStation>\n`, "latin1");
    const result = pointStationAtProfile(bare, 1999);
    expect("error" in result).toBe(false);
    expect(readLssConnection(bare)).toEqual({ ip: "127.0.0.1", port: "1999" });
    expect(readLssActiveProfile(bare)).toBe("LARS");
  });
});

describe("mapStationsToLars", () => {
  const instances: Record<string, LarsInstanceInfo> = {
    NVeniaFil1057A01_PLC: {
      name: "NVeniaFil1057A01_PLC",
      onlinePort: 1984,
      stationName: "PLC",
      stationId: 10,
    },
    NVeniaFil1057A01_HMI: {
      name: "NVeniaFil1057A01_HMI",
      onlinePort: 1964,
      stationName: "HMI",
      stationId: 255,
    },
  };

  it("remaps the published runtime layout by station id (ip + port)", () => {
    const stations = [
      { station: 255, conType: "INTERN" },
      { station: 10, ip: "10.195.0.10", conType: "TCP" },
      { station: 0, conType: "LOCAL" },
    ];
    const changed = mapStationsToLars(stations as any, instances, () => true);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toEqual({ station: "10", from: "10.195.0.10", to: "127.0.0.1:1984" });
    expect((stations[1] as any).ip).toBe("127.0.0.1");
    expect((stations[1] as any).port).toBe(1984);
    // untouched
    expect((stations[0] as any).conType).toBe("INTERN");
    expect((stations[2] as any).conType).toBe("LOCAL");
  });

  it("remaps the design-time layout by name (connection string)", () => {
    const stations = [
      { name: "PLC", connection: "TCPIP:10.195.0.10" },
      { name: "HMI", connection: "INTERN" },
    ];
    const changed = mapStationsToLars(stations as any, instances, () => true);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toEqual({ station: "PLC", from: "TCPIP:10.195.0.10", to: "127.0.0.1:1984" });
    expect((stations[0] as any).connection).toBe("127.0.0.1:1984");
  });

  it("leaves stations without a matching running instance untouched", () => {
    const stations = [{ station: 10, ip: "10.195.0.10", conType: "TCP" }];
    const changed = mapStationsToLars(stations as any, {});
    expect(changed).toHaveLength(0);
    expect((stations[0] as any).ip).toBe("10.195.0.10");
  });

  it("ignores running instances from other projects when a project scope is given", () => {
    const scoped: Record<string, LarsInstanceInfo> = {
      A_PLC: { name: "A_PLC", onlinePort: 1964, stationId: 10, projectDir: "C:\\Projects\\A" },
      B_PLC: { name: "B_PLC", onlinePort: 1974, stationId: 10, projectDir: "C:\\Projects\\B" },
    };
    const stations = [{ station: 10, ip: "10.195.0.10", conType: "TCP" }];
    const changed = mapStationsToLars(stations as any, scoped, () => true, "C:\\Projects\\A");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.to).toBe("127.0.0.1:1964");
    expect((stations[0] as any).port).toBe(1964);
  });
});

describe("LARS config written by LARSConfigTool (Desc attributes)", () => {
  let configPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-lars-desc-"));
    configPath = join(tempDir, "lasalos2.xml");
    process.env.LASAL_LARS_CONFIG = configPath;
    const sample = `<?xml version="1.0" encoding="UTF-8"?>
<LARSCONFIGURATIONS ConfigVersion="2">
\t<WORKSPACE Name="Vobra_PLC">
\t\t<MEMORY>
\t\t\t<DATALEN Unit="MiB">40</DATALEN>
\t\t\t<CODELEN Unit="MiB">8</CODELEN>
\t\t</MEMORY>
\t\t<PATH>
\t\t\t<ACTIVEDAT>C:\\</ACTIVEDAT>
\t\t\t<AUTOEXEC>C:\\Autoexec.lsl</AUTOEXEC>
\t\t\t<LSLWORK>C:\\LSLWORK</LSLWORK>
\t\t\t<SRAMDAT>C:\\</SRAMDAT>
\t\t</PATH>
\t\t<COMTCP>
\t\t\t<ONLINE Desc="Port for the online comunication.">1974</ONLINE>
\t\t\t<COMLINK_SRVR Desc="Comlink command server port.">1975</COMLINK_SRVR>
\t\t\t<COMLINK Desc="Base port number used for clients.">1020</COMLINK>
\t\t\t<ALARM Desc="Alarm-Server port of the LSE-Kernel.">1977</ALARM>
\t\t\t<DATASERVICETCPPORT Desc="Datalink-Server port of the LSE-Kernel.">2402</DATASERVICETCPPORT>
\t\t</COMTCP>
\t\t<RESOLUTION></RESOLUTION>
\t\t<DRIVEMAP>
\t\t\t<DRIVEMAP_ELEMENT>
\t\t\t\t<DRIVE>C:</DRIVE>
\t\t\t\t<PATH>C:\\</PATH>
\t\t\t</DRIVEMAP_ELEMENT>
\t\t</DRIVEMAP>
\t\t<IP_MAP>
\t\t</IP_MAP>
\t</WORKSPACE>
</LARSCONFIGURATIONS>
`;
    writeFileSync(configPath, sample, "utf-8");
  });

  afterEach(() => {
    delete process.env.LASAL_LARS_CONFIG;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses port values from elements that carry Desc attributes", () => {
    const workspaces = readLarsWorkspaces();
    expect(workspaces).toHaveLength(1);
    const ws = workspaces[0]!;
    // Regression: a raw String() of the {#text, @_Desc} object fell back to 1954 silently.
    expect(ws.onlinePort).toBe(1974);
    expect(ws.comlinkServerPort).toBe(1975);
    expect(ws.comlinkBasePort).toBe(1020);
    expect(ws.alarmPort).toBe(1977);
    expect(ws.dataServiceTcpPort).toBe(2402);
  });

  it("rewrites the config in the canonical LARSConfigTool shape", () => {
    writeLarsWorkspaces(readLarsWorkspaces());
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toContain('<ONLINE Desc="Port for the online comunication.">1974</ONLINE>');
    expect(raw).toContain(
      '<DATASERVICETCPPORT Desc="Datalink-Server port of the LSE-Kernel.">2402</DATASERVICETCPPORT>',
    );
    const again = readLarsWorkspaces();
    expect(again[0]!.onlinePort).toBe(1974);
    expect(again[0]!.dataServiceTcpPort).toBe(2402);
  });
});

describe("resolveEffectiveOnlinePort", () => {
  it("prefers the first answering candidate (workspace port before the default)", async () => {
    const answering = new Set([1974, 1954]);
    const port = await resolveEffectiveOnlinePort([1974, 1954], [], async (p) => answering.has(p), 0, 100);
    expect(port).toBe(1974);
  });

  it("falls back to the default port when the configured port never answers", async () => {
    const port = await resolveEffectiveOnlinePort([1974, 1954], [], async (p) => p === 1954, 0, 100);
    expect(port).toBe(1954);
  });

  it("never picks a port another running instance owns", async () => {
    const port = await resolveEffectiveOnlinePort([1974, 1954], [1974], async () => true, 0, 100);
    expect(port).toBe(1954);
  });

  it("returns null when nothing answers", async () => {
    const port = await resolveEffectiveOnlinePort([1974, 1954], [], async () => false, 50, 10);
    expect(port).toBeNull();
  });

  it("returns null when every candidate is owned", async () => {
    const port = await resolveEffectiveOnlinePort([1974, 1954], [1974, 1954], async () => true, 0, 100);
    expect(port).toBeNull();
  });
});

describe("lossless LARS config writes", () => {
  let configPath: string;
  let tempDir: string;

  const fixture = () => `<?xml version="1.0" encoding="UTF-8"?>
<LARSCONFIGURATIONS ConfigVersion="2">
\t<GLOBAL_NOTE>keep me</GLOBAL_NOTE>
\t<WORKSPACE Name="DEFAULT" Remark="keep-remark">
\t\t<MEMORY>
\t\t\t<DATALEN Unit="MiB">40</DATALEN>
\t\t\t<CODELEN Unit="MiB">8</CODELEN>
\t\t</MEMORY>
\t\t<PATH>
\t\t\t<ACTIVEDAT>C:\\</ACTIVEDAT>
\t\t\t<AUTOEXEC>C:\\Autoexec.lsl</AUTOEXEC>
\t\t\t<LSLWORK>C:\\LSLWORK</LSLWORK>
\t\t\t<SRAMDAT>C:\\</SRAMDAT>
\t\t</PATH>
\t\t<COMTCP>
\t\t\t<ONLINE Desc="Port for the online comunication.">1954</ONLINE>
\t\t\t<COMLINK_SRVR>1955</COMLINK_SRVR>
\t\t\t<COMLINK>1000</COMLINK>
\t\t\t<ALARM>1957</ALARM>
\t\t</COMTCP>
\t\t<RESOLUTION></RESOLUTION>
\t\t<DRIVEMAP>
\t\t\t<DRIVEMAP_ELEMENT>
\t\t\t\t<DRIVE>C:</DRIVE>
\t\t\t\t<PATH>C:\\</PATH>
\t\t\t</DRIVEMAP_ELEMENT>
\t\t</DRIVEMAP>
\t\t<IP_MAP>
\t\t</IP_MAP>
\t</WORKSPACE>
\t<WORKSPACE Name="Custom_PLC">
\t\t<MEMORY>
\t\t\t<DATALEN Unit="MiB">40</DATALEN>
\t\t\t<CODELEN Unit="MiB">8</CODELEN>
\t\t</MEMORY>
\t\t<PATH>
\t\t\t<ACTIVEDAT>C:\\</ACTIVEDAT>
\t\t\t<AUTOEXEC>C:\\Autoexec.lsl</AUTOEXEC>
\t\t\t<LSLWORK>C:\\LSLWORK</LSLWORK>
\t\t\t<SRAMDAT>C:\\</SRAMDAT>
\t\t</PATH>
\t\t<COMTCP>
\t\t\t<ONLINE Desc="Port for the online comunication.">1974</ONLINE>
\t\t\t<COMLINK_SRVR Desc="Comlink command server port.">1975</COMLINK_SRVR>
\t\t\t<COMLINK Desc="Base port number used for clients.">1020</COMLINK>
\t\t\t<ALARM>1977</ALARM>
\t\t\t<DATASERVICETCPPORT Desc="Datalink-Server port of the LSE-Kernel.">2402</DATASERVICETCPPORT>
\t\t</COMTCP>
\t\t<WINDOW_SETTINGS>
\t\t\t<TITLE>My LARS</TITLE>
\t\t</WINDOW_SETTINGS>
\t\t<RESOLUTION></RESOLUTION>
\t\t<DRIVEMAP>
\t\t\t<DRIVEMAP_ELEMENT>
\t\t\t\t<DRIVE>C:</DRIVE>
\t\t\t\t<PATH>C:\\</PATH>
\t\t\t</DRIVEMAP_ELEMENT>
\t\t\t<DRIVEMAP_ELEMENT>
\t\t\t\t<DRIVE>D:</DRIVE>
\t\t\t\t<PATH>D:\\Data</PATH>
\t\t\t</DRIVEMAP_ELEMENT>
\t\t</DRIVEMAP>
\t\t<IP_MAP>
\t\t</IP_MAP>
\t</WORKSPACE>
\t<!-- keep this comment -->
</LARSCONFIGURATIONS>
`;

  const blockOf = (raw: string, name: string) =>
    raw.match(new RegExp(`<WORKSPACE Name="${name}"[\\s\\S]*?</WORKSPACE>`))?.[0];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-lars-merge-"));
    configPath = join(tempDir, "lasalos2.xml");
    process.env.LASAL_LARS_CONFIG = configPath;
    writeFileSync(configPath, fixture(), "utf-8");
  });

  afterEach(() => {
    delete process.env.LASAL_LARS_CONFIG;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("updates only the fields the MCP owns and preserves everything else", () => {
    const before = readFileSync(configPath, "utf-8");
    const defaultBlockBefore = blockOf(before, "DEFAULT")!;
    upsertLarsWorkspace("Custom_PLC", { onlinePort: 1994, classProjectPath: "C:\\proj\\PLC.lcp" });
    const after = readFileSync(configPath, "utf-8");

    // Modeled fields were updated; attributes on those elements survive.
    expect(after).toContain('<ONLINE Desc="Port for the online comunication.">1994</ONLINE>');
    expect(after).toContain("<CLASS_PRJ_PATH>C:\\proj\\PLC.lcp</CLASS_PRJ_PATH>");
    // Foreign content survives.
    expect(after).toContain("<GLOBAL_NOTE>keep me</GLOBAL_NOTE>");
    expect(after).toContain("<!-- keep this comment -->");
    expect(after).toContain('Remark="keep-remark"');
    expect(after).toContain("<WINDOW_SETTINGS>\n\t\t\t<TITLE>My LARS</TITLE>\n\t\t</WINDOW_SETTINGS>");
    // The second (D:) drive mapping survives untouched.
    expect(after).toContain("<DRIVE>D:</DRIVE>\n\t\t\t\t<PATH>D:\\Data</PATH>");
    // Other workspaces are byte-identical.
    expect(blockOf(after, "DEFAULT")).toBe(defaultBlockBefore);
    // Re-read sees the new values.
    const ws = readLarsWorkspaces().find((w) => w.name === "Custom_PLC")!;
    expect(ws.onlinePort).toBe(1994);
    expect(ws.classProjectPath).toBe("C:\\proj\\PLC.lcp");
  });

  it("appends new workspaces without touching existing bytes", () => {
    const before = readFileSync(configPath, "utf-8");
    upsertLarsWorkspace("Proj_New", { onlinePort: 1984 });
    const after = readFileSync(configPath, "utf-8");
    expect(after.startsWith(before.slice(0, before.lastIndexOf("</LARSCONFIGURATIONS>")))).toBe(true);
    expect(
      readLarsWorkspaces()
        .map((w) => w.name)
        .sort(),
    ).toEqual(["Custom_PLC", "DEFAULT", "Proj_New"]);
  });

  it("removals delete only the workspace block", () => {
    const before = readFileSync(configPath, "utf-8");
    const defaultBlockBefore = blockOf(before, "DEFAULT")!;
    removeLarsWorkspace("Custom_PLC");
    const after = readFileSync(configPath, "utf-8");
    expect(after).not.toContain("Custom_PLC");
    expect(after).toContain("<GLOBAL_NOTE>keep me</GLOBAL_NOTE>");
    expect(blockOf(after, "DEFAULT")).toBe(defaultBlockBefore);
  });
});

describe("workspace data root", () => {
  let configPath: string;
  let tempDir: string;

  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<LARSCONFIGURATIONS ConfigVersion="2">
  <WORKSPACE Name="DEFAULT">
    <PATH>
      <ACTIVEDAT>C:\\</ACTIVEDAT>
      <AUTOEXEC>C:\\Autoexec.lsl</AUTOEXEC>
      <LSLWORK>C:\\LSLWORK</LSLWORK>
      <SRAMDAT>C:\\</SRAMDAT>
    </PATH>
    <COMTCP>
      <ONLINE>1954</ONLINE>
    </COMTCP>
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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-root-"));
    configPath = join(tempDir, "lasalos2.xml");
    process.env.LASAL_LARS_CONFIG = configPath;
    writeFileSync(configPath, sample, "utf-8");
  });

  afterEach(() => {
    delete process.env.LASAL_LARS_CONFIG;
    delete process.env.LOCALAPPDATA;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads the C: drive map as dataRoot, separate from ACTIVEDAT", () => {
    const [ws] = readLarsWorkspaces();
    expect(ws.dataRoot).toBe("C:\\Lars");
    expect(ws.activeData).toBe("C:\\");
  });

  it("writes dataRoot to the drive map without touching ACTIVEDAT", () => {
    upsertLarsWorkspace("DEFAULT", { dataRoot: "D:\\isolated" });
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toContain("<PATH>D:\\isolated</PATH>");
    expect(raw).toContain("<ACTIVEDAT>C:\\</ACTIVEDAT>");
    expect(readLarsWorkspaces()[0].dataRoot).toBe("D:\\isolated");
  });

  it("defaults a new workspace to an isolated data root under LOCALAPPDATA", () => {
    process.env.LOCALAPPDATA = join(tempDir, "appdata");
    const { workspace } = upsertLarsWorkspace("NewWs", {});
    expect(workspace.dataRoot).toBe(defaultDataRoot("NewWs"));
    expect(workspace.dataRoot).toContain(join("lasal-mcp", "lars", "NewWs"));
    expect(readLarsWorkspaces().find((w) => w.name === "NewWs")?.dataRoot).toBe(workspace.dataRoot);
  });

  it("seeds files into the data root and refreshes them from the source", () => {
    const srcDir = join(tempDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const src = join(srcDir, "MQTT_Client_Iq.xml");
    writeFileSync(src, "<v1/>", "utf-8");
    const root = join(tempDir, "root");

    const first = seedDataRoot(root, [src]);
    expect(first?.seeded).toHaveLength(1);
    expect(readFileSync(join(root, "MQTT_Client_Iq.xml"), "utf-8")).toBe("<v1/>");

    // The copy tracks its source: editing the source wins on the next start.
    writeFileSync(src, "<v2/>", "utf-8");
    seedDataRoot(root, [src]);
    expect(readFileSync(join(root, "MQTT_Client_Iq.xml"), "utf-8")).toBe("<v2/>");
  });

  it("reports seed files that do not exist instead of failing", () => {
    const result = seedDataRoot(join(tempDir, "root"), [join(tempDir, "nope.xml")]);
    expect(result?.seeded).toHaveLength(0);
    expect(result?.missing).toHaveLength(1);
  });

  it("refuses a drive root so the real system drive is never written", () => {
    const result = seedDataRoot("C:\\", [join(tempDir, "anything")]);
    expect(result?.skipped).toBeTruthy();
    expect(result?.seeded).toHaveLength(0);
  });

  it("returns undefined when no data root is configured", () => {
    expect(seedDataRoot(undefined, [])).toBeUndefined();
  });

  it("does not seed into a drive root even with a valid source", () => {
    const srcDir = join(tempDir, "src2");
    mkdirSync(srcDir, { recursive: true });
    const src = join(srcDir, "autoexec.lsl");
    writeFileSync(src, "x", "utf-8");
    expect(seedDataRoot("C:/", [src])?.seeded).toHaveLength(0);
  });

  it("default seed list is overridable via env", () => {
    process.env.LASAL_MCP_LARS_SEED_FILES = "C:\\a.xml; D:\\b.xml ";
    expect(defaultSeedFiles()).toEqual(["C:\\a.xml", "D:\\b.xml"]);
    delete process.env.LASAL_MCP_LARS_SEED_FILES;
    expect(defaultSeedFiles().length).toBeGreaterThan(0);
  });
});

describe("switchProjectTargetToPC", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-target-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("switches ARM to PC and restores byte-identically", () => {
    const lcp = join(tempDir, "p.lcp");
    const original = `<Project>\n\t<Target UseFPU="true" Processor="ARM">\n\t</Target>\n</Project>\n`;
    writeFileSync(lcp, original, "latin1");

    const r = switchProjectTargetToPC(lcp);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.alreadyPc).toBe(false);
    expect(readFileSync(lcp, "latin1")).not.toContain('Processor="ARM"');

    expect(restoreProjectTarget(lcp, r.previousTag)).toBe(true);
    expect(readFileSync(lcp, "latin1")).toBe(original);
  });

  it("is idempotent on an already-PC project instead of erroring", () => {
    const lcp = join(tempDir, "pc.lcp");
    const original = `<Project>\n\t<Target UseFPU="true">\n\t</Target>\n</Project>\n`;
    writeFileSync(lcp, original, "latin1");

    const r = switchProjectTargetToPC(lcp);
    expect("error" in r).toBe(false);
    if ("error" in r) return;
    expect(r.alreadyPc).toBe(true);
    expect(readFileSync(lcp, "latin1")).toBe(original);
  });

  it("errors when the project has no Target element", () => {
    const lcp = join(tempDir, "bad.lcp");
    writeFileSync(lcp, "<Project></Project>", "latin1");
    expect("error" in switchProjectTargetToPC(lcp)).toBe(true);
  });
});
