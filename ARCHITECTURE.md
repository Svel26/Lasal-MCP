# Lasal-MCP Architecture

MCP server wrapping three Sigmatek LASAL headless engines:
- **Lasal2.exe** (CLASS 2 PLC IDE) — `/script:path.py` with Python 2.7 batch API
- **VISUDesigner.exe** (HMI IDE) — `--script path.py` with Python scripting API
- **LasalVISUDataService.exe** — local HMI web runtime (no scripting, spawned as child process)

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
    plcControl.ts    — compile, download, start/stop/get_state, plc_values
    plcDiagnostics.ts — tracing, file transfer, code analysis
    readClassSource.ts — read/write .st files
    selectProject.ts — set active project directory
    setTargetIp.ts   — surgical .lss IP edit
    status.ts        — system status (engines, processes, stations, HMI health)
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
    preflight.ts     — connection resolution, ping, preflight checks
    projectScanner.ts — .lsm/.lss parsing, station discovery
    resolvePaths.ts  — .lcp/.lvp path resolution from state
    respond.ts       — MCP response helpers
    visuPropertyEncoding.ts — LVP property encoding/decoding
  test/              — Vitest tests
    fixtures/        — sample .lcp/.st/.lcn/.lsm/.lss files
```

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
| `LASAL_MCP_TIMEOUT_COMPILE` | 600000 | Compile timeout (ms) |
| `LASAL_MCP_TIMEOUT_DOWNLOAD` | 600000 | Download timeout (ms) |
| `LASAL_MCP_TIMEOUT_VISU` | 300000 | Visu operation timeout (ms) |
| `LASAL_MCP_TIMEOUT_SCRIPT` | 120000 | Script execution timeout (ms) |
| `LASAL_MCP_HMI_DIR` | `C:\lslvisu` | Local HMI runtime directory |
| `LASAL_MCP_SCRATCH_MAX_AGE_H` | 24 | Hours before scratch files are cleaned |
