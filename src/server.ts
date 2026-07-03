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
import { inspectProjectSchema, inspectProjectHandler } from "./tools/inspectProject.js";
import { inspectVisuProjectSchema, inspectVisuProjectHandler } from "./tools/inspectVisuProject.js";
import { classSourceSchema, classSourceHandler } from "./tools/readClassSource.js";
import { deployAllSchema, deployAllHandler } from "./tools/deployAll.js";
import { setTargetIpSchema, setTargetIpHandler } from "./tools/setTargetIp.js";
import { applyProjectChangesSchema, applyProjectChangesHandler } from "./tools/applyProjectChanges.js";
import {
  buildProjectSchema, buildProjectHandler,
  controlPlcSchema, controlPlcHandler,
  plcValuesSchema, plcValuesHandler,
} from "./tools/plcControl.js";
import { visuProjectSchema, visuProjectHandler } from "./tools/visuControl.js";
import { visuDashboardSchema, visuDashboardHandler } from "./tools/visuDashboard.js";
import { hmiRuntimeSchema, hmiRuntimeHandler } from "./tools/hmiRuntime.js";
import { hmiBrowserSchema, hmiBrowserHandler } from "./tools/hmiBrowser.js";
import { plcDiagnosticsSchema, plcDiagnosticsHandler } from "./tools/plcDiagnostics.js";
import { cleanupScratch } from "./utils/engine.js";

const server = new McpServer({
  name: "lasal-mcp",
  version: "0.1.0",
});

server.tool(
  "select_project",
  "Purpose: Set the active LASAL project by its full directory path. All subsequent tools default to using this project.\n" +
  "Prerequisites: None.\n" +
  "Result shape: { ok: true, projectDir: string }\n" +
  "Typical call order: Call first to define the active project workspace.",
  selectProjectSchema,
  selectProjectHandler
);

server.tool(
  "lasal_status",
  "Purpose: Check project selection, discover stations, verify connection settings/cabling reachability, discover engine paths, detect running processes, and report HMI health.\n" +
  "Prerequisites: None (does not spawn engines).\n" +
  "Result shape: { ok: true, project: {...}, stations: [...], engines: {...}, processes: {...}, hmiRuntime: {...}, hints: [...] }\n" +
  "Typical call order: Call first to orient, and whenever connection errors or engine lock errors are returned.",
  lasalStatusSchema,
  lasalStatusHandler
);

server.tool(
  "manage_visudesigner",
  "Purpose: Open or close the VISUDesigner GUI app.\n" +
  "Prerequisites: Requires a selected project (unless lvp_path is specified). Action 'open' launches the GUI; action 'close' kills the process (unsaved work lost).\n" +
  "Result shape: { ok: boolean, message: string }\n" +
  "Typical call order: Call when manual visual editing of LVP is required, or close before running automated batch modifications.",
  manageVisuDesignerSchema,
  manageVisuDesignerHandler
);

server.tool(
  "manage_class2",
  "Purpose: Open or close the LASAL CLASS 2 IDE GUI app.\n" +
  "Prerequisites: Requires a selected project (unless lcp_path is specified). Action 'open' launches the GUI; action 'close' kills the process (unsaved work lost).\n" +
  "Result shape: { ok: boolean, message: string }\n" +
  "Typical call order: Call when manual visual editing of the project is required, or close before compile/download batch scripts run.",
  manageClass2Schema,
  manageClass2Handler
);

server.tool(
  "inspect_project",
  "Purpose: Scan and return the structural inventory (classes, servers, clients, networks, connections) of the CLASS 2 project.\n" +
  "Prerequisites: Requires a selected project (unless lcp_path is specified). Works offline.\n" +
  "Result shape: { ok: true, project: { name, lcpPath, classFiles: [...], networkFiles: [...], classes: [...], networks: [...] } }\n" +
  "Typical call order: Call before making any project structural changes to understand what elements exist.",
  inspectProjectSchema,
  inspectProjectHandler
);

server.tool(
  "inspect_visu_project",
  "Purpose: Read and return the current LVP configuration (stations, datapoints, text lists, schemes).\n" +
  "Prerequisites: Requires a selected project (unless lvp_path is specified). Works offline.\n" +
  "Result shape: { ok: true, stations: [...], datapoints: [...] }\n" +
  "Typical call order: Call to check HMI configuration before applying visual changes or download requests.",
  inspectVisuProjectSchema,
  inspectVisuProjectHandler
);

server.tool(
  "class_source",
  "Purpose: Read or write Structured Text class source code (.st files).\n" +
  "Prerequisites: Requires a selected project. Writing requires CLASS 2 IDE to be closed. Content must be ISO-8859-1 (latin1) compatible.\n" +
  "Result shape: { ok: boolean, className: string, stPath: string, source: string, [headers] }\n" +
  "Typical call order: Read class source before modifying it, modify, and write it back.",
  classSourceSchema,
  classSourceHandler
);

server.tool(
  "set_target_ip",
  "Purpose: surgically update the TCP connection IP for a station in the station's .lss file.\n" +
  "Prerequisites: Requires a selected project. Works offline, byte-preserving.\n" +
  "Result shape: { ok: true, lssPath: string, ip: string }\n" +
  "Typical call order: Set target IP before running download or deploy tasks.",
  setTargetIpSchema,
  setTargetIpHandler
);

server.tool(
  "apply_project_changes",
  "Purpose: Apply structural modifications (variable additions, server/client channel additions, network adjustments) in transaction mode.\n" +
  "Prerequisites: Requires a selected project. Kills open CLASS 2 automatically. Direct edits (.st) and batch operations (.lcn) cannot be mixed in one call.\n" +
  "Result shape: { ok: boolean, operations: [...] }\n" +
  "Typical call order: Run after structural adjustments, then call build_project to compile.",
  applyProjectChangesSchema,
  applyProjectChangesHandler
);

server.tool(
  "build_project",
  "Purpose: Compile CLASS 2 project or download to PLC.\n" +
  "Prerequisites: Requires a selected project. Compile kills open CLASS 2. Download checks PLC reachability first, and returns PLC state. If connection is omitted, uses .lss IP and returns as ipUsed.\n" +
  "Result shape: { ok: boolean, exitCode: number, postDownloadState?: {...}, connectionUsed?: string, ipUsed?: string }\n" +
  "Typical call order: After apply_project_changes, run compile, then download.",
  buildProjectSchema,
  buildProjectHandler
);

server.tool(
  "control_plc",
  "Purpose: Control PLC runtime state (start, stop, get_state) with state verification.\n" +
  "Prerequisites: Requires a selected project. Pings target PLC. Omitted connection uses .lss IP.\n" +
  "Result shape: { ok: boolean, stateValue: number, stateName: string, connectionUsed, ipUsed }\n" +
  "Typical call order: Stop PLC before download, start it after download, and poll get_state.",
  controlPlcSchema,
  controlPlcHandler
);

server.tool(
  "plc_values",
  "Purpose: Read or write live channel values on a running PLC with channel-level verification.\n" +
  "Prerequisites: Requires a selected project. Target PLC must be running and reachable.\n" +
  "Result shape: { ok: boolean, channels: {...}, writes: {...}, failedChannels?: [...], connectionUsed, ipUsed }\n" +
  "Typical call order: Verify PLC state, then read/write values.",
  plcValuesSchema,
  plcValuesHandler
);

server.tool(
  "visu_project",
  "Purpose: Modify VISUDesigner LVP structure, or download to HMI target.\n" +
  "Prerequisites: Requires a selected project. Apply_changes kills VISUDesigner. Download pings HMI first.\n" +
  "Result shape: { ok: boolean, durationMs: number, connectionUsed?, ipUsed? }\n" +
  "Typical call order: Run apply_changes, then download, or use deploy_all.",
  visuProjectSchema,
  visuProjectHandler
);

server.tool(
  "visu_dashboard",
  "Purpose: Directly read/write dashboards, windows, composite controls, and styles in the LVP project JSON in transaction mode.\n" +
  "Prerequisites: Requires a selected project. VISUDesigner must be closed.\n" +
  "Result shape: { ok: boolean, results: [...], backups: [...] }\n" +
  "Typical call order: Modify UI panels offline before compiling and publishing.",
  visuDashboardSchema,
  visuDashboardHandler
);

server.tool(
  "hmi_runtime",
  "Purpose: Run HMI web simulation server locally using LasalVISUDataService.exe.\n" +
  "Prerequisites: Requires a selected project. Engine lock is acquired during publish. Glob-resolves the latest installed DataService version.\n" +
  "Result shape: { ok: boolean, pid: number, port: number, url: string, healthy: boolean }\n" +
  "Typical call order: Start simulation after build, then launch hmi_browser.",
  hmiRuntimeSchema,
  hmiRuntimeHandler
);

server.tool(
  "hmi_browser",
  "Purpose: Automate a headless Edge browser instance to test the HMI interface.\n" +
  "Prerequisites: Local HMI runtime must be active.\n" +
  "Result shape: { ok: boolean }\n" +
  "Typical call order: Start simulation, open browser, evaluate variables/interact, close.",
  hmiBrowserSchema,
  hmiBrowserHandler
);

server.tool(
  "plc_diagnostics",
  "Purpose: Perform diagnostic tasks (tracing, file up/down, static code analysis).\n" +
  "Prerequisites: Requires a selected project.\n" +
  "Result shape: { ok: boolean }\n" +
  "Typical call order: Use during run-time debugging.",
  plcDiagnosticsSchema,
  plcDiagnosticsHandler
);

server.resource(
  "LASAL HMI Debugging and JS API Guide",
  "lasal://guide",
  {
    description: "Guide for debugging LASAL web HMIs and using the runtime JS API",
    mimeType: "text/markdown"
  },
  async () => {
    return {
      contents: [{
        uri: "lasal://guide",
        mimeType: "text/markdown",
        text: `# LASAL HMI Debugging and JS API Guide

## Recommended Workflow
1. **Status**: Call \`lasal_status\` to see the selected project and check reachability of your PLC/HMI targets.
2. **Setup**: Call \`select_project\` with your project path, then call \`set_target_ip\` to assign correct IPs if needed.
3. **Build & Deploy**: Call \`deploy_all\` to compile class changes, download to PLC, sync stations, and run simulation.
4. **Interact**: Use \`plc_values\` to read/write live PLC tags, or start the runtime with \`hmi_runtime\` and test via \`hmi_browser\`.

## Runtime JavaScript API Cheat-sheet
Within the HMI web environment, you can interact with the runtime using the global \`sig\` or Polymer elements API.
- **Read a Datapoint**:
  \`\`\`javascript
  sig.datapoint.get('Palletizer.s_BoxWidth')
  \`\`\`
- **Write a Datapoint**:
  \`\`\`javascript
  sig.datapoint.set('Palletizer.s_BoxWidth', 150)
  \`\`\`
- **Get Active Alarms**:
  \`\`\`javascript
  sig.alarm.getActiveAlarms()
  \`\`\`
- **Read Active View/Dashboard**:
  \`\`\`javascript
  document.querySelector('sig-app').activeView
  \`\`\`
`
      }]
    };
  }
);

server.tool(
  "deploy_all",
  "Purpose: Run full deploy pipeline (compile -> download PLC -> start PLC -> verify state -> update Visu stations -> download Visu -> start HMI runtime).\n" +
  "Prerequisites: Requires selected project. Omitted connections resolve to .lss IPs. Pings targets first.\n" +
  "Result shape: { ok: boolean, steps: {...}, connections: {...} }\n" +
  "Typical call order: Call to push all local changes to the target rig in one single command.",
  deployAllSchema,
  deployAllHandler
);

cleanupScratch();

const transport = new StdioServerTransport();
await server.connect(transport);
