import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { selectProjectSchema, selectProjectHandler } from "./tools/selectProject.js";
import { lasalStatusSchema, lasalStatusHandler } from "./tools/status.js";
import {
  manageVisuDesignerSchema,
  manageVisuDesignerHandler,
  manageClass2Schema,
  manageClass2Handler,
} from "./tools/lasalApps.js";
import { deployAllSchema, deployAllHandler } from "./tools/deployAll.js";
import { applyProjectChangesSchema, applyProjectChangesHandler } from "./tools/applyProjectChanges.js";
import {
  buildProjectSchema, buildProjectHandler,
  controlPlcSchema, controlPlcHandler,
  plcValuesSchema, plcValuesHandler,
} from "./tools/plcControl.js";
import { visuProjectSchema, visuProjectHandler } from "./tools/visuControl.js";
import { hmiRuntimeSchema, hmiRuntimeHandler } from "./tools/hmiRuntime.js";
import { hmiBrowserSchema, hmiBrowserHandler } from "./tools/hmiBrowser.js";
import { plcDiagnosticsSchema, plcDiagnosticsHandler } from "./tools/plcDiagnostics.js";
import { cleanupScratch } from "./utils/engine.js";

const server = new McpServer({
  name: "lasal-mcp",
  version: "0.2.0",
});

// ─── Project management ──────────────────────────────────────────────────────

server.tool(
  "select_project",
  "Set the active LASAL project by directory path. Call first — all other tools default to this project.",
  selectProjectSchema,
  selectProjectHandler
);

server.tool(
  "lasal_status",
  "Check project selection, station discovery, PLC/HMI reachability, engine paths, running processes, and HMI runtime health. Call to orient or diagnose connection issues.",
  lasalStatusSchema,
  lasalStatusHandler
);

server.tool(
  "manage_class2",
  "Open or close the LASAL CLASS 2 IDE GUI. Close before running batch operations.",
  manageClass2Schema,
  manageClass2Handler
);

server.tool(
  "manage_visudesigner",
  "Open or close the VISUDesigner GUI. Close before running automated visu operations.",
  manageVisuDesignerSchema,
  manageVisuDesignerHandler
);

// ─── Build, deploy, PLC control ──────────────────────────────────────────────

server.tool(
  "build_project",
  "Compile the CLASS 2 project or download it to the PLC. Compilation kills CLASS 2 IDE. Download pings the PLC first.",
  buildProjectSchema,
  buildProjectHandler
);

server.tool(
  "control_plc",
  "Start, stop, or query PLC runtime state. Pings the target PLC before start/stop.",
  controlPlcSchema,
  controlPlcHandler
);

server.tool(
  "plc_values",
  "Read or write live channel values on a running PLC. Channels use 'ObjectName.ChannelName' format. Auto-coerces types based on ST declarations.",
  plcValuesSchema,
  plcValuesHandler
);

server.tool(
  "apply_project_changes",
  "Run CLASS 2 batch engine operations that cannot be done by editing files directly: create/delete/rename networks, add/remove/rename objects, create/delete connections, set init values, configure tasks, compile, download. Kills CLASS 2 IDE before running.",
  applyProjectChangesSchema,
  applyProjectChangesHandler
);

server.tool(
  "plc_diagnostics",
  "Run PLC diagnostics: trace recording, file upload/download/delete on PLC, or static code analysis.",
  plcDiagnosticsSchema,
  plcDiagnosticsHandler
);

// ─── VISUDesigner engine operations ──────────────────────────────────────────

server.tool(
  "visu_project",
  "Run VISUDesigner engine operations: update stations, publish, manage text lists/schemes/media/code modules, set datapoint properties, or download to HMI. These need the VISUDesigner engine — for direct dashboard JSON editing, edit the files in the project directly.",
  visuProjectSchema,
  visuProjectHandler
);

// ─── Deploy pipeline ─────────────────────────────────────────────────────────

server.tool(
  "deploy_all",
  "Full deploy pipeline: compile → download PLC → start PLC → verify state → update Visu stations → download Visu → start HMI runtime. Each step is optional via flags.",
  deployAllSchema,
  deployAllHandler
);

// ─── HMI runtime & browser ──────────────────────────────────────────────────

server.tool(
  "hmi_runtime",
  "Start, stop, or check the local HMI web simulation (LasalVISUDataService). Publishes the project, copies webroot, and spawns the DataService. Use hmi_browser to interact with it afterwards.",
  hmiRuntimeSchema,
  hmiRuntimeHandler
);

server.tool(
  "hmi_browser",
  "Automate a headless Edge browser to test the HMI. Actions: open (navigate), screenshot (capture viewport or element), console (read logs/errors), eval (run JS), click, type, wait, close. ALWAYS use this after deploy to visually verify the HMI works.",
  hmiBrowserSchema,
  hmiBrowserHandler
);

// ─── Resource: LASAL file format guide ───────────────────────────────────────

server.resource(
  "LASAL Project Guide",
  "lasal://guide",
  {
    description: "Complete guide to LASAL file formats, file editing, HMI debugging, and the runtime JS API",
    mimeType: "text/markdown"
  },
  async () => {
    return {
      contents: [{
        uri: "lasal://guide",
        mimeType: "text/markdown",
        text: LASAL_GUIDE,
      }]
    };
  }
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
- \`<TCPIP IP="10.195.0.50" PORT="1954" SSLTLS="0"/>\` — target IP for downloads
- \`<ClassProject Path="PLC.lcp"/>\` — link to the CLASS 2 project
- \`<VisualProject Path="HMI.lvp"/>\` — link to the VISUDesigner project

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
Structured Text class files. Each .st file defines one class. The format has two parts:

1. **XML header block** (between \`(* BEGIN_CLASS ... END_CLASS *)\` comment markers):
   Contains class metadata — servers, clients, methods, inheritance.

2. **ST body**: Variable declarations and method implementations in IEC 61131-3 Structured Text.

Example structure:
\`\`\`
(* BEGIN_CLASS
<ClassDef Name="Motor" SuperClass="UserDef0" ...>
  <Servers>
    <Server Name="s_Speed" ... />
  </Servers>
  <Clients>
    <Client Name="c_Enable" ... />
  </Clients>
  <Methods>
    <Method Name="CyWork" ... />
  </Methods>
</ClassDef>
END_CLASS *)

//Variables:
  s_Speed : SvrCh_DINT;
  c_Enable : CltCh_BOOL;
  localVar : DINT;

//Methods:
FUNCTION Motor::CyWork
  IF c_Enable THEN
    s_Speed := 100;
  END_IF;
END_FUNCTION
\`\`\`

**Server channels** (outputs): Prefixed \`s_\` by convention. Types like \`SvrCh_DINT\`, \`SvrCh_BOOL\`, \`SvrCh_REAL\`.
**Client channels** (inputs): Prefixed \`c_\` by convention. Types like \`CltCh_DINT\`, \`CltChCmd_General2\`.

When adding a server/client:
1. Add the XML element in the header block (\`<Server>\` or \`<Client>\`)
2. Add the variable declaration in the \`//Variables:\` section
3. Both must match in name

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

### Class header (.h)
Auto-generated companion to .st files. Contains C-like declarations. Usually read-only — changes are made to .st files.

### VISUDesigner project (.lvp)
Binary/text project manifest for the HMI side. References dashboard JSON files, datapoint configurations, text lists, schemes, and media.

### Dashboard JSON files
Located in subdirectories of the .lvp project folder. These are UTF-8 JSON files defining HMI dashboard layouts with controls, properties, and data bindings.

Dashboard files can be edited directly — they are standard JSON. Each element has:
- \`controlId\`: the control type (e.g. "sigTextField", "sigButton")
- \`name\`: unique element name within the dashboard
- Properties bound to datapoints, constants, schemes, or text references

## Recommended Workflow

1. **Orient**: Call \`lasal_status\` to check project state and connectivity.
2. **Select**: Call \`select_project\` with your project path.
3. **Edit code**: Read and edit .st files directly using file tools. Use latin1 encoding.
4. **Structural changes**: Use \`apply_project_changes\` for network/object/connection operations that need the CLASS 2 engine.
5. **Build & Deploy**: Call \`build_project\` to compile, then \`deploy_all\` to push everything.
6. **Verify HMI**: Call \`hmi_runtime\` to start simulation, then \`hmi_browser\` to open, screenshot, and interact.
7. **Live debug**: Use \`plc_values\` to read/write PLC channels in real time.

## HMI Runtime JavaScript API

Within the HMI web environment (via \`hmi_browser\` eval):
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
- After any code changes, **always compile** to check for errors before deploying
`;

cleanupScratch();

const transport = new StdioServerTransport();
await server.connect(transport);
