# Lasal-MCP Architecture

MCP server wrapping three Sigmatek LASAL headless engines:
- **Lasal2.exe** (CLASS 2 PLC IDE) — `/script:path.py` with Python 2.7 batch API
- **VISUDesigner.exe** (HMI IDE) — `--script path.py` with Python scripting API
- **LasalVISUDataService.exe** — local HMI web runtime (no scripting, spawned as child process)
- **Lars.exe** (LARS runtime) — local PC soft-runtime; one program per instance, spawned as a detached window with a unique workspace (`lasalos2.xml`)

## Directory Layout

```
src/
  server.ts          — MCP tool/resource registration, entry point
  state.ts           — per-project JSON state (selected project, HMI runtime PIDs)
  core/              — shared helpers (Phase 2 dedup layer)
    errors.ts        — isTransientError, typed error codes
    envelope.ts      — truncateArray, ToolEnvelope type
    http.ts          — checkHttpHealth (HTTP 200/301/302 probe)
    process.ts       — isPidRunning, getPortForPid (Windows-specific)
    response.ts      — batchResultToResponse, batchToStepResult, visuToStepResult
    scratch.ts       — ensureScratch (mkdir SCRATCH)
  tools/             — one file per MCP tool (schema + handler)
    applyProjectChanges.ts — structural edits (.st + .lcn), transactional with rollback
    deployAll.ts     — full pipeline: compile -> download -> start -> visu update
    hmiRuntime.ts    — start/stop/status of local DataService
    hmiBrowser.ts    — headless Edge automation
    inspectProject.ts — read-only project scanning
    inspectVisuProject.ts — read-only LVP scanning
    larsRuntime.ts   — local LARS simulation (setup/start/stop/target/target_pc)
    plcControl.ts    — compile, download, start/stop/get_state, plc_values
    plcDiagnostics.ts — tracing, file transfer, code analysis
    readClassSource.ts — read/write .st files
    selectProject.ts — set active project directory
    setTargetIp.ts   — surgical .lss IP edit
    status.ts        — system status (engines, processes, stations, HMI health, LARS)
    visuControl.ts   — VISUDesigner batch ops and download
    visuDashboard.ts — direct LVP JSON editing (dashboards, windows, styles)
    lasalApps.ts     — open/close CLASS 2 and VISUDesigner GUIs
  utils/             — engine-level utilities
    batchScript.ts   — Python 2.7 script builder for Lasal2.exe batch API
    visuScript.ts    — Python script builder for VISUDesigner scripting API
    scriptRunner.ts  — async engine execution (execFile), log/step parsing, hints
    engine.ts        — exe paths, process management, scratch dir, engine mutex
    config.ts        — Zod-validated environment config (timeouts, paths)
    lasalXml.ts      — .lcp/.st/.lcn XML parsing, ST editing, round-trip safe
    lars.ts          — LARS workspace config (lasalos2.xml), spawn/kill, ports, station targeting, ARM→PC target switch
    preflight.ts     — connection resolution, ping, preflight checks
    projectScanner.ts — .lsm/.lss parsing, station discovery
    resolvePaths.ts  — .lcp/.lvp path resolution from state
    respond.ts       — MCP response helpers
    visuPropertyEncoding.ts — LVP property encoding/decoding
  test/              — Vitest tests
    fixtures/        — sample .lcp/.st/.lcn/.lsm/.lss files
```

## LARS (local simulation) design

LARS runs one LASAL program per instance. To simulate a whole solution
(PLC + HMI + Local), the MCP creates one LARS **workspace per station** in
`%APPDATA%\lasalos2.xml`, each with distinct ports:

| Workspace | ONLINE | COMLINK_SRVR | COMLINK | ALARM |
|---|---|---|---|---|
| first | 1954 | 1955 | 1000 | 1957 |
| second | 1964 | 1965 | 1010 | 1967 |
| third | 1974 | 1975 | 1020 | 1977 |

The workspace records the station's `.lcp` as `CLASS_PRJ_PATH` so LARS
auto-loads the project. `set_station_target` surgically rewrites the station's
`.lss` `<TCPIP>` to `127.0.0.1:<ONLINE>` (recording the original so `restore`
can revert), which makes `build_project`/`control_plc`/`plc_values`/`deploy_all`
operate on the LARS instance with no extra arguments.

Key gotchas handled by the code:
- **Spawn quoting** — Node `spawn` does not escape embedded quotes; args must
  be passed without inner quotes (`/c<path>`, not `/c"<path>"`).
- **PC loader** — LARS rejects downloads without the PC loader (`Linker_Error`).
  Loopback targets automatically set `addLoaderAnyway=true`.
- **ARM vs PC target** — machine PLCs compile for `Processor="ARM"` which LARS
  rejects ("checksum error"). `lars_runtime target_pc` switches the `.lcp`
  `<Target Processor="ARM">` to PC (restored via `restore`).
- **Stale SRAM** — `C:\Lars\SRAM.DAT`/`SRAM.SAV` from a previous project cause
  `SRAM_Error`; `lars_runtime stop` + deleting those files resets the runtime.
- **HMI DataService** — published `stations.json` entries with real IPs are
  remapped to running LARS instances (`127.0.0.1:<port>`) when `hmi_runtime`
  starts, so the web HMI talks to the local simulation instead of the panel.

## Key Patterns

### Engine Mutex
All engine operations go through `withEngineLock()` — a promise chain that serializes access. Only one engine operation runs at a time.

### Script Execution
Scripts are Python 2.7 files written to a temp scratch directory, executed via `execFile` (async, non-blocking), then parsed for step markers and log errors. Each script writes `STEP <label> OK` markers to a sidecar file; the runner verifies all expected steps completed.

### File Encoding
LASAL project files (.st, .lcp, .lcn, .lss) are ISO-8859-1 (latin1). Python scripts use `mbcs` encoding. The `validateMbcsEncodable()` function rejects non-latin1 characters before they reach the engine.

### Transactional Edits
`apply_project_changes` uses `EditTransaction` for .st file edits — files are backed up before modification and rolled back on error.

### Connection Resolution
Tools that need a PLC/HMI connection first try the explicit `connection` parameter, then fall back to parsing the `.lss` file's `<TCPIP>` element. Preflight checks ping the target before starting long operations.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `LASAL_CLASS2_EXE` | `C:\Program Files (x86)\...\Lasal2.exe` | CLASS 2 IDE path |
| `LASAL_VISUDESIGNER_EXE` | `C:\Program Files\...\VISUDesigner.exe` | VISUDesigner path |
| `LASAL_DATASERVICE_EXE` | auto-discovered | DataService path |
| `LASAL_EDGE_EXE` | auto-discovered | Edge browser path |
| `LASAL_LARS_EXE` | `C:\Program Files (x86)\Sigmatek\Lars\Lars.exe` | LARS runtime path |
| `LASAL_LARS_CONFIG` | `%APPDATA%\lasalos2.xml` | LARS workspace config path |
| `LASAL_MCP_TIMEOUT_COMPILE` | 600000 | Compile timeout (ms) |
| `LASAL_MCP_TIMEOUT_DOWNLOAD` | 600000 | Download timeout (ms) |
| `LASAL_MCP_TIMEOUT_VISU` | 300000 | Visu operation timeout (ms) |
| `LASAL_MCP_TIMEOUT_SCRIPT` | 120000 | Script execution timeout (ms) |
| `LASAL_MCP_HMI_DIR` | `C:\lslvisu` | Local HMI runtime directory |
| `LASAL_MCP_SCRATCH_MAX_AGE_H` | 24 | Hours before scratch files are cleaned |
