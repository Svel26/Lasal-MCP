#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { selectProjectSchema, selectProjectHandler } from "./tools/selectProject.js";
import { lasalStatusSchema, lasalStatusHandler } from "./tools/status.js";
import { inspectProjectSchema, inspectProjectHandler } from "./tools/inspectProject.js";
import { classSourceSchema, classSourceHandler } from "./tools/readClassSource.js";
import { setTargetIpSchema, setTargetIpHandler } from "./tools/setTargetIp.js";
import {
  manageVisuDesignerSchema,
  manageVisuDesignerHandler,
  manageClass2Schema,
  manageClass2Handler,
  manageLasalScreenSchema,
  manageLasalScreenHandler,
} from "./tools/lasalApps.js";
import { deployAllSchema, deployAllHandler } from "./tools/deployAll.js";
import { deploySolutionSchema, deploySolutionHandler } from "./tools/deploySolution.js";
import { lseProjectSchema, lseProjectHandler } from "./tools/lseProject.js";
import { applyProjectChangesSchema, applyProjectChangesHandler } from "./tools/applyProjectChanges.js";
import { runClass2ScriptSchema, runClass2ScriptHandler } from "./tools/runClass2Script.js";
import {
  buildProjectSchema,
  buildProjectHandler,
  controlPlcSchema,
  controlPlcHandler,
  plcValuesSchema,
  plcValuesHandler,
} from "./tools/plcControl.js";
import { visuProjectSchema, visuProjectHandler } from "./tools/visuControl.js";
import { hmiRuntimeSchema, hmiRuntimeHandler } from "./tools/hmiRuntime.js";
import { plcDiagnosticsSchema, plcDiagnosticsHandler } from "./tools/plcDiagnostics.js";
import { larsRuntimeSchema, larsRuntimeHandler } from "./tools/larsRuntime.js";
import { validateGuidsSchema, validateGuidsHandler } from "./tools/validateGuids.js";
import { checkJobStatusSchema, checkJobStatusHandler } from "./tools/checkJobStatus.js";
import { createBootdiskSchema, createBootdiskHandler } from "./tools/createBootdisk.js";
import { registerResources } from "./resources/registerResources.js";
import { cleanupScratch } from "./utils/engine.js";

const server = new McpServer({
  name: "lasal-mcp",
  version: "0.3.1",
});

// ─── Project management ──────────────────────────────────────────────────────

server.tool(
  "select_project",
  "Set the active LASAL project by directory path. Call first — all other tools default to this project.",
  selectProjectSchema,
  { idempotentHint: true, openWorldHint: false },
  selectProjectHandler,
);

server.tool(
  "lasal_status",
  "Check project selection, station discovery, PLC/HMI reachability, engine paths, running processes, and HMI runtime health. Call to orient or diagnose connection issues.",
  lasalStatusSchema,
  { readOnlyHint: true, idempotentHint: true },
  lasalStatusHandler,
);

server.tool(
  "check_job_status",
  "Poll the status of a background job started with async: true (build_project, deploy_all, deploy_solution, lse_project). Omit jobId to list recent jobs.",
  checkJobStatusSchema,
  { readOnlyHint: true, idempotentHint: true },
  checkJobStatusHandler,
);

server.tool(
  "inspect_project",
  "Read-only inventory of the CLASS 2 project: classes (name, channels, tasks), networks and objects, from the .lcp manifest and class sources. Use it to plan changes before apply_project_changes.",
  inspectProjectSchema,
  { readOnlyHint: true, idempotentHint: true },
  inspectProjectHandler,
);

server.tool(
  "validate_guids",
  "Scan a LASAL station project for duplicate GUID collisions and uninitialized TO_UDINT(0) placeholders in classes. " +
    "Auto-resolves duplicate GUID collisions (generating fresh GUIDs and updating MaeExp.txt/xml) and populates exact LASAL CRC32 @CT_ hashes. " +
    "Also cleans dangling network metadata.",
  validateGuidsSchema,
  { destructiveHint: true },
  validateGuidsHandler,
);

server.tool(
  "read_class_source",
  "Read or write a CLASS 2 class source (.st) by class name, with optional .h access. Writes are latin1-validated and require the CLASS 2 IDE to be closed.",
  classSourceSchema,
  { openWorldHint: false },
  classSourceHandler,
);

server.tool(
  "set_target_ip",
  "Update the target IP/port/SSL of a station in its .lss (surgical edit, other settings preserved). Use when a station moved networks; connection strings can also be passed per call.",
  setTargetIpSchema,
  { idempotentHint: true },
  setTargetIpHandler,
);

server.tool(
  "manage_class2",
  "Open or close the LASAL CLASS 2 IDE GUI. Close before running batch operations.",
  manageClass2Schema,
  { destructiveHint: true },
  manageClass2Handler,
);

server.tool(
  "manage_visudesigner",
  "Open or close the VISUDesigner GUI. Close before running automated visu operations.",
  manageVisuDesignerSchema,
  { destructiveHint: true },
  manageVisuDesignerHandler,
);

server.tool(
  "manage_lasalscreen",
  "Open or close the LASAL SCREEN (LSE) editor for .lpr screen projects. Close before running lse_project automation (releases .lpr file locks).",
  manageLasalScreenSchema,
  { destructiveHint: true },
  manageLasalScreenHandler,
);

// ─── Build, deploy, PLC control ──────────────────────────────────────────────

server.tool(
  "build_project",
  "Compile the CLASS 2 project or download it to the PLC. Compilation kills CLASS 2 IDE. Download pings the PLC first. Supports async: true (returns a jobId for check_job_status).",
  buildProjectSchema,
  { openWorldHint: true },
  buildProjectHandler,
);

server.tool(
  "create_class2_bootdisk",
  "Create a CLASS 2 bootdisk (update stick): plain bootdisk or the full Update-Tool flavor with update script, Autoexec.lsl, LasalOS image, VISUDesigner publish folder and MultiMaster Stations.txt. Platform AUTO/ALL/ARM/X86.",
  createBootdiskSchema,
  { destructiveHint: true },
  createBootdiskHandler,
);

server.tool(
  "control_plc",
  "Start, stop, or query PLC runtime state. Pings the target PLC before start/stop.",
  controlPlcSchema,
  { destructiveHint: true, openWorldHint: true },
  controlPlcHandler,
);

server.tool(
  "plc_values",
  "Read or write live channel values on a running PLC. Channels use 'ObjectName.ChannelName' format. Auto-coerces types based on ST declarations.",
  plcValuesSchema,
  { openWorldHint: true },
  plcValuesHandler,
);

server.tool(
  "apply_project_changes",
  "Run CLASS 2 batch engine operations that cannot be done by editing files directly: create/delete/rename networks, add/remove/rename objects, create/delete connections, set init values, configure tasks, compile, download. Kills CLASS 2 IDE before running.",
  applyProjectChangesSchema,
  { destructiveHint: true },
  applyProjectChangesHandler,
);

server.tool(
  "run_class2_script",
  "Escape hatch: run arbitrary Python 2.7 batch statements through Lasal2.exe (module `batch`, project `prj` in scope). Use for batch API calls not covered by apply_project_changes; the project is NOT saved automatically.",
  runClass2ScriptSchema,
  { destructiveHint: true },
  runClass2ScriptHandler,
);

server.tool(
  "plc_diagnostics",
  "Run PLC diagnostics: trace recording, file upload/download/delete on PLC, or static code analysis.",
  plcDiagnosticsSchema,
  { openWorldHint: true },
  plcDiagnosticsHandler,
);

// ─── LARS local runtime simulation ───────────────────────────────────────────

server.tool(
  "lars_runtime",
  "Manage local LARS (LASAL Runtime System) simulation instances. LARS runs one program per instance — " +
    "use one workspace per station (PLC + HMI) so both run simultaneously on separate ports. " +
    "Actions: list (auto-cleans stale workspaces), setup (create workspaces for all stations), start (auto-creates the workspace " +
    "if the station is known but unconfigured), stop, remove, gc (lazy cleanup of unreferenced workspaces), " +
    "set_station_target (point a station's .lss at its LARS instance), restore (revert .lss to the real target. " +
    "After set_station_target, build_project/control_plc/plc_values/deploy_all operate on the LARS instance automatically.",
  larsRuntimeSchema,
  { openWorldHint: true },
  larsRuntimeHandler,
);

// ─── VISUDesigner engine operations ──────────────────────────────────────────

server.tool(
  "visu_project",
  "Run VISUDesigner engine operations: update stations, publish, manage text lists/schemes/media/code modules, set datapoint properties, or download to HMI. These need the VISUDesigner engine — for direct dashboard JSON editing, edit the files in the project directly.",
  visuProjectSchema,
  { destructiveHint: true },
  visuProjectHandler,
);

// ─── LASAL SCREEN (LSE) engine operations ────────────────────────────────────

server.tool(
  "lse_project",
  "Run LASAL SCREEN (LSE) engine operations on a .lpr screen project via the LASALScreen COM automation: " +
    "info (screens/windows/servers/text lists/languages/settings inventory), create (fresh project), compile (Runtime output folder), " +
    "download to a panel (Download & Run), and apply_changes with granular operations: " +
    "merge/fuse projects, export_xml/import_xml text round-trips, import_variables (CLASS 2 references), " +
    "textlist_* translations, server_get_property/server_set_property (limits, unit, menu, state schema, hostname, …), " +
    "bulk update_buttons/update_softkeys theming, settings_set (resolution/compiler/online), image_insert. " +
    "The .lpr itself is binary — never edit it directly; use this tool or the editor. Supports async: true (returns a jobId for check_job_status).",
  lseProjectSchema,
  { destructiveHint: true, openWorldHint: true },
  lseProjectHandler,
);

// ─── Deploy pipeline ─────────────────────────────────────────────────────────

server.tool(
  "deploy_all",
  "Full deploy pipeline: compile → download PLC → start PLC → verify state → compile LASAL SCREEN (.lpr, when present) → optional SCREEN download → update Visu stations → download Visu → start HMI runtime. Each step is optional via flags. Supports async: true (returns a jobId for check_job_status).",
  deployAllSchema,
  { openWorldHint: true },
  deployAllHandler,
);

server.tool(
  "deploy_solution",
  "Multi-station deploy via MachineManager: generates a .lutc update file from the solution (class2/screen/visu downloads, OS updates, file transfers, run/boot, channel writes, CLI commands) and executes it with MachineManager.exe /update. " +
    "This is the official flow for pushing LASAL SCREEN projects together with CLASS 2 to the same panel. Use dry_run to review the generated .lutc first. Supports async: true; the newest MachineManager per-run log is returned with the result.",
  deploySolutionSchema,
  { destructiveHint: true, openWorldHint: true },
  deploySolutionHandler,
);

// ─── HMI runtime ────────────────────────────────────────────────────────────

server.tool(
  "hmi_runtime",
  "Start, stop, or check the local HMI web simulation (LasalVISUDataService). Publishes the project, copies webroot, and spawns the DataService. Returns the accessible HTTP URL (e.g. for testing via Playwright MCP or opening in a browser).",
  hmiRuntimeSchema,
  { openWorldHint: true },
  hmiRuntimeHandler,
);

const LASAL_GUIDE = `# LASAL Project Guide

## File Format Reference

All LASAL project files use **ISO-8859-1 (latin1)** encoding unless otherwise noted.

### Solution file (.lsm)
XML file at the project root. Lists all stations in the project.

\`\`\`xml
<Solution>
  <SlnStation Name="PLC">
    <StationFile Path="PLC\\PLC.lss"/>
  </SlnStation>
  <SlnStation Name="HMI">
    <StationFile Path="HMI\\HMI.lss"/>
  </SlnStation>
</Solution>
\`\`\`

### Station settings (.lss)
XML file per station. Contains connection settings and project file references.

Key elements:
- \`<OnlineConnectionInfo><TCPIP IP="10.195.0.50" PORT="1954" SSLTLS="0"/></OnlineConnectionInfo>\` — target IP for downloads
- \`<SlnProjects>\` with one or more of:
  - \`<SlnClassProject File="..\\..\\PLC.lcp"/>\` — CLASS 2 project
  - \`<SlnVISUDesignerProject File="..\\..\\HMI.lvp"/>\` — VISUDesigner (web HMI) project
  - \`<SlnScreenProject File="..\\..\\visu.lpr"/>\` — LASAL SCREEN (LSE) panel project

To change the target IP, surgically edit the \`IP\` attribute in the \`<TCPIP>\` element.
Do NOT rewrite the entire .lss — it contains other settings that must be preserved.

### CLASS 2 project (.lcp)
XML project manifest. Lists all class files and network files in the project.

\`\`\`xml
<ClassProject Version="...">
  <Header>...</Header>
  <ClassFiles>
    <File Path="Motor.st"/>
    <File Path="Sensor.st"/>
  </ClassFiles>
  <NetworkFiles>
    <File Path="Main.lcn"/>
  </NetworkFiles>
</ClassProject>
\`\`\`

Use it to discover which .st and .lcn files belong to the project.
Paths are relative to the .lcp file's directory.

### Class source (.st)
Structured Text class files. Each .st file defines one class in the CLASS 2
generated format:

1. \`//{{LSL_DECLARATION\` … \`//}}LSL_DECLARATION\` wraps the generated declaration region.
2. \`(*! <Class …> … </Class> *)\` metadata: class GUID, task flags
   (RealtimeTask/CyclicTask/BackgroundTask + DefCyclictime/DefBackground),
   \`<Channels>\` (Server/Client entries with GUIDs), optional
   \`<Dependencies><Files><File Path=".\\Class\\X\\C_X.cpp" Include="true"/></Files></Dependencies>\`,
   and the class's internal \`<Network>\` when it contains objects.
3. \`Name : CLASS … END_CLASS;\` declarations: servers \`SvrCh_*\`/\`SvrChCmd_*\`,
   clients \`CltChCmd_*\`, locals under \`//Variables:\`, methods under
   \`//Functions:\`, then \`FUNCTION @STD\` and \`FUNCTION GLOBAL TAB @CT_;\`.
4. The \`@CT_\` class table (channel table with 32-bit GUID hashes \`TO_UDINT(...)\`)
   and \`FUNCTION Name::@STD\` with \`StoreCmd\`/\`StoreMethod\` channel registrations.
5. Method bodies after \`//{{LSL_IMPLEMENTATION\`, e.g.
   \`FUNCTION VIRTUAL GLOBAL Motor::CyWork … END_FUNCTION\`.

Example skeleton:
\`\`\`
//{{LSL_DECLARATION
#include "..\\..\\Class\\Motor\\Motor.h"
(*!
<Class Name="Motor" GUID="{...}" CyclicTask="true" DefCyclictime="1 ms" SharedCommandTable="true" Objectsize="(284,120)">
  <Channels>
    <Server Name="ClassSvr" GUID="{...}" WriteProtected="true"/>
    <Server Name="s_Speed" GUID="{...}" Visualized="true" Retentive="SRam"/>
  </Channels>
</Class>
*)
Motor : CLASS
  //Servers:
  ClassSvr : SvrChCmd_DINT;
  s_Speed : SvrCh_DINT;
  //Functions:
  FUNCTION VIRTUAL GLOBAL CyWork
    VAR_INPUT EAX : UDINT; END_VAR
    VAR_OUTPUT state (EAX) : UDINT; END_VAR;
  FUNCTION @STD
    VAR_OUTPUT ret_code : CONFSTATES; END_VAR;
  FUNCTION GLOBAL TAB @CT_;
END_CLASS;
//}}LSL_DECLARATION
FUNCTION GLOBAL TAB Motor::@CT_ … END_FUNCTION
FUNCTION Motor::@STD … END_FUNCTION
//{{LSL_IMPLEMENTATION
FUNCTION VIRTUAL GLOBAL Motor::CyWork … END_FUNCTION
\`\`\`

**Server channels** (outputs): prefixed \`s_\` by convention, types \`SvrCh_DINT\`,
\`SvrCh_BOOL\`, \`SvrChCmd_DINT\`, …
**Client channels** (inputs): prefixed \`c_\` by convention, types \`CltCh_DINT\`,
\`CltChCmd_General2\` (linked to another class), …

A name must match in three places: the XML \`<Server>/<Client>\` entry, the
\`//Servers:\`/\`//Clients:\` declaration, and the \`@CT_\` table. The
\`TO_UDINT(...)\` numbers in \`@CT_\` are standard IEEE 802.3 CRC-32 hashes of the
uppercase identifier strings (e.g. \`CRC32("CLASSSVR")\`). These are generated
automatically by \`create_class\` or can be verified and populated across all
classes using the \`validate_guids\` tool. Prefer
\`apply_project_changes\` with \`create_class\` / \`add_project_file\` for new
classes, and \`read_class_source\` for edits.

When editing .st files, always use **latin1** encoding. Non-latin1 characters will corrupt the file.

### Network files (.lcn)
XML files defining object networks — instances of classes and their connections.

\`\`\`xml
<Network Name="Main">
  <Objects>
    <Object Name="Motor1" ClassName="Motor" ...>
      <InitValues>
        <InitValue Server="s_Speed" Value="50"/>
      </InitValues>
    </Object>
  </Objects>
  <Connections>
    <Connection FromObject="Sensor1" FromClient="c_MotorSpeed" ToObject="Motor1" ToServer="s_Speed"/>
  </Connections>
</Network>
\`\`\`

Network operations (create/delete networks, add/remove objects, create connections) **require the CLASS 2 batch engine** — use \`apply_project_changes\` for these.
Init values and connections reference object instances, not class definitions.

### Class header / C source (.h / .cpp)
Dependency files listed in the class \`<Dependencies>\`. A header with
\`Include="true"\` is parsed by the LASAL compiler and can expose C functions to
ST with the dual-use pattern:

\`\`\`
#ifdef cCompile
  cExtern unsigned long my_encode(void* pBuf, unsigned long maxLen);
#else
  function global __cdecl my_encode
  var_input pBuf : ^void; maxLen : udint; end_var
  var_output retcode : udint; end_var;
#endif
\`\`\`

Implement it in an accompanying \`.cpp\`; when compiled as C++ (the LASAL C
compiler treats .cpp as C++) the definition must have C linkage
(\`extern "C" { … }\`). A class's C file must NOT share the class base name — both
would emit \`<Name>.lob\` and the linker reports a redefinition; use
\`C_<Name>.cpp\` (SigCLib convention). Every dependency file must also be listed
in the .lcp \`<ClassFiles>\` (\`<HeaderFiles>\` for headers), otherwise the
compiler fails with "No file entry found".

### VISUDesigner project (.lvp)
Binary/text project manifest for the HMI side. References dashboard JSON files, datapoint configurations, text lists, schemes, and media.

### Dashboard JSON files
Located in subdirectories of the .lvp project folder. These are UTF-8 JSON files defining HMI dashboard layouts with controls, properties, and data bindings.

Dashboard files can be edited directly — they are standard JSON. Each element has:
- \`controlId\`: the control type (e.g. "sigTextField", "sigButton")
- \`name\`: unique element name within the dashboard
- Properties bound to datapoints, constants, schemes, or text references

### LASAL SCREEN project (.lpr, .lsn, .lwn, .lse)
The LASAL SCREEN editor (LSE) is the classic panel HMI engine — separate from the
web-based VISUDesigner. The \`.lpr\` project file, its screens (\`.lsn\`), windows
(\`.lwn\`) and data pools (\`.lse\`) are **binary** — never edit them with file
tools. Drive them with the \`lse_project\` tool (LASALScreen COM automation):

- \`info\` — screens, windows, servers, text lists, alarms, languages, images,
  resolutions, compiler version (read-only)
- \`compile\` — rebuilds the deployable runtime into \`<project dir>\\Runtime\`
- \`download\` — pushes to the panel (Download & Run) via the project's online settings
- \`apply_changes\` — merge/fuse projects, XML text export/import, CLASS 2 variable
  import, text-list translation edits, bulk button/softkey theming, settings, images
- \`deploy_solution\` — MachineManager \`.lutc\` flow (instruction \`DwnLdLSE\`) for
  multi-station updates
- \`manage_lasalscreen\` — open/close the editor (close before automation)

Safe-to-edit sidecars:
- \`LSEOnlineConfig.xml\` — online/download target in the project folder, same
  \`<TCPIP .../>\` schema as the station .lss; \`set_target_ip\` updates it
  automatically for stations with a \`<SlnScreenProject>\` entry

LARS renders LASAL SCREEN projects locally: \`lars_runtime setup\` wires
\`SCREEN_PRJ_PATH\` for stations with a \`.lpr\`, \`start\` opens the screen in the
LARS window, and \`lars_runtime screenshot\` returns a PNG of that window — use it
to verify screens without hardware.

XML round-trip note: \`export_xml\`/\`import_xml\` map to LSE's Text > XML Texts
feature. In LSE 01.01.197 the file-based XML export additionally requires an
export language/text-list selection that the automation interface does not expose;
if it fails with "No language selected", export once from the editor or use the
granular \`textlist_*\` operations instead.

## Recommended Workflow

1. **Orient**: Call \`lasal_status\` to check project state and connectivity.
2. **Select**: Call \`select_project\` with your project path.
3. **Inventory**: Call \`inspect_project\` to list classes, networks and objects before changing anything.
4. **Edit code**: Use \`read_class_source\` to read/write class .st sources (latin1). Use file tools for other text files.
5. **Structural changes**: Use \`apply_project_changes\` for network/object/connection operations (batch engine) and for \`create_class\`, \`add_project_file\`, \`clean_project\` (file-level).
6. **Build & Deploy**: Call \`build_project\` to compile, then \`deploy_all\` to push everything.
7. **Verify HMI**: Call \`hmi_runtime\` to start simulation, then use Playwright MCP or any browser to open the returned URL and interact. For LASAL SCREEN (.lpr) projects run them locally with \`lars_runtime\` (setup → start) and capture the rendered panel via \`lars_runtime screenshot\`.
8. **Live debug**: Use \`plc_values\` to read/write PLC channels in real time.

## HMI Runtime JavaScript API

Within the HMI web environment (e.g. via Playwright MCP or browser console):
\`\`\`javascript
// Read a datapoint
sig.datapoint.get('Motor1.s_Speed')

// Write a datapoint
sig.datapoint.set('Motor1.s_Speed', 150)

// Get active alarms
sig.alarm.getActiveAlarms()

// Get current view
document.querySelector('sig-app').activeView
\`\`\`

## Important Notes

- All .st/.lcp/.lcn/.lss files are **latin1** encoded — always read/write with latin1
- The CLASS 2 IDE must be **closed** before batch operations or .st file writes
- VISUDesigner must be **closed** before visu engine operations
- Network operations (create network, add object, create connection) **require the batch engine** — you cannot do these by editing files alone
- Dashboard JSON files **can** be edited directly — no engine needed
- After editing the .lcp manifest (adding/renaming class files), delete
  \`ProjectInternal/BrowserInfo.bin\` and \`LobInfo.bin\` (\`apply_project_changes\`
  with \`clean_project\`) — CLASS 2 caches the file list there and otherwise fails
  with "No file entry found"
- To delete a class use \`apply_project_changes\` with the batch \`delete_class\`
  operation — never delete the class folder by hand. If a folder was already
  removed manually and the linker reports \`Classtable 'X::@CT_' not found\`, run
  \`clean_project\` with \`deep: true\` (purges the generated .lcb and
  Network/ConfigObjects artifacts) and rebuild
- \`@CT_\` class tables require valid IEEE 802.3 CRC-32 hashes instead of \`TO_UDINT(0)\`.
  Use \`validate_guids\` to automatically compute missing CRC-32 hashes and resolve
  any duplicate XML GUID collisions across the station.
- C functions called from ST need C linkage (\`extern "C"\`), and a class's C file
  must not share the class name (\`C_<Name>.cpp\`)
- After any code changes, **always compile** to check for errors before deploying
`;

// ─── Prompts ─────────────────────────────────────────────────────────────────

server.prompt(
  "deploy-checklist",
  "Guided deploy: orient, compile, deploy PLC + HMI (+ LASAL SCREEN), verify.",
  {},
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "Run a careful full deployment of the selected LASAL project. Follow these steps:",
            "1. Call lasal_status and verify: selected project, stations, engine paths, LASALScreen automation registration, and target reachability.",
            "2. Call build_project compile (and lse_project compile for screen projects) and STOP if a log shows errors.",
            "3. Call deploy_all with compile:false, download_plc:true, start_plc:true, and enable the LSE/VISU steps that apply.",
            "4. Verify: control_plc get_state (expect Run, note processorArch), a sample plc_values read, and for screens lars_runtime screenshot when simulating locally.",
            "Report each step's ok/error and the exact log paths. Never ignore a failing step.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.prompt(
  "bring-up-simulation",
  "Get a station running locally via LARS without hardware (compile, download, start, screenshot).",
  {},
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "Bring up a station in local LARS simulation (no hardware):",
            "1. Call lars_runtime simulate (station or name as needed) — it creates the workspace (CLASS 2 + LASAL SCREEN), switches ARM targets to PC, compiles, downloads and starts the instance.",
            "2. If the response is not healthy, call lars_runtime list and lasal_status to diagnose (LARS window/ports).",
            "3. Call lars_runtime screenshot to verify the rendered screen visually.",
            "4. For live values: lars_runtime set_station_target first, then plc_values.",
            "Report the workspace, online port, and each step result.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.prompt("translate-visu", "Round-trip VISUDesigner text lists through CSV for translation.", {}, () => ({
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text" as const,
        text: [
          "Translate the VISUDesigner project text lists:",
          "1. visu_project apply_changes with csv_export_text_lists to a scratch CSV (optionally restrict languages).",
          "2. Edit the CSV (utf-8) to fill in the target language columns; keep IDs unchanged.",
          "3. visu_project apply_changes with csv_import_text_lists pointing at the edited CSV.",
          "4. visu_project apply_changes with publish (or download) to push, and report how many texts changed.",
        ].join("\n"),
      },
    },
  ],
}));

// ─── Resources ───────────────────────────────────────────────────────────────

registerResources(server, LASAL_GUIDE);

cleanupScratch();

const transport = new StdioServerTransport();
await server.connect(transport);
