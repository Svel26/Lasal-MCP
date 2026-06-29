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

const transport = new StdioServerTransport();
await server.connect(transport);
