import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  cloneLarsWorkspace,
  createLarsWorkspace,
  extractWorkspaceBlock,
  mergeLarsConfigRaw,
  parseLarsConfig,
  readLarsConfigRaw,
  readLarsWorkspaces,
  validateLarsWorkspaces,
  writeLarsConfigRaw,
} from "../src/utils/lars.js";
import { executeAction } from "../src/core/actions/executor.js";
import { createPilotRegistry } from "../src/core/actions/pilotCatalog.js";
import { domainsForProfile } from "../src/core/actions/profiles.js";

const CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
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
\t\t\t<ONLINE>1954</ONLINE>
\t\t\t<COMLINK_SRVR>1955</COMLINK_SRVR>
\t\t\t<COMLINK>1000</COMLINK>
\t\t\t<ALARM>1957</ALARM>
\t\t\t<DATASERVICETCPPORT>2402</DATASERVICETCPPORT>
\t\t</COMTCP>
\t\t<WINDOW_SETTINGS>
\t\t\t<TITLE>DEFAULT</TITLE>
\t\t</WINDOW_SETTINGS>
\t\t<RESOLUTION></RESOLUTION>
\t\t<DRIVEMAP>
\t\t\t<DRIVEMAP_ELEMENT>
\t\t\t\t<DRIVE>C:</DRIVE>
\t\t\t\t<PATH>C:\\Lars</PATH>
\t\t\t</DRIVEMAP_ELEMENT>
\t\t</DRIVEMAP>
\t\t<IP_MAP></IP_MAP>
\t</WORKSPACE>
</LARSCONFIGURATIONS>
`;

describe("LARS config parity", () => {
  let tempDir: string;
  let configPath: string;

  const setConfig = (content: string) => {
    writeFileSync(configPath, content, "utf-8");
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lasal-mcp-lars-parity-"));
    configPath = join(tempDir, "lasalos2.xml");
    process.env.LASAL_LARS_CONFIG = configPath;
    process.env.LOCALAPPDATA = join(tempDir, "appdata");
    process.env.LASAL_MCP_STATE_FILE = join(tempDir, "state.json");
    setConfig(CONFIG);
  });

  afterEach(() => {
    delete process.env.LASAL_LARS_CONFIG;
    delete process.env.LOCALAPPDATA;
    delete process.env.LASAL_MCP_STATE_FILE;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses config version, workspaces and unknown elements", () => {
    const parsed = parseLarsConfig(readLarsConfigRaw()!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.configVersion).toBe("2");
    expect(parsed.config.workspaceNames).toEqual(["DEFAULT"]);
    expect(parsed.config.unknownElements).toContainEqual({
      workspace: "DEFAULT",
      element: "WINDOW_SETTINGS",
    });
  });

  it("rejects duplicate names/ports/data roots and warns on missing screen projects", () => {
    const [ws] = readLarsWorkspaces();
    const validation = validateLarsWorkspaces([
      ws!,
      { ...ws!, name: "SECOND", dataRoot: ws!.dataRoot?.toLowerCase(), screenProjectPath: "C:\\missing\\x.lpr" },
    ]);
    expect(validation.errors.join("\n")).toContain("Port 1954");
    expect(validation.errors.join("\n")).toContain("dataRoot");
    expect(validation.warnings.join("\n")).toContain("screen project not found");
  });

  it("creates a workspace with fresh ports and an isolated data root", () => {
    const result = createLarsWorkspace("NEW_PLC");
    expect(result.error).toBeUndefined();
    expect(result.workspace?.onlinePort).toBe(1964);
    expect(result.workspace?.dataServiceTcpPort).toBe(2412);
    expect(result.workspace?.dataRoot).toContain(join("lasal-mcp", "lars", "NEW_PLC"));
    expect(readLarsWorkspaces().map((workspace) => workspace.name)).toEqual(["DEFAULT", "NEW_PLC"]);
    expect(readFileSync(configPath, "utf-8")).toContain("<GLOBAL_NOTE>keep me</GLOBAL_NOTE>");
    expect(readFileSync(configPath, "utf-8")).toContain("<WINDOW_SETTINGS>");
  });

  it("refuses duplicate names and conflicting explicit ports", () => {
    expect(createLarsWorkspace("DEFAULT").error).toContain("already exists");
    const conflict = createLarsWorkspace("NEW_PLC", { onlinePort: 1954 });
    expect(conflict.error).toContain("1954");
    expect(readLarsWorkspaces()).toHaveLength(1);
  });

  it("clones a workspace without reusing ports or the source data root", () => {
    const result = cloneLarsWorkspace("DEFAULT", "DEFAULT_COPY");
    expect(result.error).toBeUndefined();
    expect(result.workspace?.onlinePort).toBe(1964);
    expect(result.workspace?.dataRoot).not.toBe("C:\\Lars");
    expect(result.workspace?.driveMaps).toContainEqual({
      drive: "C:",
      path: result.workspace?.dataRoot,
    });
    expect(readLarsWorkspaces()).toHaveLength(2);
  });

  it("merges and replaces raw workspace blocks while preserving foreign content", () => {
    const imported = CONFIG.replace('Name="DEFAULT"', 'Name="IMPORTED"').replace(
      "<ONLINE>1954</ONLINE>",
      "<ONLINE>2974</ONLINE>",
    );
    const merged = mergeLarsConfigRaw(CONFIG, imported);
    expect("error" in merged).toBe(false);
    if ("error" in merged) return;
    expect(merged.added).toEqual(["IMPORTED"]);
    expect(merged.xml).toContain("<GLOBAL_NOTE>keep me</GLOBAL_NOTE>");
    expect(merged.xml).toContain('Name="DEFAULT"');
    expect(merged.xml).toContain('Name="IMPORTED"');
  });

  it("writes a raw config atomically and keeps a backup", () => {
    const replacement = CONFIG.replace("keep me", "changed");
    const write = writeLarsConfigRaw(replacement);
    expect(write.backupPath).toBe(`${configPath}.bak`);
    expect(existsSync(write.backupPath!)).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("changed");
  });

  it("executes workspace create, export and merge-import through the catalog", async () => {
    const registry = createPilotRegistry();
    const options = {
      domains: domainsForProfile("lars"),
      allowExpert: false,
      allowDestructive: true,
      audit: false,
    };

    const created = await executeAction(
      registry,
      { action: "lars.workspace.create", params: { name: "CATALOG_PLC" } },
      options,
    );
    expect(created.ok).toBe(true);
    expect((created.result as { workspace: { name: string } }).workspace.name).toBe("CATALOG_PLC");

    const exported = await executeAction(
      registry,
      {
        action: "lars.workspace.export",
        params: { format: "xml", output_path: join(tempDir, "export.xml") },
      },
      options,
    );
    expect(exported.ok).toBe(true);
    expect(readFileSync(join(tempDir, "export.xml"), "utf-8")).toContain("CATALOG_PLC");

    const importedPath = join(tempDir, "import.xml");
    writeFileSync(
      importedPath,
      CONFIG.replace('Name="DEFAULT"', 'Name="IMPORTED_PLC"')
        .replace("<ONLINE>1954</ONLINE>", "<ONLINE>2974</ONLINE>")
        .replace("<COMLINK_SRVR>1955</COMLINK_SRVR>", "<COMLINK_SRVR>2975</COMLINK_SRVR>")
        .replace("<COMLINK>1000</COMLINK>", "<COMLINK>2000</COMLINK>")
        .replace("<ALARM>1957</ALARM>", "<ALARM>2977</ALARM>")
        .replace("<DATASERVICETCPPORT>2402</DATASERVICETCPPORT>", "<DATASERVICETCPPORT>3412</DATASERVICETCPPORT>")
        .replace("<PATH>C:\\Lars</PATH>", "<PATH>C:\\ImportedLars</PATH>"),
      "utf-8",
    );
    const imported = await executeAction(
      registry,
      { action: "lars.workspace.import", params: { input_path: importedPath } },
      options,
    );
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    expect((imported.result as { added: string[] }).added).toEqual(["IMPORTED_PLC"]);
    expect(readLarsWorkspaces().map((workspace) => workspace.name)).toContain("IMPORTED_PLC");
  });

  it("requires confirm for a full config replace", async () => {
    const registry = createPilotRegistry();
    const response = await executeAction(
      registry,
      {
        action: "lars.workspace.import",
        params: { input_path: join(tempDir, "missing.xml"), mode: "replace" },
      },
      { domains: domainsForProfile("lars"), allowExpert: false, allowDestructive: true, audit: false },
    );
    // Missing input wins over the confirmation check; create one to exercise the gate.
    expect(response.ok).toBe(false);
    const input = join(tempDir, "replace.xml");
    writeFileSync(input, CONFIG, "utf-8");
    const gated = await executeAction(
      registry,
      { action: "lars.workspace.import", params: { input_path: input, mode: "replace" } },
      { domains: domainsForProfile("lars"), allowExpert: false, allowDestructive: true, audit: false },
    );
    expect(gated.ok).toBe(false);
    expect(gated.code).toBe("CONFIRM_REQUIRED");
  });

  it("extracts one workspace block and wraps it as valid standalone XML", () => {
    const block = extractWorkspaceBlock(CONFIG, "DEFAULT");
    expect(block).toContain('Name="DEFAULT"');
    expect(block).not.toContain("GLOBAL_NOTE");
    expect(block).not.toContain("</LARSCONFIGURATIONS>");
  });
});
