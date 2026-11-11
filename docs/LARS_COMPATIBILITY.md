# LARS Compatibility and Config Matrix

This document records what the LARS server models, what it deliberately preserves
verbatim, and how builds differ in their effective online-port behaviour.

`lars.doctor` reports the detected executable version and compares configured
with effective ports while instances are running. Set `LASAL_LARS_VERSION` to
override version detection for a build whose file version cannot be read.

## Effective online port by build

| LARS build | `ONLINE` table honoured | Concurrent instances | Observed behaviour |
|---|---|---|---|
| `01.03.213` and contemporary builds | yes | yes, when ports are distinct | Each instance binds its workspace `ONLINE` port. Multi-station PLC + HMI simulation works. |
| `01.03.216` | no | no | A single instance binds the default `1954`; a second concurrent instance exposes no online port. Multi-station simulation is not possible on this build. |
| Unlisted/newer | unknown | unknown | The server probes the workspace `ONLINE` port first, then `1954`, and never takes a port another running instance owns. Run `lars.doctor` while instances are running to record the behaviour. |

The probe is intentionally runtime-based: hard-coding a build number would break
when Sigmatek changes the behaviour again. A workspace that answers nowhere fails
loudly instead of pointing a station at a dead port.

## Workspace fields

| Area | Fields | Written by MCP | Notes |
|---|---|---|---|
| Memory | `DATALEN`, `CODELEN` | yes | MiB; must be positive. |
| Paths | `ACTIVEDAT`, `AUTOEXEC`, `LSLWORK`, `SRAMDAT` | yes | Emulated runtime paths. |
| Screen | `SCREEN_PRJ_PATH` | yes | Host path to a `.lpr`; missing files are warnings. |
| Ports | `ONLINE`, `COMLINK_SRVR`, `COMLINK`, `ALARM`, `DATASERVICETCPPORT` | yes | 1-65535, unique within and across workspaces. |
| Drive maps | `DRIVEMAP/DRIVEMAP_ELEMENT/DRIVE`, `PATH` | yes | `C:` follows `dataRoot`; additional drives are validated as absolute, non-root paths. |
| CLASS 2 path | `CLASS_PRJ_PATH` | **never** | LARS rejects a `.lcp` there. The association lives in MCP state. |
| Window settings and future fields | any unmodeled element or attribute | preserved verbatim | `lars.doctor` lists unmodeled workspace/path/com/memory elements. |
| Global config | comments and non-workspace elements | preserved verbatim | Only workspace blocks owned by the MCP are rewritten. |

## Validation rules

Errors block a write:

- Names must be non-empty and unique.
- Ports must be integers in `1..65535`, unique inside a workspace and across all
  workspaces.
- `dataRoot` must be an absolute, non-drive-root path and unique per workspace.
- Drive maps must use a single drive letter, be absolute, not map a host drive
  root, and not repeat a drive.
- The `C:` mapping must match `dataRoot`.
- Memory sizes must be positive.

Warnings do not block a write:

- No isolated `dataRoot` (legacy shared `C:` mapping).
- A configured `screenProjectPath` does not exist on this workstation.
- A runtime instance has no matching workspace config.
- A recorded PID is no longer running.
- The config contains unmodeled elements (they are preserved).

## Export and import

- `lars.workspace.export` writes lossless XML by default. Exporting one workspace
  wraps its exact block in a valid `LARSCONFIGURATIONS` document.
- JSON export contains modeled fields only.
- `lars.workspace.import` validates the file before writing, keeps a `.bak` of the
  previous config, and defaults to `mode=merge`.
- Merge replaces whole workspace blocks with the same name and appends new ones.
  Unrelated workspaces, global elements and comments stay unchanged.
- `mode=replace` rewrites the entire file and requires top-level `confirm=true`.
- `dry_run` reports added/replaced workspaces without writing.

## Scenario artifacts

`lars.scenario.run` keeps one PLC connection for the whole scenario and writes
artifacts under `%TEMP%\lasal-mcp\scenarios\<runId>\`:

| Step | Artifact |
|---|---|
| `read` with `saveAs` | named values in the JSON result (`saved`). |
| `trace_start` / `trace_stop` | DataAnalyzer CSV (`trace_*.csv`). An active trace is stopped and saved as `trace_aborted.csv` on failure. |
| `screenshot` | PNG captured from the running LARS window (`screenshot_<index>_<name>.png`). Requires top-level `workspace` or a step-level `workspace`. |
| `junit: true` | `junit.xml` with one testcase per step. |

Trace start needs a DataAnalyzer config, either on the step (`config_path`) or in
the top-level `trace_config_path`.

## Known gaps

- Per-build compatibility is recorded only for builds observed in the field.
- Config import/export does not model every future LARSConfigTool GUI field; it
  preserves them but cannot edit them individually yet.
- Ephemeral workspaces, scenario-level reset and multi-instance HMI DataService
  are not implemented.
