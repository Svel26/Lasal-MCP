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

const transport = new StdioServerTransport();
await server.connect(transport);
