# Sigmatek LASAL MCP Server

A Model Context Protocol (MCP) server for automating the **Sigmatek LASAL** software suite. It enables AI coding assistants (like Claude, Gemini, or Cursor) to inspect projects, apply structural CLASS 2 or VISUDesigner HMI changes, compile, download to hardware, read/write live PLC values, and control PLC execution.

> **Warning:** This is NOT an official Sigmatek product. This project is in active development — bugs and unpredictable behavior are likely. **Do not use on production projects** without backups or version control.

## Features

- **Project Navigation**: Select the active project directory and auto-resolve `.lcp` and `.lvp` paths.
- **CLASS 2 Automation**:
  - Inspect project structure (classes, networks, connections, server/client channels).
  - Open and close the CLASS 2 IDE.
  - Apply structural edits (create/delete/rename networks, add/remove/rename objects, connect/disconnect channels, set init values).
  - Read and write class `.st` source files directly.
  - Compile projects and read compiler logs (errors and warnings).
- **VISUDesigner Automation**:
  - Inspect HMI projects (stations, datapoints, text lists, schemes).
  - Open and close VISUDesigner.
  - Apply changes headlessly (sync datapoints, edit properties, configure schemes, manage media assets, add code modules).
  - CSV translation import and export.
  - Direct dashboard/window/style editing via JSON.
- **PLC Runtime & Live Connection**:
  - Configure target online IP addresses.
  - Download projects to the target PLC or HMI.
  - Read and write live channel values from a running PLC.
  - Start, stop, or query the current PLC runtime state.
  - PLC diagnostics (tracing, file transfer, static code analysis).
- **HMI Simulation**:
  - Local HMI web runtime via LasalVISUDataService.
  - Headless Edge browser automation for testing.

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

| Tool | Description |
|---|---|
| `select_project` | Set the active project root directory. |
| `lasal_status` | Check project, stations, engines, processes, HMI health. |
| `manage_class2` | Open or close the CLASS 2 IDE. |
| `manage_visudesigner` | Open or close VISUDesigner. |
| `inspect_project` | Scan CLASS 2 structure (classes, networks, connections). |
| `inspect_visu_project` | Scan HMI config (stations, datapoints, schemes). |
| `class_source` | Read or write Structured Text (.st) source code. |
| `set_target_ip` | Set the target PLC/HMI IP in the .lss file. |
| `apply_project_changes` | Structural edits with transactional rollback. Supports `dry_run`. |
| `build_project` | Compile or download to PLC. |
| `control_plc` | Start, stop, or query PLC runtime state. |
| `plc_values` | Read/write live channel values on a running PLC. |
| `visu_project` | Apply VISUDesigner changes or download to HMI. |
| `visu_dashboard` | Direct read/write of dashboards, windows, styles in LVP JSON. |
| `hmi_runtime` | Start/stop local HMI web simulation (DataService). |
| `hmi_browser` | Headless Edge browser for HMI testing. |
| `plc_diagnostics` | Tracing, file transfer, static code analysis. |
| `deploy_all` | Full pipeline: compile, download, start PLC, sync visu, start HMI. |

## Development

```bash
npm run dev          # Watch mode
npm test             # Run tests (Vitest)
npm run test:watch   # Tests in watch mode
npm run lint         # ESLint
npm run format       # Prettier
npm run inspector    # MCP Inspector for interactive debugging
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codebase layout, key patterns (engine mutex, script execution, file encoding, transactional edits), and environment variable reference.
