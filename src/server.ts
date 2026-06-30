import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { selectProjectSchema, selectProjectHandler } from "./tools/selectProject.js";
import {
  openVisuDesignerSchema,
  openVisuDesignerHandler,
  closeVisuDesignerSchema,
  closeVisuDesignerHandler,
  openClass2Schema,
  openClass2Handler,
  closeClass2Schema,
  closeClass2Handler,
} from "./tools/lasalApps.js";
import { inspectProjectSchema, inspectProjectHandler } from "./tools/inspectProject.js";
import { inspectVisuProjectSchema, inspectVisuProjectHandler } from "./tools/inspectVisuProject.js";
import { readClassSourceSchema, readClassSourceHandler } from "./tools/readClassSource.js";
import { writeClassSourceSchema, writeClassSourceHandler } from "./tools/writeClassSource.js";
import { deployAllSchema, deployAllHandler } from "./tools/deployAll.js";
import { setTargetIpSchema, setTargetIpHandler } from "./tools/setTargetIp.js";
import { applyProjectChangesSchema, applyProjectChangesHandler } from "./tools/applyProjectChanges.js";
import {
  compileProjSchema, compileProjHandler,
  downloadProjSchema, downloadProjHandler,
  getPlcStateSchema, getPlcStateHandler,
  readPlcValuesSchema, readPlcValuesHandler,
  writePlcValuesSchema, writePlcValuesHandler,
} from "./tools/plcControl.js";
import {
  applyVisuChangesSchema, applyVisuChangesHandler,
  downloadVisuProjectSchema, downloadVisuProjectHandler,
} from "./tools/visuControl.js";

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
  "open_visudesigner",
  "Open VISUDesigner with a station from the active project. Omit lcp_path to see available stations.",
  openVisuDesignerSchema,
  openVisuDesignerHandler
);

server.tool(
  "close_visudesigner",
  "Close VISUDesigner (kills the process).",
  closeVisuDesignerSchema,
  closeVisuDesignerHandler
);

server.tool(
  "open_class2",
  "Open LASAL CLASS 2 with the active project's .lsm file.",
  openClass2Schema,
  openClass2Handler
);

server.tool(
  "close_class2",
  "Close LASAL CLASS 2 (kills the process).",
  closeClass2Schema,
  closeClass2Handler
);

server.tool(
  "inspect_project",
  "Parse a LASAL CLASS 2 project (.lcp) and return a complete structural inventory: all classes with their Server/Client channels, all networks with their objects and connections. Use this before making any changes to understand what exists and how things are connected.",
  inspectProjectSchema,
  inspectProjectHandler
);

server.tool(
  "inspect_visu_project",
  "Read a VISUDesigner (.lvp) project's current state from disk: stations (connection targets), datapoints (HMI-visible PLC values with types), languages, text list names, and schemes. Use this before apply_visu_changes to understand what already exists.",
  inspectVisuProjectSchema,
  inspectVisuProjectHandler
);

server.tool(
  "read_class_source",
  "Return the full source of a CLASS 2 class (.st file). Use this to read method implementations, variable declarations, and logic before modifying a class.",
  readClassSourceSchema,
  readClassSourceHandler
);

server.tool(
  "write_class_source",
  "Write the full source of a CLASS 2 class back to its .st file (and optionally its .h header). Use this after read_class_source to apply code changes — method bodies, variable declarations, logic — directly to the file. The IDE must be closed; use close_class2 first if needed. Content must be latin1-compatible.",
  writeClassSourceSchema,
  writeClassSourceHandler
);

server.tool(
  "set_target_ip",
  "Change the online connection target for a station in the project's .lss file. Surgically updates only the TCPIP element, preserving all other file content. Use before compile_project / download_project when targeting a different device.",
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
  "compile_project",
  "Compile the active LASAL CLASS 2 project. Kills any open CLASS 2 instance first. Returns compiler errors and warnings from the log.",
  compileProjSchema,
  compileProjHandler
);

server.tool(
  "download_project",
  "Download the compiled CLASS 2 project to a PLC over the Sigmatek online protocol (TCP port 1954). Uses the project's saved connection if none is specified.",
  downloadProjSchema,
  downloadProjHandler
);

server.tool(
  "get_plc_state",
  "Query the runtime state of a PLC (e.g. Running, Stopped, Offline). Uses the project's saved connection if none is specified.",
  getPlcStateSchema,
  getPlcStateHandler
);

server.tool(
  "read_plc_values",
  "Read live channel values from a running PLC. Opens a connection, reads all requested channels, then closes the connection. Each channel is specified as 'ObjectName.ChannelName'.",
  readPlcValuesSchema,
  readPlcValuesHandler
);

server.tool(
  "write_plc_values",
  "Write values to channels on a running PLC. Opens a connection, writes all values, then closes the connection. Each channel is specified as 'ObjectName.ChannelName'.",
  writePlcValuesSchema,
  writePlcValuesHandler
);

server.tool(
  "apply_visu_changes",
  "Apply changes to a VISUDesigner (.lvp) project using the headless VISUDesigner API. " +
    "Kills any running VISUDesigner first, runs the operations as a Python 3.12 script, then saves and closes. " +
    "Supports: update_all_stations, update_station (single station by number), publish, " +
    "text list/text management (add/remove/change/set_revisions), CSV import/export for translations, " +
    "datapoint/datatype property editing, scheme management (add/remove/configure entries), " +
    "media items (images, video, audio, docs, fonts), code modules, and HMI download. " +
    "Run 'update_all_stations' or 'update_station' after CLASS 2 channel changes to sync datapoints into the VISUDesigner project.",
  applyVisuChangesSchema,
  applyVisuChangesHandler
);

server.tool(
  "download_visu_project",
  "Download a VISUDesigner (.lvp) project to an HMI device. Does not save the project — use apply_visu_changes with a 'download' operation if you need to make changes and deploy in one step.",
  downloadVisuProjectSchema,
  downloadVisuProjectHandler
);

server.tool(
  "deploy_all",
  "Run the full deploy pipeline in one call: compile CLASS 2 → download to PLC → update VISUDesigner stations → optionally download visu to HMI. Each step is skipped if its flag is false. Stops immediately on any failure and reports which step failed. Use after making CLASS 2 or VISUDesigner changes to push everything to the target hardware.",
  deployAllSchema,
  deployAllHandler
);

const transport = new StdioServerTransport();
await server.connect(transport);
