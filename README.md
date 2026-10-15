# Sigmatek LASAL MCP Server

[![CI](https://github.com/Svel26/Lasal-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Svel26/Lasal-MCP/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/lasal-mcp.svg)](https://www.npmjs.com/package/lasal-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A Model Context Protocol (MCP) server for automating the **Sigmatek LASAL** software suite. It gives AI coding assistants (Claude, Gemini, Cursor, etc.) the ability to compile, deploy to hardware, control PLCs, read/write live values, run HMI simulations, and validate project GUIDs — while the agent edits project files directly.

> **Warning:** This is NOT an official Sigmatek product. This project is in active development — bugs and unpredictable behavior are likely. **Do not use on production projects** without backups or version control.

## Design Philosophy

The MCP only exposes tools for operations that **require an external engine or hardware** — compiling, deploying, PLC control, LARS soft-runtime simulations — plus the class/manifest operations whose generated formats and caches make raw file edits error-prone (creating a class, registering project files, latin1-safe class source access, resolving GUID collisions). For everything else (reading/editing `.lcp`, `.lcn`, `.lss`, `.lvp`, dashboard JSON), the AI agent works with the files directly using its native file tools. This keeps the tool set small, reliable, and focused.

## Features

- **Build & Deploy**: Compile CLASS 2 projects, download to PLC, full deploy pipelines (`build_project`, `deploy_all`).
- **Multi-Station Deploy**: MachineManager `.lutc` orchestration — CLASS 2, LASAL SCREEN and VISUDesigner downloads, OS updates, file transfer, run/boot, channel writes, CLI commands (`deploy_solution`).
- **PLC Control**: Start/stop PLC runtime, read/write live channel values, query state (`control_plc`, `plc_values`).
- **Local Simulation (LARS)**: Run one LASAL program per LARS instance — one workspace per station (PLC + HMI) so both run simultaneously on separate ports. Point stations at the local runtime with a single call, compile/download/start/read values exactly like a real PLC, and browse the HMI via DataService. LARS also renders LASAL SCREEN projects locally, with window screenshots for visual verification. No hardware needed (`lars_runtime`).
- **CLASS 2 Batch Engine**: Create/delete networks, add/remove objects, manage connections, configure tasks — operations that require the CLASS 2 scripting engine (`apply_project_changes`, `run_class2_script`).
- **GUID & CRC-32 Validation**: Auto-resolve duplicate GUID collisions across classes/MaeExp.txt and compute exact IEEE 802.3 CRC-32 hashes for `@CT_` tables (`validate_guids`).
- **VISUDesigner Engine**: Sync datapoints, manage text lists/schemes/media, publish, download to HMI (`visu_project`).
- **LASAL SCREEN (LSE) Engine**: Drive classic panel HMI `.lpr` projects via the LASALScreen COM automation — inventory, compile, download, merge/fuse, text-list translation edits, variable import from CLASS 2, bulk theming, settings (`lse_project`).
- **HMI Simulation**: Local web runtime via LasalVISUDataService returning accessible HTTP URLs for browser inspection or external Playwright MCP testing (`hmi_runtime`).
- **PLC Diagnostics**: Tracing, file transfer, static code analysis (`plc_diagnostics`).
- **MCP Resources**: Built-in resources for file documentation (`lasal://guide`), live project status (`lasal://project/status`), active stations (`lasal://stations`), and class sources (`lasal://classes/{className}`).
- **Autocompletions**: Context-aware MCP completions for class names and station names.

## Prerequisites

- **Windows OS** (Sigmatek LASAL suite runs exclusively on Windows).
- **Node.js** v18 or higher.
- **Sigmatek LASAL Suite**:
  - **LASAL CLASS 2** (PLC engineering).
  - **VISUDesigner** (web HMI design).
  - **LASAL SCREEN** (LSE, classic panel HMI design — required for `lse_project`).
  - **MachineManager** (optional — required for `deploy_solution`).

## Quick Start (with `npx`)

No repository clone or build required — configure your favorite MCP client to run directly via `npx`:

### Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lasal-mcp": {
      "command": "npx",
      "args": ["-y", "lasal-mcp"]
    }
  }
}
```

### Cursor

Add to your project's `.cursor/mcp.json` (or global Cursor MCP settings):

```json
{
  "mcpServers": {
    "lasal-mcp": {
      "command": "npx",
      "args": ["-y", "lasal-mcp"]
    }
  }
}
```

### Claude Code

Run:

```bash
claude mcp add lasal-mcp npx -y lasal-mcp
```

---

## Local Installation & Setup (for Developers)

```bash
git clone https://github.com/Svel26/Lasal-MCP.git
cd Lasal-MCP
npm install
npm run build
```

When running from a local clone, point your MCP client to:

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

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `LASAL_CLASS2_EXE` | `C:\Program Files (x86)\Sigmatek\Lasal\Class2\Bin\Lasal2.exe` | CLASS 2 IDE path |
| `LASAL_VISUDESIGNER_EXE` | `C:\Program Files\Sigmatek\Lasal\VISUDesigner\VISUDesigner.exe` | VISUDesigner path |
| `LASAL_SCREEN_EXE` | `C:\Program Files (x86)\Sigmatek\Lasal\Screen\LSE_modeless.exe` | LASAL SCREEN (LSE) editor / COM automation server path |
| `LASAL_MACHINEMANAGER_EXE` | `C:\Program Files (x86)\Sigmatek\Lasal\MachineManager\Bin\MachineManager.exe` | MachineManager path |
| `LASAL_DATASERVICE_EXE` | auto-discovered (latest version) | DataService path |
| `LASAL_MCP_TIMEOUT_COMPILE` | `600000` | Compile timeout (ms) |
| `LASAL_MCP_TIMEOUT_DOWNLOAD` | `600000` | Download timeout (ms) |
| `LASAL_MCP_TIMEOUT_VISU` | `300000` | Visu operation timeout (ms) |
| `LASAL_MCP_TIMEOUT_SCRIPT` | `120000` | Script execution timeout (ms) |
| `LASAL_MCP_TIMEOUT_LSE` | `300000` | LASAL SCREEN operation timeout (ms) |
| `LASAL_MCP_TIMEOUT_MM` | `900000` | MachineManager update timeout (ms) |
| `LASAL_LARS_EXE` | `C:\Program Files (x86)\Sigmatek\Lars\Lars.exe` | LARS runtime path |
| `LASAL_LARS_CONFIG` | `%APPDATA%\lasalos2.xml` | LARS workspace config file |
| `LASAL_MCP_HMI_DIR` | `C:\lslvisu` | Local HMI runtime directory |
| `LASAL_MCP_SCRATCH_MAX_AGE_H` | `24` | Hours before temp files are cleaned |

## Available Tools

### Engine & Hardware Tools (MCP)

| Tool | Description |
|---|---|
| `select_project` | Set the active project root directory. |
| `lasal_status` | Check project, stations, engines, processes, HMI health. |
| `inspect_project` | Read-only class/network/object inventory (channels, tasks) from the manifest + class sources. |
| `validate_guids` | Scan a station project for duplicate GUID collisions and uninitialized `TO_UDINT(0)` placeholders; auto-resolves GUID collisions and populates exact CRC-32 `@CT_` hashes. |
| `read_class_source` | Read or write a class `.st` (and optional `.h`) by class name; latin1-validated. |
| `set_target_ip` | Update a station's target IP/port/SSL in its `.lss`, preserving other settings. |
| `manage_class2` | Open or close the CLASS 2 IDE. |
| `manage_visudesigner` | Open or close VISUDesigner. |
| `manage_lasalscreen` | Open or close the LASAL SCREEN (LSE) editor. |
| `build_project` | Compile or download to PLC. |
| `control_plc` | Start, stop, or query PLC runtime state. |
| `plc_values` | Read/write live channel values on a running PLC. |
| `lars_runtime` | Local LARS simulation: list/setup workspaces per station (wires CLASS 2 + LASAL SCREEN projects), start/stop, screenshot of the rendered screen, point stations at LARS (`set_station_target`), revert (`restore`), switch ARM projects to the PC target (`target_pc`). |
| `apply_project_changes` | Batch engine operations (networks, objects, connections, tasks, compiler version, compile/download) **and** file-level class operations: `create_class`, `add_project_file`, `clean_project` (incl. `deep` artifact purge). |
| `run_class2_script` | Escape hatch: run arbitrary Python 2.7 `batch` statements through Lasal2.exe for API calls not exposed as operations. |
| `visu_project` | VISUDesigner engine operations (text lists, schemes, media, publish, download). |
| `lse_project` | LASAL SCREEN engine operations via COM automation: info, compile, download, merge/fuse, XML text export/import, CLASS 2 variable import, text-list translations, bulk button/softkey theming, settings, images. |
| `hmi_runtime` | Start/stop local HMI web simulation (DataService) and return accessible URL. |
| `plc_diagnostics` | Tracing, file transfer, static code analysis. |
| `deploy_all` | Full pipeline: compile → download → start PLC → compile LASAL SCREEN → optional SCREEN download → sync visu → start HMI. |
| `deploy_solution` | Multi-station MachineManager deploy via generated `.lutc`: CLASS 2 / LASAL SCREEN / VISUDesigner downloads, OS, files, run/boot, writes, CLI. |

### MCP Resources

| URI | Description |
|---|---|
| `lasal://guide` | Comprehensive guide on LASAL file formats, ST structure, and runtime JS API. |
| `lasal://project/status` | Dynamic JSON resource reporting selected project, discovered stations, HMI runtime status, and LARS instances. |
| `lasal://stations` | Live list of stations in the active solution and their target connections. |
| `lasal://classes/{className}` | Direct read access to Structured Text (`.st`) sources by class name with autocompletion. |

### Direct File Editing (no MCP needed)

The agent edits these files directly with its native file tools:

| File | Format | Encoding | What it contains |
|---|---|---|---|
| `.lsm` | XML | latin1 | Solution — lists all stations |
| `.lss` | XML | latin1 | Station settings — target IP, project references |
| `.lcp` | XML | latin1 | CLASS 2 project manifest — class and network file paths |
| `.st` | Generated declaration + ST | latin1 | Class source — `//{{LSL_DECLARATION` metadata, class body, `@CT_` table, methods; prefer `read_class_source` |
| `.lcn` | XML | latin1 | Network definitions — objects, connections, init values |
| `.lvp` | Mixed | utf-8 | VISUDesigner project manifest |
| `.lpr` | **Binary** | mixed | LASAL SCREEN project — **never edit directly**; drive via `lse_project` |
| `LSEOnlineConfig.xml` | XML | latin1 | LASAL SCREEN online/download target (updated by `set_target_ip`) |
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

## Simulating without hardware (LARS)

LARS (LASAL Runtime System) runs LASAL programs on a normal PC. Since each LARS
instance runs one program, the MCP creates one workspace per station:

1. `lars_runtime setup` — creates workspaces for every station in the selected solution (distinct ports per instance).
2. `lars_runtime start <station>` — launches the LARS window for that station.
3. `lars_runtime set_station_target <station>` — points the station's `.lss` at the LARS instance.
4. Now `build_project`, `control_plc`, and `plc_values` work unchanged against the local runtime.
5. `lars_runtime restore <station>` — reverts the `.lss` to the real hardware target.

Notes:
- Projects compiled for `Processor="ARM"` (most machine PLCs) need
  `lars_runtime target_pc` first — LARS is an x86 runtime and rejects ARM images.
- HMI panel / Local stations are already PC-targeted and work directly.
- Downloads to LARS automatically include the PC loader (`addLoaderAnyway`).
- `hmi_runtime` remaps published stations.json entries to running LARS instances,
  so the web HMI talks to the local simulation.
- Stations with a LASAL SCREEN project get their `.lpr` wired into the LARS
  workspace (`SCREEN_PRJ_PATH`), so LARS renders the panel screens locally;
  `lars_runtime screenshot` returns a PNG of the window for visual verification.

## Contributing

Contributions are welcome! Please check out [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on code standards, adding tools, and submitting pull requests.

## Releasing & CI/CD

Automated releases and publishing to npm are powered by GitHub Actions. Releases can be triggered manually via workflow dispatch with automated version bumping or by pushing version tags (`v*.*.*`).

## License

This project is licensed under the [MIT License](LICENSE).

