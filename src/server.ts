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
    "Supports: update_all_stations, text list/text management (add/remove/change), CSV import/export for translations, " +
    "datapoint/datatype property editing, scheme management (add/remove/configure entries), " +
    "media items (images, video, audio, docs, fonts), code modules, and HMI download. " +
    "The 'update_all_stations' operation should be run after CLASS 2 channel changes to sync datapoints into the VISUDesigner project.",
  applyVisuChangesSchema,
  applyVisuChangesHandler
);

server.tool(
  "download_visu_project",
  "Download a VISUDesigner (.lvp) project to an HMI device. Does not save the project — use apply_visu_changes with a 'download' operation if you need to make changes and deploy in one step.",
  downloadVisuProjectSchema,
  downloadVisuProjectHandler
);

const transport = new StdioServerTransport();
await server.connect(transport);
