import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { selectProjectSchema, selectProjectHandler } from "./tools/selectProject.js";
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
  "Set the active LASAL project by its full path. All subsequent tools will operate on this project.",
  selectProjectSchema,
  selectProjectHandler
);

server.tool(
  "manage_visudesigner",
  "Open or close VISUDesigner. Use action='open' to launch it with a station file from the active project; action='close' kills the process.",
  manageVisuDesignerSchema,
  manageVisuDesignerHandler
);

server.tool(
  "manage_class2",
  "Open or close LASAL CLASS 2. Use action='open' to launch it with the active project's .lcp file; action='close' kills the process.",
  manageClass2Schema,
  manageClass2Handler
);

server.tool(
  "inspect_project",
  "Parse a LASAL CLASS 2 project (.lcp) and return a complete structural inventory: all classes with their Server/Client channels, all networks with their objects and connections. Use this before making any changes to understand what exists and how things are connected.",
  inspectProjectSchema,
  inspectProjectHandler
);

server.tool(
  "inspect_visu_project",
  "Read a VISUDesigner (.lvp) project's current state from disk: stations (connection targets), datapoints (HMI-visible PLC values with types), languages, text list names, and schemes. Use this before visu_project to understand what already exists.",
  inspectVisuProjectSchema,
  inspectVisuProjectHandler
);

server.tool(
  "class_source",
  "Read or write the source of a CLASS 2 class (.st file). Use action='read' to retrieve method implementations and variable declarations before modifying; action='write' to apply code changes back to the file. The IDE must be closed when writing; use manage_class2 with action='close' first if needed. Content must be latin1-compatible.",
  classSourceSchema,
  classSourceHandler
);

server.tool(
  "set_target_ip",
  "Change the online connection target for a station in the project's .lss file. Surgically updates only the TCPIP element, preserving all other file content. Use before build_project with action='download' when targeting a different device.",
  setTargetIpSchema,
  setTargetIpHandler
);

server.tool(
  "apply_project_changes",
  "Apply structural changes to a LASAL CLASS 2 project. Channel operations (add/remove/rename_server, add/remove/rename_client) edit .st files directly and cascade to all .lcn network files automatically. Network operations (create/delete/rename_network, add/remove/rename_object, create/delete_connection, set_init_value, delete_class) run via Lasal2.exe batch script. The IDE is killed before any changes are made.",
  applyProjectChangesSchema,
  applyProjectChangesHandler
);

server.tool(
  "build_project",
  "Compile or download a LASAL CLASS 2 project. action='compile' builds the project (kills any open CLASS 2 first, returns errors and warnings). action='download' transfers the compiled project to a PLC over the Sigmatek online protocol (TCP port 1954).",
  buildProjectSchema,
  buildProjectHandler
);

server.tool(
  "control_plc",
  "Control the runtime state of a PLC. action='start' runs the project; action='stop' halts it; action='get_state' queries the current state (e.g. Running, Stopped, Offline). Uses the project's saved connection if none is specified.",
  controlPlcSchema,
  controlPlcHandler
);

server.tool(
  "plc_values",
  "Read or write live channel values on a running PLC. action='read' fetches values for the given channels; action='write' pushes new values. Each channel is specified as 'ObjectName.ChannelName'. Opens a connection, performs all operations, then closes it.",
  plcValuesSchema,
  plcValuesHandler
);

server.tool(
  "visu_project",
  "Apply changes to or download a VISUDesigner (.lvp) project. " +
    "action='apply_changes': kills any running VISUDesigner, loads the project, runs the operations list, saves, and closes. " +
    "action='download': pushes the project to an HMI device without saving content changes. " +
    "Supported operations: update_all_stations, update_station, publish, " +
    "text list/text management (add/remove/change/set_revisions), CSV import/export for translations, " +
    "datapoint/datatype property editing, scheme management (add/remove/configure entries), " +
    "media items (images, video, audio, docs, fonts), code modules, and HMI download.",
  visuProjectSchema,
  visuProjectHandler
);

server.tool(
  "hmi_runtime",
  "Manage the local serving of the web HMI simulation. action='start' publishes, prepares files, and spawns LasalVISUDataService.exe in background. action='stop' kills the DataService. action='status' queries if it is currently running.",
  hmiRuntimeSchema,
  hmiRuntimeHandler
);

server.tool(
  "hmi_browser",
  "Drive a headless Edge browser instance to debug the running HMI simulation. Actions: open (navigates to HMI), screenshot (returns PNG image), console (gets page console/errors), eval (evaluates JS expressions to query datapoints/state), click, type, wait, close.",
  hmiBrowserSchema,
  hmiBrowserHandler
);

server.tool(
  "plc_diagnostics",
  "Perform diagnostic operations on the target PLC. action='trace' loads DataAnalyzer config, runs trace, and saves data. action='file_upload' uploads a file from PLC to host. action='file_download' downloads a file from host to PLC. action='file_delete' deletes file on PLC. action='code_analysis' performs static code analysis.",
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

## HMI Debugging Workflows
1. **Compilation and Deploy**: Use \`deploy_all\` with \`start_hmi_runtime: true\` to compile, deploy to the PLC, sync VISU stations, and start the local DataService.
2. **Launch HMI Runtime**: Use \`hmi_runtime\` action \`start\` to publish and run the HMI DataService.
3. **Debug with Browser**: Use \`hmi_browser\` action \`open\` to load the local HMI, and use \`screenshot\`, \`console\`, and \`eval\` to debug the interface.

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
  "Run the full deploy pipeline in one call: compile CLASS 2 → download to PLC → update VISUDesigner stations → optionally download visu to HMI. Each step is skipped if its flag is false. Stops immediately on any failure and reports which step failed. Use after making CLASS 2 or VISUDesigner changes to push everything to the target hardware.",
  deployAllSchema,
  deployAllHandler
);

cleanupScratch();

const transport = new StdioServerTransport();
await server.connect(transport);
