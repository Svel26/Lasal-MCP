# Lasal-MCP Architecture

MCP server wrapping three Sigmatek LASAL headless engines:
- **Lasal2.exe** (CLASS 2 PLC IDE) — `/script:path.py` with Python 2.7 batch API
- **VISUDesigner.exe** (HMI IDE) — `--script path.py` with Python scripting API
- **LasalVISUDataService.exe** — local HMI web runtime (no scripting, spawned as child process)
- **Lars.exe** (LARS runtime) — local PC soft-runtime; one program per instance, spawned as a detached window with a unique workspace (`lasalos2.xml`)

## Action Catalog (0.4.0 preview)

The original `lasal-mcp` entrypoint still exposes the 23 static tools. A parallel
action-catalog interface is available through `lasal_find_action` and
`lasal_execute_action`:

- Domain profiles: `lasal-class2-mcp`, `lasal-visu-mcp`, `lasal-screen-mcp`,
  `lasal-lars-mcp`, `lasal-solution-mcp` and the generic `serverCatalog` preview.
- 90 actions defined in `src/domains/*/actions.ts`, filtered by profile and
  executed by `src/core/actions/executor.ts`.
- Request-scoped project context (`src/core/project/`) with a stable project ID,
  capability detection and a cross-process project write lock.
- Generated reference in [`docs/ACTIONS.md`](docs/ACTIONS.md), usage in
  [`docs/CATALOG_PREVIEW.md`](docs/CATALOG_PREVIEW.md), and the delivery plan and
  current status in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Directory Layout

```
src/
  server.ts          — static MCP tool/resource registration, default entry point
  serverCatalog.ts   — backward-compatible action-catalog preview entrypoint
  state.ts           — shared JSON state (LARS/HMI bookkeeping) + per-agent project selection
  cli/init.ts        — project scanner / MCP config generator
  core/              — shared helpers
    actions/         — catalog types, registry, search, executor, profiles, audit
    project/         — project context, capability detection, project write locks
    errors.ts        — isTransientError, typed error codes
    envelope.ts      — truncateArray, ToolEnvelope type
    http.ts          — checkHttpHealth (HTTP 200/301/302 probe)
    process.ts       — isPidRunning, getPortForPid (Windows-specific)
    response.ts      — batchResultToResponse, batchToStepResult, visuToStepResult
    scratch.ts       — ensureScratch (mkdir SCRATCH)
    staticServer.ts  — embedded HTTP server for local web simulation/assets
  domains/           — action definitions per domain (class2, visu, screen, lars, deploy, core)
  servers/           — one thin entrypoint per catalog profile
  scripts/           — docs/ACTIONS.md generator
  resources/         — MCP resources
    registerResources.ts — lasal://guide, lasal://project/status, lasal://stations, lasal://classes/{className}
  tools/             — one file per MCP tool (schema + handler)
    applyProjectChanges.ts — structural edits (.st + .lcn), transactional with rollback
    deployAll.ts     — full pipeline: compile -> download -> start -> visu update
    hmiRuntime.ts    — start/stop/status of local DataService web runtime
    inspectProject.ts — read-only project scanning
    larsRuntime.ts   — local LARS simulation (setup/start/stop/target/target_pc)
    larsDoctor.ts    — LARS config/runtime diagnostics and compatibility report
    larsScenario.ts  — one-connection scenario runner (trace/screenshot/JUnit)
    lasalApps.ts     — open/close CLASS 2 and VISUDesigner GUIs
    plcControl.ts    — compile, download, start/stop/get_state, plc_values
    plcDiagnostics.ts — tracing, file transfer, code analysis
    readClassSource.ts — read/write .st files (latin1 validated)
    selectProject.ts — set active project directory
    setTargetIp.ts   — surgical .lss IP edit
    status.ts        — system status (engines, processes, stations, HMI health, LARS)
    validateGuids.ts — scan & auto-resolve duplicate GUIDs, compute CRC-32 @CT_ hashes
    visuControl.ts   — VISUDesigner batch ops and download
  utils/             — engine-level utilities
    batchScript.ts   — Python 2.7 script builder for Lasal2.exe batch API
    completions.ts   — MCP autocompletion providers for class & station names
    config.ts        — Zod-validated environment config (timeouts, paths)
    crc.ts           — IEEE 802.3 CRC-32 calculation for @CT_ class tables
    editTransaction.ts — filesystem transaction & rollback for project changes
    engine.ts        — exe paths, process management, scratch dir, engine mutex
    lars.ts          — LARS workspace config (lossless merge, validation, export/import), spawn/kill, effective-port probing, station targeting
    lasalXml.ts      — .lcp/.st/.lcn XML parsing, ST editing, round-trip safe
    lcpManifest.ts   — .lcp XML manipulation & class manifest operations
    mcpProgress.ts   — MCP progress notifications and log reporting
    preflight.ts     — connection resolution, ping, preflight checks
    projectScanner.ts — .lsm/.lss parsing, station discovery
    resolvePaths.ts  — .lcp/.lvp path resolution from state
    respond.ts       — MCP response helpers
    scriptRunner.ts  — async engine execution (execFile), log/step parsing, hints
    visuPropertyEncoding.ts — LVP property encoding/decoding
    visuScript.ts    — Python script builder for VISUDesigner scripting API
  test/              — Vitest tests
    fixtures/        — sample .lcp/.st/.lcn/.lsm/.lss files
```

## LARS (local simulation) design

LARS runs one LASAL program per instance. To simulate a whole solution
(PLC + HMI + Local), the MCP creates one LARS **workspace per station** in
`%APPDATA%\lasalos2.xml`, each with a distinct port block:

| Workspace | ONLINE | COMLINK_SRVR | COMLINK | ALARM |
|---|---|---|---|---|
| first | 1954 | 1955 | 1000 | 1957 |
| second | 1964 | 1965 | 1010 | 1967 |
| third | 1974 | 1975 | 1020 | 1977 |

Which port an instance *actually serves* differs by LARS build: older builds bind the
workspace `ONLINE` port, while the field-tested 01.03.216 build serves the default
`1954` for a single instance and exposes no online port for a second parallel instance.
`start`/`simulate` therefore probe `[workspace ONLINE, 1954]` and record the answering
port as the instance's **effective online port**, refusing ports that another running
instance owns. `set_station_target` rewrites the station's `.lss` `<TCPIP>` to
`127.0.0.1:<effective port>` (recording the original so `restore` can revert) and fails
loudly when a running instance answers nowhere; `build_project`/`control_plc`/
`plc_values`/`deploy_all` then operate on the LARS instance with no extra arguments.

The workspace records the station's `.lpr` as `SCREEN_PRJ_PATH` so LARS renders the
screen project. The CLASS 2 association is kept in MCP state (`larsInstances[].lcpPath`),
**not** as `CLASS_PRJ_PATH`: LARS treats that element as a saved runtime project and shows
`ERROR: UNKNOWN PROJECT-FILE` for a `.lcp` (the program is delivered by the online
download instead). Stale `CLASS_PRJ_PATH` elements are stripped on the next write.
Writes to `lasalos2.xml` are
**lossless**: only model-owned fields are updated, everything else — LARSConfigTool's
`Desc` attributes, `DATASERVICETCPPORT`, comments, extra drive mappings — is preserved,
so the file stays interchangeable with the official config tool.

The catalog exposes the same model as explicit actions: `lars.workspace.get`,
`create`, `clone`, `validate`, `export` and `import` operate on the lossless raw
config; `lars.instance.list`, `status`, `restart` and `logs` cover the runtime side.
`lars.doctor` reports the detected build, configured vs effective ports, unmodeled
XML elements and port/data-root conflicts. `lars.scenario.run` keeps one PLC
connection for all steps and supports named reads, DataAnalyzer trace start/stop,
LARS window screenshots and JUnit artifacts. See
[`docs/LARS_COMPATIBILITY.md`](docs/LARS_COMPATIBILITY.md).

Key gotchas handled by the code:
- **Online port vs table** — a LARS build's actual online port can differ from the
  workspace table (see above); targeting always follows the probed effective port,
  never the raw `ONLINE` value.
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
All engine operations go through `withEngineLock()`. It combines an in-process promise
chain with a cross-process lock directory (`%TEMP%/lasal-mcp/engine.lock`), because every
agent session runs its own MCP server process. Only one engine operation runs at a time
per machine; nested calls from the same async context (deploy → compile → download) use
`AsyncLocalStorage` and pass straight through.

### Multi-agent State
`state.ts` separates machine-wide data from per-agent data:

- `larsInstances`, `hmiRuntimes`, `larsGc` are machine-wide and written under a file
  lock with an atomic temp-file + rename.
- `currentProject` is only a "last used" hint. Each MCP process has its own selection;
  a fresh process inherits the hint only when the process that wrote it has exited.
- `agentProjects` records live sessions for `lasal_status`.
- `updateState(mutator)` re-reads the file under the lock, so a long-running handler
  cannot overwrite records another agent created while it was busy.

`lasalos2.xml` workspace mutations (`upsertLarsWorkspace`, `removeLarsWorkspace`) take the
same kind of lock: two concurrent `setup` calls used to allocate identical ports from the
same snapshot.

### Editor Ownership
Before an engine operation closes CLASS 2 or VISUDesigner, `engine.ts` enumerates the
running processes and extracts the `.lcp`/`.lvp` each was opened with. Instances under
another project are left running and reported as a conflict; `manage_class2` /
`manage_visudesigner` accept `force: true` to override. Processes that cannot be
attributed to a project are treated as foreign.

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
| `LASAL_LARS_EXE` | `C:\Program Files (x86)\Sigmatek\Lars\Lars.exe` | LARS runtime path |
| `LASAL_LARS_CONFIG` | `%APPDATA%\lasalos2.xml` | LARS workspace config path |
| `LASAL_MCP_TIMEOUT_COMPILE` | 600000 | Compile timeout (ms) |
| `LASAL_MCP_TIMEOUT_DOWNLOAD` | 600000 | Download timeout (ms) |
| `LASAL_MCP_TIMEOUT_VISU` | 300000 | Visu operation timeout (ms) |
| `LASAL_MCP_TIMEOUT_SCRIPT` | 120000 | Script execution timeout (ms) |
| `LASAL_MCP_HMI_DIR` | `C:\lslvisu` | Local HMI runtime directory |
| `LASAL_MCP_SCRATCH_MAX_AGE_H` | 24 | Hours before scratch files are cleaned |
| `LASAL_MCP_STATE_FILE` | `<repo>/lasal-state.json` | MCP state file override (tests use it to stay off live state) |
