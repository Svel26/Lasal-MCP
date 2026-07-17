# Sigmatek LASAL MCP Server

A Model Context Protocol (MCP) server for automating the **Sigmatek LASAL** software suite. It gives AI coding assistants (Claude, Gemini, Cursor, etc.) the ability to compile, deploy to hardware, control PLCs, read/write live values, run HMI simulations, and automate a headless browser — while the agent edits project files directly.

> **Warning:** This is NOT an official Sigmatek product. This project is in active development — bugs and unpredictable behavior are likely. **Do not use on production projects** without backups or version control.

## Design Philosophy

The MCP only exposes tools for operations that **require an external engine or hardware** — compiling, deploying, PLC control, browser automation. For everything else (reading/editing `.st`, `.lcp`, `.lcn`, `.lss`, `.lvp`, dashboard JSON), the AI agent works with the files directly using its native file tools. This keeps the tool set small, reliable, and focused.

## Features

- **Build & Deploy**: Compile CLASS 2 projects, download to PLC, full deploy pipelines.
- **PLC Control**: Start/stop PLC runtime, read/write live channel values, query state.
- **CLASS 2 Batch Engine**: Create/delete networks, add/remove objects, manage connections, configure tasks — operations that require the CLASS 2 scripting engine.
- **VISUDesigner Engine**: Sync datapoints, manage text lists/schemes/media, publish, download to HMI.
- **HMI Simulation**: Local web runtime via LasalVISUDataService with headless Edge browser automation for visual verification.
- **PLC Diagnostics**: Tracing, file transfer, static code analysis.
- **Project Guide**: Built-in resource (`lasal://guide`) documenting all LASAL file formats so the agent can edit project files directly.

## Prerequisites

- **Windows OS** (Sigmatek LASAL suite runs exclusively on Windows).
- **Node.js** v18 or higher.
- **Sigmatek LASAL Suite**:
  - **LASAL CLASS 2** (PLC engineering).
  - **VISUDesigner** (HMI design).

## Installation & Setup

```bash
git clone <repository-url>
cd Lasal-MCP
npm install
npm run build
```

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `LASAL_CLASS2_EXE` | `C:\Program Files (x86)\Sigmatek\Lasal\Class2\Bin\Lasal2.exe` | CLASS 2 IDE path |
| `LASAL_VISUDESIGNER_EXE` | `C:\Program Files\Sigmatek\Lasal\VISUDesigner\VISUDesigner.exe` | VISUDesigner path |
| `LASAL_DATASERVICE_EXE` | auto-discovered (latest version) | DataService path |
| `LASAL_EDGE_EXE` | auto-discovered | Edge browser path |
| `LASAL_MCP_TIMEOUT_COMPILE` | `600000` | Compile timeout (ms) |
| `LASAL_MCP_TIMEOUT_DOWNLOAD` | `600000` | Download timeout (ms) |
| `LASAL_MCP_TIMEOUT_VISU` | `300000` | Visu operation timeout (ms) |
| `LASAL_MCP_TIMEOUT_SCRIPT` | `120000` | Script execution timeout (ms) |
| `LASAL_MCP_HMI_DIR` | `C:\lslvisu` | Local HMI runtime directory |
| `LASAL_MCP_SCRATCH_MAX_AGE_H` | `24` | Hours before temp files are cleaned |

### Connecting to MCP Clients

#### Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lasal-mcp": {
      "command": "node",
      "args": ["C:/path/to/Lasal-MCP/dist/server.js"],
      "env": {
        "LASAL_CLASS2_EXE": "C:\\Program Files (x86)\\Sigmatek\\Lasal\\Class2\\Bin\\Lasal2.exe",
        "LASAL_VISUDESIGNER_EXE": "C:\\Program Files\\Sigmatek\\Lasal\\VISUDesigner\\VISUDesigner.exe"
      }
    }
  }
}
```

#### Claude Code

Add to `.claude/settings.json` or run `claude mcp add`:

```json
{
  "mcpServers": {
    "lasal-mcp": {
      "command": "node",
      "args": ["C:/path/to/Lasal-MCP/dist/server.js"]
    }
  }
}
```

## Available Tools

### Engine & Hardware Tools (MCP)

| Tool | Description |
|---|---|
| `select_project` | Set the active project root directory. |
| `lasal_status` | Check project, stations, engines, processes, HMI health. |
| `manage_class2` | Open or close the CLASS 2 IDE. |
| `manage_visudesigner` | Open or close VISUDesigner. |
| `build_project` | Compile or download to PLC. |
| `control_plc` | Start, stop, or query PLC runtime state. |
| `plc_values` | Read/write live channel values on a running PLC. |
| `apply_project_changes` | CLASS 2 batch engine operations (networks, objects, connections, tasks). |
| `visu_project` | VISUDesigner engine operations (text lists, schemes, media, publish, download). |
| `hmi_runtime` | Start/stop local HMI web simulation (DataService). |
| `hmi_browser` | Headless Edge browser for HMI testing and screenshots. |
| `plc_diagnostics` | Tracing, file transfer, static code analysis. |
| `deploy_all` | Full pipeline: compile → download → start PLC → sync visu → start HMI. |

### Direct File Editing (no MCP needed)

The agent edits these files directly with its native file tools:

| File | Format | Encoding | What it contains |
|---|---|---|---|
| `.lsm` | XML | latin1 | Solution — lists all stations |
| `.lss` | XML | latin1 | Station settings — target IP, project references |
| `.lcp` | XML | latin1 | CLASS 2 project manifest — class and network file paths |
| `.st` | XML + ST | latin1 | Class source — XML header + Structured Text body |
| `.lcn` | XML | latin1 | Network definitions — objects, connections, init values |
| `.lvp` | Mixed | utf-8 | VISUDesigner project manifest |
| Dashboard JSON | JSON | utf-8 | HMI dashboards, windows, controls, property bindings |

See the built-in `lasal://guide` resource for detailed file format documentation.

## Development

```bash
npm run dev          # Watch mode
npm test             # Run tests (Vitest)
npm run test:watch   # Tests in watch mode
npm run lint         # ESLint
npm run format       # Prettier
npm run inspector    # MCP Inspector for interactive debugging
```
