# LASAL-MCP Implementation Plan

**Status:** In progress — action-catalog preview shipped in 0.4.0  
**Date:** 2026-11-09  
**Updated:** 2026-11-11  
**Scope:** Architecture and delivery plan for the next major evolution of Lasal-MCP.  
**Related documents:** `ARCHITECTURE.md`, `README.md`, `docs/CATALOG_PREVIEW.md`, `docs/ACTIONS.md`, `docs/LARS_COMPATIBILITY.md`, `docs/LASAL_MCP_SPECIFICATION.md`, `docs/LSE_AUTOMATION_REFERENCE.md`

> **0.4.0 progress:** Phases 0–3 are implemented as an opt-in preview: action
> catalog, five profile entrypoints, project context/pinning/write locks, LARS
> workspace config parity and the scenario runner. The static 23-tool server
> remains the default. Still open: Phase 3b LARS daemon, multi-instance HMI
> isolation (Phase 4), full GUI capability coverage (Phase 5), preflight
> linter/knowledge graph/telemetry (Phase 6), hardening/release gates (Phase 7)
> and lab-suite validation on a LASAL workstation.

> **Assumption:** one senior engineer familiar with the codebase, working full-time, with AI assistance for read-only discovery and test generation. Durations are estimates, not commitments. Several discovery workstreams can run in parallel, but engine-bound tests and probes must be serialized on a single Windows workstation.

---

## 0. Decision summary

| Area | Decision |
|---|---|
| Tool interface | Local action catalog with `lasal_find_action` and `lasal_execute_action`. Keep a small static core: `select_project`, `lasal_status`, `check_job_status`. |
| Packaging | One repository, one package version, shared `core`, multiple thin entrypoints/profiles. No independent forks. |
| Domains | `class2`, `visu`, `screen`, `lars`, `solution` (all). Domain profiles filter the action catalog. |
| Project model | Request-scoped `ProjectContext`, stable `projectId`, optional process pin via `--project`. Project switching is explicit and snapshot-based. |
| LARS | Separate `lasal-lars-mcp` entrypoint first; optional shared runtime daemon with leases and quotas later. |
| File vs engine authority | Engine owns structural project artifacts; direct file edits only for stable sidecars with round-trip validation. |
| Safety | Per-action risk tiers, server-side `confirm=true` enforcement, audit log, gated expert actions, optional separate destructive executor. |
| Fast telemetry | Batch/scenario first, then OPC UA, then a persistent-engine experiment. Port 1954 protocol work is a timeboxed last resort. |
| Non-goals | Binary reimplementation, full vendor API coverage, multi-repo fragmentation, bypassing SafetyDesigner or certified runtimes. |

---

## 1. Executive summary

Lasal-MCP currently exposes 23 static tools covering CLASS 2, VISUDesigner, LASAL SCREEN, LARS, HMI runtime, deployment, and diagnostics. The implementation has strong foundations: per-agent project isolation, a cross-process engine mutex, editor ownership checks, lossless `lasalos2.xml` merging, LARS effective-port probing, and a lab test suite.

The next step is not to keep adding static tools. It is to change the interaction model:

1. **A local action catalog** describes every capability once: canonical ID, aliases, Zod schema, examples, risk flags, and handler. Agents discover actions with `lasal_find_action` and run them with `lasal_execute_action`.
2. **Domain profiles** decide which catalog is loaded. A VISUDesigner project gets only VISU actions; a LASAL SCREEN project gets only SCREEN actions; LARS is loaded only when simulation is needed.
3. **Project context** is captured once per request and passed explicitly. This makes project switching safe and enables multiple projects in separate pinned processes.
4. **LARS becomes a first-class runtime product** with full workspace configuration, a scenario/test runner, and an optional shared daemon for multi-agent scaling.
5. **Capabilities are added without growing the static tool surface.** The catalog grows; the agent's context does not.

The target architecture is:

```
MCP entrypoints (profiles)
  class2 | visu | screen | lars | solution
        │
        ▼
Action catalog (find / execute)
        │
        ▼
Action handlers (domain modules)
        │
        ▼
Core services
  project context · locks · state · engine · XML · config · audit
        │
        ▼
Vendor engines (Lasal2, VISUDesigner, LSE, MachineManager) · LARS · files
```

---

## 2. Baseline: what exists today

### 2.1 Strengths to preserve

- Per-agent project selection in `src/state.ts`: `currentProject` is process-local; the shared file keeps only a last-used hint with an owner PID.
- Cross-process engine mutex and re-entrant nested operations in `src/utils/engine.ts`.
- Editor ownership: closing CLASS 2/VISUDesigner only terminates instances belonging to the current project unless `force: true`.
- LARS workspace model, lossless XML merge, port allocation, effective-port probing, and screen rendering (`src/utils/lars.ts`, `src/tools/larsRuntime.ts`).
- Transactional `.st` edits with rollback (`src/utils/editTransaction.ts`).
- Unit tests plus a lab suite that creates fresh projects for engine tests (`test/`, `test/lab/`, `vitest.lab.config.ts`).
- Existing unregistered modules for VISU inspection and dashboard editing: `src/tools/inspectVisuProject.ts`, `src/tools/visuDashboard.ts`.

### 2.2 Gaps this plan addresses

- 23 static tool definitions, several of them large multiplexers (`apply_project_changes`, `visu_project`, `lse_project`, `lars_runtime`, `plc_diagnostics`).
- Agents load irrelevant domain tools when working on a single-HMI-type project.
- Project selection is mutable process state; handlers can observe a switch mid-call.
- HMI runtime is a singleton: one `HMI_DIR`, one DataService, and a new start kills the existing runtime.
- LARS workspace names use project folder basename + station name; same-named projects can collide.
- No per-project write lock or optimistic concurrency for project files.
- Background jobs are in-memory and per-process.
- No action-level audit trail, risk metadata, or confirmation policy.
- Version drift across LASAL suite, VISUDesigner, LARS builds, and CLASS 2 batch API names.
- No repeatable agent evaluation harness to compare interface designs.

### 2.3 Constraints

- Windows only; the LASAL suite is proprietary and installed locally.
- Engine operations are machine-wide and must be serialized or carefully isolated.
- Project files are ISO-8859-1; Python 2.7 and Python 3.12 are both involved.
- Engine integration tests cannot run on standard GitHub-hosted runners.
- Safety-certified logic must remain vendor-authored; the MCP must not attempt to reproduce safety runtimes or compilers.

---

## 3. Target architecture

### 3.1 Layers

**Entrypoints** — tiny `McpServer` instances created by a shared factory. A profile selects the action catalog and the domain guide resource.

**Action catalog** — the single source of truth for capabilities. It handles discovery, alias resolution, profile filtering, JSON Schema generation, validation, risk metadata, and audit hooks.

**Action handlers** — domain modules. They may call existing tool handlers initially; over time, engine logic moves into domain modules and `src/tools` becomes legacy wrappers.

**Core services** — project context, project locks, engine locks, state, XML, config, process management, audit, and compatibility detection.

**Vendor layer** — Lasal2.exe batch API, VISUDesigner Python API, LASALScreen COM, MachineManager, LARS, and project files.

### 3.2 Proposed directory layout

```
src/
  core/
    actions/
      types.ts            # ActionDefinition, ActionContext, results, errors
      registry.ts         # registration, alias resolution, validation
      search.ts           # local search and ranking
      schema.ts           # Zod -> JSON Schema, examples validation
      audit.ts            # JSONL audit log
      profiles.ts         # domain/profile definitions
    project/
      context.ts          # ProjectContext, canonical path, projectId
      registry.ts         # open/resolve/cache project contexts
      capabilities.ts     # .lcp/.lvp/.lpr detection and profile recommendation
      locks.ts            # per-project lock, stamps, conflict errors
    state/                # move src/state.ts here in Phase 2
    engine/               # move/keep src/utils/engine.ts here eventually
    xml/                  # existing lasalXml/lcpManifest helpers
    config/
  domains/
    core/actions.ts       # project target IP, doctor, graph queries (future)
    class2/actions/*.ts
    visu/actions/*.ts
    screen/actions/*.ts
    lars/actions/*.ts
    deploy/actions.ts
    index.ts              # assemble the full catalog
  servers/
    createServer.ts       # shared factory
    class2.ts
    visu.ts
    screen.ts
    lars.ts
    solution.ts
  tools/                  # existing handlers; gradually become legacy wrappers
  server.ts               # backward-compatible alias for solution profile
```

### 3.3 Runtime profiles

Each profile registers:

- 3 static core tools: `select_project`, `lasal_status`, `check_job_status`
- `lasal_find_action`
- `lasal_execute_action`
- A domain-specific `lasal://guide` resource
- The profile-filtered action catalog

| Profile | Catalog domains | Intended use |
|---|---|---|
| `class2` | core + class2 | PLC logic, networks, compile/download, PLC control, diagnostics |
| `visu` | core + visu | VISUDesigner project, dashboards, publish, HMI web runtime |
| `screen` | core + screen | LASAL SCREEN `.lpr`, LSE automation, screen compile/download |
| `lars` | core + lars | Local simulation workspaces, instances, scenarios |
| `solution` | all | Mixed solutions, migration, cross-domain deploy, MachineManager |

LARS is intentionally separate. A CLASS 2 or SCREEN agent loads `lasal-class2-mcp` or `lasal-screen-mcp` plus `lasal-lars-mcp` only when simulating. A VISU agent normally does not need LARS.

### 3.4 Request flow

1. Client calls `select_project` or launches the server with `--project`.
2. `execute_action` resolves the target project once, creates a `ProjectContext`, and acquires any required project lock.
3. The executor resolves the action alias, checks the profile and `confirm` rules, and validates `params` with the action's Zod schema.
4. The handler receives `(params, ctx)` and calls core services.
5. The result envelope is returned; failures include structured field errors, schema, example, and suggestions.
6. Destructive/deploy actions write an audit record.

---

## 4. Action catalog

### 4.1 Principles

- **One source of truth.** Action metadata and Zod schemas generate JSON Schema, docs, examples, and tests. No hand-maintained catalog file.
- **Intent-level actions.** Prefer `class2.network.create` over one mega-action with an `operation` enum. Wrap existing handlers first, then split.
- **Stable IDs.** Canonical IDs never change silently. Aliases provide ergonomics and backward compatibility.
- **Local discovery.** `find_action` never calls an engine or PLC.
- **Define once, expose everywhere.** The same action definition can be used by a profile, the generated docs, and the test suite.
- **Safety is metadata, not prose.** Risk, confirmation, dry-run, and expert flags are machine-readable and enforced.

### 4.2 Action definition

```ts
export type Domain = "core" | "class2" | "visu" | "screen" | "lars" | "deploy";
export type Risk = "read" | "write" | "destructive" | "deploy";

export interface ActionDefinition<TParams = unknown> {
  id: string;                       // canonical dot ID, e.g. class2.build.compile
  aliases: string[];                // old tool names, short verbs
  domain: Domain;
  summary: string;
  description?: string;
  schema: z.ZodType<TParams>;
  handler: (params: TParams, ctx: ActionContext) => Promise<ActionResult>;
  risk: Risk;
  destructive: boolean;
  requiresConfirm: boolean;
  requiresProject: boolean;
  dryRunSupported?: boolean;
  asyncCapable?: boolean;
  idempotent?: boolean;
  expert?: boolean;                 // gated behind --allow-expert
  tags: string[];
  examples: Array<{ params: TParams; note?: string }>;
  hints?: string[];
  deprecated?: { since: string; use: string; removeIn?: string };
}
```

`ActionContext`:

```ts
export interface ActionContext {
  project: ProjectContext | null;
  projectId: string | null;
  agentPid: number;
  confirm: boolean;
  dryRun: boolean;
  async: boolean;
  logger: ActionLogger;
  progress?: (message: string, percent?: number) => void;
  signal?: AbortSignal;
}
```

### 4.3 Canonical IDs and aliases

Convention: `domain.resource.verb`.

Examples:

- `class2.build.compile`
- `class2.network.create`
- `class2.object.add`
- `class2.connection.create`
- `class2.plc.values.read`
- `visu.project.inspect`
- `visu.dashboard.element.add`
- `visu.textlist.import`
- `screen.project.compile`
- `screen.textlist.add_language`
- `lars.workspace.create`
- `lars.instance.start`
- `lars.scenario.run`
- `deploy.solution.run`
- `project.target_ip.set`
- `project.doctor`

Aliases:

- Old tool names map to the closest action: `build_project` -> `class2.build.compile` or a migration hint if the old `action` enum is ambiguous.
- Short verbs: `compile`, `publish`, `lars_start`.
- Deprecated aliases remain for at least two minor releases and return a `deprecated` warning.

### 4.4 `lasal_find_action`

Description:

> Search the local LASAL action catalog. Read-only and makes no engine or PLC call. Use when the action ID or params are unclear. Returns JSON Schemas, hints, destructive flags, and execute examples.

Input:

```ts
{
  query?: string;
  action?: string;                  // exact ID or alias
  domain?: Domain;
  tags?: string[];
  risk?: Risk[];
  include_expert?: boolean;
  limit?: number;                   // default 5, max 20
  include_schema?: "none" | "summary" | "full";
}
```

Behavior:

- Exact `action` lookup returns the full schema and examples.
- Free-text search ranks: exact ID, exact alias, ID token overlap, alias overlap, summary/tags, then typo distance.
- Empty query returns a compact domain summary and the most common actions, not the whole catalog.
- No match returns `suggestions` and the closest actions.
- Results include aliases, risk flags, confirmation requirements, project requirement, async/dry-run support, and deprecation warnings.

Output:

```ts
{
  actions: Array<{
    id: string;
    aliases: string[];
    domain: Domain;
    summary: string;
    description?: string;
    risk: Risk;
    destructive: boolean;
    requiresConfirm: boolean;
    requiresProject: boolean;
    dryRunSupported: boolean;
    asyncCapable: boolean;
    deprecated?: { since: string; use: string };
    schema?: object;
    examples?: Array<{ action: string; params: unknown; note?: string }>;
    hints?: string[];
  }>;
  total: number;
  query?: string;
  suggestions?: string[];
}
```

### 4.5 `lasal_execute_action`

Description:

> Execute one LASAL catalog action by canonical ID or alias. Always pass params as an object. Destructive actions require top-level confirm=true. Use lasal_find_action first only when the action or params are unclear.

Input:

```ts
{
  action: string;
  params?: Record<string, unknown>; // default {}
  confirm?: boolean;
  dry_run?: boolean;
  async?: boolean;
  project?: string;                 // project path or projectId
}
```

Execution order:

1. Resolve alias to canonical ID.
2. Check the action exists and is available in the current profile.
3. Resolve the project using the precedence in §5.2: a process pin is a constraint; otherwise explicit project > action path params > selected project.
4. If the process is pinned and the explicit project differs, return `PROJECT_PINNED` unless `--allow-project-override` is set.
5. Reject expert actions unless `--allow-expert`.
6. Enforce `confirm=true` for destructive/deploy actions.
7. Validate `params` with the action's Zod schema; return field errors, schema, and a valid example on failure.
8. Apply `dry_run` if supported; otherwise return `DRY_RUN_UNSUPPORTED`.
9. Start an async job if requested and supported; otherwise run inline.
10. Write audit records before and after execution.

### 4.6 Error model

Stable error codes:

| Code | Meaning |
|---|---|
| `UNKNOWN_ACTION` | No canonical ID or alias; include suggestions. |
| `INVALID_PARAMS` | Zod validation failed; include `fieldErrors`, schema, example. |
| `CONFIRM_REQUIRED` | Destructive action called without `confirm: true`. |
| `ACTION_NOT_AVAILABLE` | Action exists but is filtered out by the current profile. |
| `PROJECT_REQUIRED` | Action needs a project and none was selected. |
| `PROJECT_NOT_FOUND` | Project path/ID cannot be resolved. |
| `PROJECT_PINNED` | Explicit project conflicts with the process pin. |
| `DRY_RUN_UNSUPPORTED` | Action does not support preview. |
| `FILE_CHANGED` | A file changed since it was read; re-read before writing. |
| `HMI_RUNTIME_IN_USE` | Another project owns the singleton HMI runtime lease. |
| `PRECONDITION_FAILED` | Engine closed, PLC unreachable, file missing, etc. |
| `ENGINE_BUSY` | Lock timeout or foreign editor conflict. |
| `ACTION_FAILED` | Handler failure; include logs and hints. |

Every error response includes `ok: false`, `code`, `message`, and where applicable `action`, `fieldErrors`, `schema`, `example`, `suggestions`, `hints`, and `logPath`.

### 4.7 Result envelope

```ts
{
  ok: true;
  action: string;                   // canonical ID
  project?: { id: string; root: string };
  result: unknown;
  warnings?: string[];
  artifacts?: Array<{ name: string; path: string; kind: string }>;
  jobId?: string;
  nextSteps?: string[];
}
```

### 4.8 Safety metadata

Risk tiers:

- `read`: no side effects. Safe for exploration and `--read-only`.
- `write`: modifies project files or writable state, but is not a deploy or destructive operation.
- `destructive`: deletes, overwrites, stops a runtime, clears PLC memory, runs arbitrary scripts, or changes safety-relevant state.
- `deploy`: downloads to hardware, starts/stops a PLC, publishes to a panel, creates a bootdisk, or runs a multi-station update.

Examples:

| Action | Risk | Confirm |
|---|---|---|
| `class2.project.inspect` | read | no |
| `class2.network.create` | write | no |
| `class2.class.delete` | destructive | yes |
| `class2.plc.stop` | destructive | yes |
| `class2.plc.values.write` | write | no (consider confirm for production profiles) |
| `class2.script.run` | destructive, expert | yes + `--allow-expert` |
| `class2.build.download` | deploy | yes |
| `class2.bootdisk.create` | deploy | yes |
| `visu.publish` | write/deploy | depends on target |
| `screen.project.download` | deploy | yes |
| `lars.instance.stop` | destructive | yes |
| `lars.workspace.remove` | destructive | yes |
| `deploy.solution.run` | deploy | yes + dry-run preferred |

### 4.9 Catalog validation and generation

At startup (and as a test):

- Every action has a unique ID and unique aliases.
- Every action has a summary, schema, handler, at least one example, and risk metadata.
- Every example validates against the action schema.
- Every action's `requiresConfirm` is consistent with `destructive`/`deploy`.
- Every action has a handler test or an explicit `labOnly`/`manualTest` marker.

Generate from the registry:

- `docs/ACTIONS.md` — full catalog by domain.
- README tool tables per profile.
- Domain guide sections.
- JSON Schema used by `find_action`.
- A contract test that fails on drift.

### 4.10 Initial action inventory

This is the initial target set. Existing handlers are wrapped first; multiplexers are split incrementally.

**Core / project**

- `project.target_ip.set`
- `project.doctor`
- `project.graph.query` (later)
- Static tools: `select_project`, `lasal_status`, `check_job_status`

**CLASS 2**

- `class2.project.inspect` (existing `inspect_project`)
- `class2.class.read_source`, `class2.class.write_source`
- `class2.class.create`, `class2.class.delete`, `class2.class.rename`
- `class2.project.file.add`, `class2.project.file.remove`, `class2.project.clean`
- `class2.guid.validate`
- `class2.network.create`, `class2.network.delete`, `class2.network.rename`
- `class2.object.add`, `class2.object.remove`, `class2.object.rename`
- `class2.connection.create`, `class2.connection.delete`
- `class2.init_value.set`
- `class2.task.configure`
- `class2.script.run` (expert)
- `class2.build.compile`, `class2.build.download`
- `class2.plc.start`, `class2.plc.stop`, `class2.plc.state`
- `class2.plc.values.read`, `class2.plc.values.write`
- `class2.diagnostics.trace`, `class2.diagnostics.file_transfer`, `class2.diagnostics.code_analysis`
- `class2.diagnostics.os_download`, `class2.diagnostics.ram_clear`, `class2.diagnostics.project_backup`
- `class2.bootdisk.create`
- `class2.editor.open`, `class2.editor.close`

**VISUDesigner**

- `visu.project.inspect` (existing unregistered module)
- `visu.dashboard.element.add`, `visu.dashboard.element.remove`, `visu.dashboard.element.set_properties`
- `visu.dashboard.element.move`, `visu.dashboard.element.resize`, `visu.dashboard.element.duplicate`
- `visu.dashboard.composite.add`, `visu.dashboard.template.create`
- `visu.dashboard.control_types.list`, `visu.dashboard.control_types.describe`
- `visu.project.update_stations`, `visu.publish`, `visu.download`
- `visu.textlist.export`, `visu.textlist.import`
- `visu.scheme.*`, `visu.media.*`, `visu.code_module.*`, `visu.datapoint.set_property`
- `visu.hmi.start`, `visu.hmi.stop`, `visu.hmi.status`
- `visu.editor.open`, `visu.editor.close`

**LASAL SCREEN**

- `screen.project.info`, `screen.project.create`, `screen.project.compile`, `screen.project.download`
- `screen.project.merge`
- `screen.text.export_xml`, `screen.text.import_xml`
- `screen.textlist.list`, `screen.textlist.set`, `screen.textlist.add_language`
- `screen.variables.import`
- `screen.server.get_property`, `screen.server.set_property`
- `screen.buttons.update`, `screen.softkeys.update`
- `screen.settings.set`, `screen.image.insert`
- `screen.editor.open`, `screen.editor.close`

**LARS**

- `lars.workspace.list`, `lars.workspace.get`, `lars.workspace.create`, `lars.workspace.update`
- `lars.workspace.remove`, `lars.workspace.clone`, `lars.workspace.validate`
- `lars.workspace.export`, `lars.workspace.import`, `lars.workspace.gc`
- `lars.instance.list`, `lars.instance.start`, `lars.instance.stop`, `lars.instance.restart`
- `lars.instance.status`, `lars.instance.logs`, `lars.instance.screenshot`
- `lars.station.target`, `lars.station.restore`, `lars.project.target_pc`
- `lars.scenario.run`
- `lars.doctor`

**Deploy**

- `deploy.all.run`
- `deploy.solution.run`
- `deploy.solution.generate_lutc`

---

## 5. Project model and multi-project work

### 5.1 `ProjectContext`

```ts
export interface ProjectContext {
  id: string;                       // stable hash of canonical root
  root: string;                     // canonical absolute path
  lsmPath?: string;
  stations: StationSummary[];
  capabilities: {
    class2: boolean;
    visu: boolean;
    screen: boolean;
    machineManager: boolean;
  };
  recommendedProfile: "class2" | "visu" | "screen" | "solution";
  selectedAt: number;
}
```

`projectId` is a short hash of the canonical project path (Windows: `realpath`, lower-cased for hashing). It is stable across processes and server restarts. Moving a project produces a new ID; LARS workspaces from the old ID become GC candidates.

### 5.2 Selection and pinning

Precedence for resolving a project:

1. Process pin (`--project` / `LASAL_MCP_PROJECT`) is a **constraint**, not just a default. If a different explicit project is supplied, return `PROJECT_PINNED`.
2. If not pinned: explicit top-level `project` on `execute_action`.
3. If not pinned: action-specific path (`lcp_path`, `lvp_path`, `lpr_path`) when no project was selected.
4. Process selection (`select_project`).
5. `PROJECT_REQUIRED`.

This prevents a pinned agent from accidentally modifying another project. `--allow-project-override` can relax the pin for advanced workflows.

`select_project` returns `{ projectId, root, stations, capabilities, recommendedProfile }` and records the selection in `agentProjects`. Every domain server reports its profile and project in `lasal_status`.

### 5.3 Capability detection

Scan the `.lsm` and its station `.lss` files:

- `SlnClassProject` -> CLASS 2 capability
- `SlnVISUDesignerProject` -> VISU capability
- `SlnScreenProject` -> SCREEN capability
- No `.lsm` but a single `.lcp` -> legacy CLASS 2 layout

`recommendedProfile`:

- Only CLASS 2 -> `class2`
- Only VISU -> `visu`
- Only SCREEN -> `screen`
- Multiple types -> `solution`

Detection is advisory; `--profile` is authoritative.

### 5.4 State keys

- Add `projectId` to `agentProjects`, `HmiRuntimeInfo`, and `LarsInstanceInfo`.
- Key HMI runtimes by `projectId`; keep a migration fallback for legacy path keys.
- Key LARS instances by workspace name but store `projectId`; workspace names include a short project hash to avoid collisions.
- Add a `projects` registry to shared state for status/diagnostics.
- Add `stateVersion` for migrations.

### 5.5 Locks and concurrency

- **Engine locks:** keep the existing global mutex for Phase 1-3. It is the safe default. Experiment with per-engine locks (`class2`, `visu`, `lse`) in Phase 4 behind an env flag. LARS start/stop/screenshot should not hold the authoring engine lock.
- **Project write lock:** add `withProjectWriteLock(projectId, fn)` for mutating actions and deploys. It is a cross-process lock directory with PID, action ID, timestamp, and stale detection. Reads do not take the lock.
- **Optimistic stamps:** every file read that will be written records `{ path, mtimeMs, size, sha256? }`. Before writing, verify the stamp; on mismatch return `FILE_CHANGED` with the changed files. Integrate with `EditTransaction`.
- **Same-project multi-agent:** write locks + stamps prevent lost updates. Different projects can interleave engine operations but still serialize on the engine lock.

### 5.6 Background jobs

Extend `JobRecord` with:

- `projectId`, `projectRoot`
- `actionId`
- `agentPid`
- `paramsSummary`
- `artifacts`
- `logPath`

Jobs capture the `ProjectContext` at creation time. `check_job_status` filters by project unless explicitly asked for all jobs. Initial implementation stays in-process; a shared JSONL job registry is optional for the LARS daemon or multi-server deployments.

### 5.7 HMI runtime

Current behavior is single-instance: one `HMI_DIR`, one DataService, and starting a new runtime kills the existing process.

Phase 4 discovery:

1. Test whether two `LasalVISUDataService` instances can run with different data directories and ports on one machine.
2. If yes, implement per-project data directories, dynamic ports, per-project static servers, and project-keyed state.
3. If no, enforce a single global HMI lease, return `HMI_RUNTIME_IN_USE` for a second project, and document the limitation. Do not silently kill another project's runtime.

### 5.8 LARS workspace identity

- Workspace name: `${sanitizedProjectName}_${sanitizedStation}_${shortProjectHash}` by default.
- Allow an explicit `name` override, but refuse to overwrite a workspace owned by another `projectId`.
- Store `projectId`, `stationName`, `lssPath`, `lcpPath`, `screenProjectPath`, `role`, and `dataRoot` in instance state.
- GC protects all active project selections and leases, not only the caller's project.

### 5.9 Multi-project capability matrix

| Capability | Today | Target |
|---|---|---|
| Different projects in different MCP processes | Yes | Yes, with pinned `--project` |
| Sequential project switching in one process | Yes | Yes, snapshot-based |
| Concurrent project-scoped actions in one process | No | Yes, request-scoped context |
| Parallel engine operations | No (global lock) | Controlled per-engine concurrency after testing |
| Multiple LARS workspaces | Yes, name collisions possible | Yes, project-hashed identities and leases |
| Multiple HMI runtimes | No | Per-project if DataService supports it; otherwise explicit singleton |
| Same-project concurrent edits | Unprotected | Project write lock + file stamps |

### 5.10 Tests

- Switch projects while an async deploy is running; the job must stay bound to its original project.
- Two projects with the same folder basename and station name must produce distinct LARS workspaces.
- Two HMI runtimes: either both work or the second fails with a clear lease error.
- Two agents edit the same `.st`; the second gets `FILE_CHANGED`, not silent loss.
- One agent sends two project-scoped actions concurrently; each uses its own context.

---

## 6. Domain profiles and entrypoints

### 6.1 Profiles

Define profiles as data:

```ts
const PROFILES = {
  class2:  { domains: ["core", "class2"], guide: "class2" },
  visu:    { domains: ["core", "visu"], guide: "visu" },
  screen:  { domains: ["core", "screen"], guide: "screen" },
  lars:    { domains: ["core", "lars"], guide: "lars" },
  solution:{ domains: ["core", "class2", "visu", "screen", "lars", "deploy"], guide: "solution" },
};
```

The catalog is filtered at construction time. `execute_action` also checks availability, so a guessed action cannot escape the profile.

### 6.2 Packaging

One package, one version, multiple bins:

```json
"bin": {
  "lasal-mcp": "dist/servers/solution.js",
  "lasal-class2-mcp": "dist/servers/class2.js",
  "lasal-visu-mcp": "dist/servers/visu.js",
  "lasal-screen-mcp": "dist/servers/screen.js",
  "lasal-lars-mcp": "dist/servers/lars.js"
}
```

`dist/server.js` remains the backward-compatible alias for the solution profile. `--profile` is also supported on any bin for advanced use.

CLI flags:

- `--profile <name>` — override the bin's profile.
- `--project <path>` — pin the process to one project.
- `--read-only` — expose only `read` actions.
- `--allow-destructive` — allow destructive actions (they still need `confirm=true`).
- `--allow-expert` — allow expert actions such as `class2.script.run`.
- `--state-file <path>` — existing test/multi-instance override.
- `--log-level`, `--audit-file`.

### 6.3 Project type to profile

| Project type | Load |
|---|---|
| CLASS 2 only | `lasal-class2-mcp` |
| CLASS 2 + simulation | `lasal-class2-mcp` + `lasal-lars-mcp` |
| VISUDesigner only | `lasal-visu-mcp` |
| LASAL SCREEN only | `lasal-screen-mcp` |
| LASAL SCREEN + simulation | `lasal-screen-mcp` + `lasal-lars-mcp` |
| Mixed solution | `lasal-solution-mcp` |
| VISU <-> SCREEN migration | `lasal-solution-mcp` |
| Multi-station deploy | `lasal-solution-mcp` |

### 6.4 `lasal-mcp init`

A small command that:

1. Scans `.lsm` / `.lss` files.
2. Detects `.lcp`, `.lvp`, `.lpr`.
3. Prints the recommended profile and, optionally, writes an MCP client config.
4. Never overwrites an existing config without `--force`.

This makes the 99% case frictionless: open a VISU project, get a VISU-only server config.

### 6.5 Domain guides

Split the universal `LASAL_GUIDE` into:

- `lasal://guide/class2` — CLASS 2 files, ST structure, networks, build/deploy.
- `lasal://guide/visu` — `.lvp`, dashboards, datapoints, text lists, HMI runtime.
- `lasal://guide/screen` — `.lpr`, LSE COM, screens/windows, text lists, deployment.
- `lasal://guide/lars` — workspaces, ports, simulation, scenarios.
- `lasal://guide/solution` — cross-domain workflows and deploy.

Each guide references its catalog actions by canonical ID.

### 6.6 Backward compatibility

- `lasal-mcp` remains a working bin and defaults to the solution profile.
- Old tool names are aliases where unambiguous.
- `--legacy-tools` registers the old static tool set for one deprecation cycle.
- A migration guide maps every old tool to its new action ID(s).

---

## 7. LARS runtime MCP

### 7.1 Why separate

LARS has a different lifecycle from authoring: workspaces, ports, processes, leases, screenshots, and test runs. It is also useful to CLASS 2 and SCREEN agents but irrelevant to most VISU work. A separate `lasal-lars-mcp` entrypoint gives focused context and independent evolution.

### 7.2 Actions

Workspace:

- `lars.workspace.list`, `get`, `create`, `update`, `remove`, `clone`, `validate`, `export`, `import`, `gc`

Instance:

- `lars.instance.list`, `start`, `stop`, `restart`, `status`, `logs`, `screenshot`

Station/project:

- `lars.station.target`, `lars.station.restore`, `lars.project.target_pc`

Scenario:

- `lars.scenario.run`

Diagnostics:

- `lars.doctor`

### 7.3 Workspace config parity

Expose the fields already modeled internally:

- Ports: `onlinePort`, `comlinkServerPort`, `comlinkBasePort`, `alarmPort`, `dataServiceTcpPort`
- Paths: `activeData`, `autoexec`, `lslWork`, `sramData`, `screenProjectPath`, `dataRoot`, drive maps
- Sizes: `dataLenMb`, `codeLenMb`
- Metadata: `name`, `desc`, `role`, `projectId`

Do **not** write `CLASS_PRJ_PATH` for a `.lcp`; LARS rejects it. Keep the CLASS 2 association in MCP state and deliver the program via the online download.

Discover the full GUI schema by varying each LARSConfigTool option and diffing `lasalos2.xml` in a lab VM. Preserve unknown elements/attributes on writes; the existing lossless merge is the right foundation.

### 7.4 Validation rules

- Ports 1-65535, unique among configured and running workspaces, not already bound.
- Data roots absolute, writable, not a drive root, not shared between workspaces, sufficient free space.
- `.lpr` screen path exists when configured.
- Memory sizes within sane bounds; warn on unusually high values.
- Drive maps must not silently map the host system root without an explicit override.
- Show both **configured** and **effective** online ports. Some LARS builds serve the default `1954` or expose no online port for a second instance.

### 7.5 Workspace identity

Add `projectId` to the workspace and instance model. Use a short project hash in the default workspace name. Refuse to update a workspace whose `projectId` belongs to another project. GC protects all active selections and leases.

### 7.6 Runtime manager / daemon

Phase 3 delivers the separate stdio server. Phase 3b (optional, after the scenario runner) adds a shared daemon:

- One process owns workspaces, instances, ports, leases, and GC.
- Agents acquire leases with TTL and heartbeat.
- Max instance count and resource budgets prevent unbounded soft-PLC spawning.
- Expose as an HTTP MCP transport on `127.0.0.1` with a bearer token, or keep a stdio MCP facade that talks to the daemon over localhost.
- Audit all start/stop/remove operations.

A separate binary alone does not improve multi-agent scaling; the shared owner is what removes port races and orphan processes.

### 7.7 Scenario runner

Action `lars.scenario.run`:

```ts
{
  workspace: string;
  steps: Array<
    | { type: "set"; channel: string; value: string }
    | { type: "read"; channels: string[]; saveAs?: string }
    | { type: "wait"; channel: string; equals?: string; min?: number; max?: number; timeoutMs?: number; pollMs?: number }
    | { type: "assert"; channel: string; equals?: string; min?: number; max?: number; message?: string }
    | { type: "sleep"; ms: number }
    | { type: "trace_start" }
    | { type: "trace_stop" }
    | { type: "screenshot"; name?: string }
  >;
  timeoutMs?: number;
  reset?: boolean;
  ephemeral?: boolean;
  junit?: boolean;
}
```

Implementation:

- Generate one CLASS 2 Python batch script per scenario.
- Open the PLC connection once and execute all set/read/wait/assert steps.
- Use polling with a timeout for `wait`; avoid fixed sleeps except explicit `sleep`.
- Write a JSON result and step markers; parse into structured results.
- Produce JUnit XML when requested.
- Start/stop an ephemeral workspace around the run when `ephemeral: true`; never reset a real project workspace.
- Save artifacts under `%TEMP%/lasal-mcp/scenarios/<runId>/`.

This is the killer feature of the LARS server: a repeatable TDD loop without protocol reverse engineering or one engine spawn per value.

### 7.8 Resource limits

- `maxInstances` (default 2-4, configurable).
- CPU/RAM warnings and refusal when the machine is saturated.
- Port block allocation with conflict detection.
- Lease TTL and GC.
- Per-project and per-agent quotas in daemon mode.

### 7.9 Compatibility and doctor

`lars.doctor` reports:

- LARS executable path and version.
- Effective vs configured ports for running instances.
- Workspace config schema issues and unknown fields.
- Drive-map/data-root conflicts.
- Stale SRAM files and data roots.
- Orphaned workspaces.
- Available disk space.

Maintain a per-build compatibility matrix for effective-port behavior and second-instance support.

### 7.10 Migration

- Keep `lars_runtime` as a legacy alias mapping to the new actions.
- Migrate existing `larsInstances` state by deriving `projectId` from `projectDir`.
- Rename existing workspaces only when necessary; on collision, create a new hashed workspace and report the old one for GC.

---

## 8. File vs engine authority

### 8.1 Decision rules

Use file editing when all are true:

- The file format is documented or fully mapped.
- The operation does not require generated caches, CRC tables, or engine-managed artifacts.
- A round-trip fixture and schema validation exist.
- The compiler or engine can validate the result.

Use the engine when any are true:

- The operation creates/deletes structural project artifacts.
- The vendor engine maintains hidden caches or generated tables.
- The file is binary (`.lpr`).
- The only reliable writer is a COM/Python API.
- The project format has invariants that are not fully understood.

### 8.2 Classification matrix

| File / operation | Authority | Notes |
|---|---|---|
| `.lss` target IP/port/SSL | File | Preserve all other elements; schema validation. |
| `LSEOnlineConfig.xml` target | File | Same schema as `.lss`; update with `set_target_ip`. |
| `Stations.txt` | File | Validate format and station IDs. |
| Dashboard JSON | File | JSON schema/round-trip; use VISU actions for publish. |
| `.lcn` channel init values | File, cautiously | Only values; compile and inspect after. |
| `.lcn` network/object/connection structure | Engine | Requires CLASS 2 batch engine; caches/GUIDs/CRC. |
| `.lcp` class manifest registration | Engine | `BrowserInfo.bin`/`LobInfo.bin` caches. |
| `.st` declaration/`@CT_` tables | Engine or validated generator | Must keep XML metadata, declarations, CRC consistent. |
| `.st` method bodies | File with stamps | Use latin1 validation and compile. |
| `.lpr` | COM only | Binary; never edit directly. |
| `.lutc` | Generated file | Validate against MachineManager schema. |
| `.lcp` target processor ARM/PC | File | Surgical edit; restore path. |

### 8.3 Validation

- Golden fixtures for every file type.
- Parse/serialize round-trip tests that preserve unknown elements/attributes.
- Compile after mutations in lab tests.
- `FILE_CHANGED` conflict errors when stamps do not match.
- Backups/rollback for multi-file edits.

### 8.4 GUI wizard discovery

For Category 3 GUI-only features:

1. Snapshot the project (`git status`, file hashes).
2. Run the wizard in a lab VM.
3. Diff the project and capture ProcMon file writes.
4. Encode the resulting file changes as an action if they are stable and documented.
5. Otherwise, document the wizard as a manual step and stop there.

Do not automate modal dialogs blindly; use the existing dialog watchdog only as a safety net.

---

## 9. Capability coverage plan

### 9.1 Discovery workstreams

Run these as read-only investigations, parallelizable across agents where safe:

1. **CLASS 2 batch API introspection**
   - Python 2.7 `dir(batch)`, `__doc__`, docstrings, argument inspection.
   - Generate `docs/capabilities/class2-batch-api.md`.
   - Classify each function: action candidate, priority, risk, engine-only.

2. **VISUDesigner API introspection**
   - Python 3.12 `inspect` on `sigmatek.lasal.lvd`.
   - Map alarms, templates, recipes, bindings, text lists, datapoints.
   - Generate `docs/capabilities/visu-api.md`.

3. **LASAL SCREEN COM typelib**
   - Dump `LASALScreen.tlb` interfaces, dispinterfaces, methods, properties.
   - Extend `docs/LSE_AUTOMATION_REFERENCE.md`.
   - Compare against current `lse_project` actions.

4. **LARSConfigTool schema**
   - Vary each GUI option; diff `lasalos2.xml`.
   - Generate the field matrix and validation rules.

5. **File schemas**
   - `.lcn`, `.lcp`, `.lss`, `.st`, `.lvp`, `.lutc`, dashboard JSON, `Stations.txt`.
   - Build golden fixtures and round-trip tests.

6. **GUI wizard diffs**
   - Hardware config, license, firmware flashing.
   - Capture files written; encode if stable.

Guardrails: no binary decompilation; engine probes serialized; lab VMs snapshotted; human review of all generated action definitions.

### 9.2 Priority gaps

P0 (high-frequency, high-value):

- OPC UA settings/export and a standard telemetry path.
- AML hardware import.
- Task timing and CPU core assignment.
- IO label mapping.
- Memory estimation.
- VISU text-list CSV round-trip (already partially present).
- VISU alarms/templates/recipes/bindings.
- LARS full workspace config.
- MachineManager `.lutc` generation and station tables.

P1:

- Drive parameter file linking.
- VISU scheme/media/code-module management.
- SCREEN variable import, server properties, bulk theming.
- Bootdisk variants.
- PLC file transfer and project backup.

P2:

- Exotic hardware wizards.
- License/firmware flows.
- Vendor-specific UI-only settings with unstable file formats.

### 9.3 Capability matrix deliverable

Maintain a single table:

| Feature | GUI location | Headless API | File format | Proposed action | Risk | Status |
|---|---|---|---|---|---|---|

This table drives the roadmap and prevents “wrap everything” drift.

---

## 10. Differentiators

### 10.1 Preflight ST linter

Scope:

- Lexer/tokenizer for LASAL ST, not a full type checker initially.
- Balanced blocks and generated-region markers.
- Declaration / channel / `@CT_` consistency.
- GUID/CRC validation (reuse `validate_guids`).
- Missing project files and dependencies.
- Latin1/encoding checks.
- C linkage and file-name conventions.
- Duplicate names and unresolved references.

Integrate vendor `DoCodeAnalysisOnProject` / `DoCodeAnalysisOnFile` as the authoritative deep check. Cache its XML output and map diagnostics to files/lines.

Actions:

- `class2.lint.run` — fast structural checks.
- `class2.lint.explain` — explain a diagnostic.
- `class2.diagnostics.code_analysis` — vendor analysis.

Success criteria:

- Catches at least 80% of common compile errors before a full compile.
- Under 100 ms for a medium project.
- No false positives on the lab fixture set.

### 10.2 Knowledge graph

Index:

- Classes, channels, methods, GUIDs, CRC hashes.
- Networks, objects, connections, init values.
- Stations, `.lss` targets, multi-master mappings.
- VISU datapoints, dashboards, bindings, text lists.
- SCREEN servers, variables, screens/windows.

Storage:

- Per-project JSON index under `%LOCALAPPDATA%/lasal-mcp/index/<projectId>/`.
- Invalidate by file mtime/size/hash.
- Rebuild action for explicit refresh.

Queries:

- `project.graph.references(channel)`
- `project.graph.trace(source, destination)`
- `project.graph.unused`
- `project.graph.hmi_bindings`
- `project.graph.station_map`

Resources:

- `lasal://graph/<projectId>/summary`
- `lasal://graph/<projectId>/references?channel=...`

### 10.3 Fast telemetry

Order of investment:

1. Batch multiple reads/writes in one engine call.
2. LARS scenario runner: one connection per scenario.
3. OPC UA client, if the runtime exposes it; standard and documented.
4. Persistent engine experiment: can Lasal2 stay alive with a command loop?
5. Port 1954 PCAP timeboxed spike; legal review; experimental flag only.

Do not promise sub-millisecond reads. The goal is seconds -> tens of milliseconds for interactive work and one startup per scenario.

### 10.4 Compile feedback

Parse compiler logs into structured diagnostics:

```ts
{
  severity: "error" | "warning" | "info";
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  message: string;
  hint?: string;
}
```

`class2.build.compile` returns `diagnostics`, `logPath`, `durationMs`, and a `cacheHit` flag when applicable.

### 10.5 Doctor

`project.doctor` and `lars.doctor` report engine paths/versions, COM registration, Python/Node, LARS build quirks, port conflicts, locks, state file, disk space, and recent audit errors. This becomes the first support tool.

---

## 11. Safety, security, and compliance

### 11.1 Risk tiers

Enforced by the catalog. See §4.8.

### 11.2 Confirmation and approval

- Server-side `confirm=true` is mandatory for destructive/deploy actions.
- `dry_run` is offered where the handler can preview changes.
- MCP clients approve tools, not action IDs. A single generic execute tool may get one approval for all actions. Before enabling deploy actions in public profiles, evaluate:
  - a separate `lasal_execute_destructive_action` tool, or
  - MCP elicitation if the client supports it.
- `--read-only` and `--allow-destructive` provide coarse deployment policies.

### 11.3 Expert actions

`class2.script.run` and similar arbitrary-code actions are:

- `expert: true`
- `destructive: true`
- unavailable unless `--allow-expert`
- excluded from `find_action` unless `include_expert: true`
- audited with the full script hash, not necessarily the full script body

### 11.4 Audit

JSONL audit log:

- timestamp, agent PID, server profile, project ID, action ID, params summary (redacted), confirm/dry-run flags, duration, result code, artifact paths.
- Rotate by size/date.
- Redact known secrets and optionally IP addresses.
- Surface the last N errors in `lasal_status`.

### 11.5 Daemon security

- Bind to `127.0.0.1` only.
- Bearer token or per-session token.
- Allowlist actions and projects.
- Audit all start/stop/remove/deploy operations.
- No remote access by default.

### 11.6 Legal and compliance

- Do not decompile or redistribute vendor binaries.
- Review the Sigmatek EULA before shipping any port-1954 client or protocol documentation.
- Keep any protocol experiment behind an experimental flag and out of the default package.
- Safety logic remains vendor-certified; the MCP does not replace SafetyDesigner or certified runtimes.

### 11.7 Non-goals

- Reimplementing the LASAL compiler, linker, RTOS, or safety runtime.
- Bypassing license checks or vendor security.
- Wrapping 100% of the vendor API.
- Supporting arbitrary multi-tenant or internet-facing deployments.

---

## 12. Compatibility and versioning

### 12.1 Capability registry

Track known differences:

- CLASS 2 batch API renames (`DoCodeAnalysisOnProjekt` vs `DoCodeAnalysisOnProject`).
- LARS builds: effective online port, second-instance behavior, config schema.
- VISUDesigner versions and publish directory layouts (`Publish` vs `TempPreview/Publish`).
- LSE COM registration (32-bit vs 64-bit view).
- Python 2.7 vs 3.12 availability.
- Node.js minimum version.

`lasal_doctor` reports detected capabilities and recommended workarounds.

### 12.2 Action catalog version

- Include `catalogVersion` in `find_action`/`execute_action` responses.
- Canonical IDs are stable.
- Aliases can be added; removal follows deprecation policy.
- `deprecated` metadata includes `since`, `use`, and `removeIn`.

### 12.3 Engine version matrix

Define a supported matrix:

- Latest two LASAL suite releases.
- Installed VISUDesigner runtimes.
- LARS builds tested.
- MachineManager versions tested.

Unsupported versions fail loudly with a doctor hint rather than silently degrading.

### 12.4 State and config migration

- Add `stateVersion` to `lasal-state.json`.
- Migrate HMI runtime keys from paths to project IDs.
- Migrate LARS instances by deriving `projectId`.
- Back up state before migration; write atomically.
- LARS config writes remain lossless and preserve unknown fields.

---

## 13. Testing, CI, and evaluation

### 13.1 Unit tests

- Registry: unique IDs/aliases, metadata completeness.
- Search: exact match, aliases, typo suggestions, filters.
- Validation: Zod errors, examples validate.
- Profiles: action availability and execute rejection.
- Confirmation: destructive/deploy require `confirm`.
- Project context: canonical IDs, pin precedence, capability detection.
- Locks: write lock contention, stale lock recovery.
- Stamps: conflict detection.
- State migration.
- XML round-trips.

### 13.2 Contract tests

- Every action has a handler.
- Every handler has an action (no orphan capabilities).
- Every action has at least one example that validates.
- Every action has a test or a lab/manual marker.
- `find_action` returns the canonical action for its own ID and aliases.
- Generated docs match the registry.

### 13.3 Lab tests

- Create a fresh project, compile, download to LARS, start, read values.
- VISU publish and HMI runtime.
- LSE compile and screen rendering.
- LARS workspace config round-trip and custom ports.
- Scenario runner with set/wait/assert.
- Multi-project isolation with same-named projects.
- HMI multi-instance go/no-go.

### 13.4 Evaluation harness

Benchmark tasks:

1. Select a VISU project and publish it.
2. Add a network object and connection in CLASS 2.
3. Compile and download to LARS.
4. Read/write PLC values.
5. Create a LARS workspace with custom ports, start it, run a scenario.
6. Update a VISU dashboard text and publish.
7. Compile an LSE screen and download.
8. Validate GUIDs and fix a duplicate.
9. Switch between two projects without cross-contamination.
10. Run two LARS workspaces from same-named projects.
11. Find and run the correct action for an unfamiliar task.
12. Recover from an invalid params error using the returned schema/example.

Metrics:

- Static tool-definition tokens per profile.
- Find calls and execute calls per task.
- Wrong-action rate.
- Task success rate.
- p50/p95 latency.
- Token usage per task.
- Test flakiness.

Acceptance thresholds:

- <= 5 static tools per profile.
- `find_action` top-1 >= 90% on canonical queries; top-3 >= 98%.
- Task success >= static-tool baseline.
- >= 30% reduction in tool-definition tokens for VISU and SCREEN profiles.
- Zero cross-project state contamination in tests.
- All destructive/deploy actions confirmed and audited.
- Lab suite green on the self-hosted runner.

### 13.5 CI

- GitHub-hosted: unit, contract, lint, build, docs generation check.
- Self-hosted Windows: lab tests, engine integration, LARS, HMI, LSE.
- Nightly lab run; PR lab run for engine-touching changes.
- VM snapshots for destructive tests; disposable fresh projects.
- Artifacts: logs, screenshots, JUnit, audit excerpts.
- No secrets in test projects.

### 13.6 Performance

- Server startup < 1 s.
- `find_action` < 20 ms local search.
- Action dispatch overhead < 10 ms excluding engine time.
- LARS scenario startup amortized to one engine spawn.
- Token budget report generated per profile.

---

## 14. Observability

- Structured logs with action ID, project ID, agent PID, duration, result.
- JSONL audit log as in §11.4.
- Job artifacts: logs, generated scripts, JSON results, screenshots, JUnit.
- `lasal_status` additions:
  - open projects and their IDs,
  - active agents and pinned projects,
  - project write-lock holder,
  - engine lock holder/queue,
  - LARS instances and leases,
  - HMI runtimes,
  - recent failed actions,
  - engine/version capabilities.
- `lasal://projects` resource for coordination.

---

## 15. Phased roadmap

Durations are rough and assume one engineer. Phases 5 and 6 can overlap with 2-4 where they are read-only discovery.

| Phase | Duration | Deliverables | Exit criteria |
|---|---|---|---|
| **0. Foundation & measurement** | 1 week | ADR 001-003; action types/registry skeleton; benchmark tasks; baseline token/latency report; project context design. | Registry compiles; 5 dummy actions; baseline documented. |
| **1. Catalog MVP** | 2 weeks | `find_action`/`execute_action`; core static tools; wrap current VISU + CLASS 2 handlers as actions; profile filter; legacy flag; generated docs. | VISU pilot server with 2 catalog tools + 3 core; eval shows acceptable task success. |
| **2. Profiles & project context** | 2 weeks | 5 entrypoints/bins; `ProjectContext`; `projectId`; `--project` pin; state keys; project write lock; stamps; `init` command. | Cross-project tests pass; switching mid-job safe; <= 5 static tools per profile. |
| **3. LARS MCP** | 3 weeks | `lasal-lars-mcp`; workspace CRUD/config parity; project-hashed IDs; validation; scenario runner; doctor. | Config round-trip; scenario test green; multi-workspace isolation. |
| **3b. LARS daemon (optional)** | 1-2 weeks | Shared daemon, leases, quotas, GC, localhost auth. | Two agents share LARS without port races or orphans. |
| **4. Runtime isolation** | 2 weeks | HMI multi-instance go/no-go; per-project HMI or singleton lease; per-engine lock experiment; shared job visibility. | Two HMI runtimes or explicit limitation; multi-project stress test green. |
| **5. GUI capability coverage** | 3 weeks | Batch/VISU/COM/LARSConfigTool introspection reports; P0 actions (OPC UA, AML, tasks/cores, IO labels, memory, text lists); capability matrix. | P0 actions implemented and documented; matrix reviewed. |
| **6. Differentiators** | 4 weeks | Preflight linter; knowledge graph; OPC UA telemetry; persistent-engine experiment; 1954 timebox. | Linter catches >= 80% common errors; graph queries work; telemetry target met or no-go. |
| **7. Hardening & release** | 2 weeks | Docs, migration guide, deprecation, security review, performance, release candidate. | 1.0 RC; legacy tools deprecated; support matrix published. |

Total: roughly 17-21 engineer-weeks, plus optional daemon work.

### Dependencies

- Phase 1 depends on the action types/registry.
- Phase 2 depends on project context design; can start in parallel with catalog wrapping.
- Phase 3 depends on the registry and project context.
- Phase 4 depends on Phase 2 and LARS extraction.
- Phase 5 is mostly independent discovery; implement actions after the catalog exists.
- Phase 6 depends on Phase 2 (graph/linter need project indexing) and Phase 3 (scenario/telemetry).

---

## 16. Migration and release

### 16.1 Compatibility

- `lasal-mcp` remains the solution profile.
- Old tool names become aliases.
- `--legacy-tools` keeps the static set for one deprecation cycle.
- Generated docs include a migration table: old tool -> new action(s) -> params mapping.

### 16.2 Deprecation policy

- Add alias with a `deprecated` warning.
- Keep for two minor releases.
- Remove in the next major release.
- Never change a canonical action ID silently.

### 16.3 Release gates

- Unit, contract, and lab tests green.
- Eval thresholds met.
- No cross-project contamination.
- Destructive actions confirmed and audited.
- Docs generated and up to date.
- State/config migration tested on a backup.
- Security review for daemon and expert actions.
- Legal review for protocol work (if any).

Suggested versions:

- `0.4.0` — catalog preview behind a flag.
- `0.5.0` — domain entrypoints and project pinning.
- `0.6.0` — catalog default; legacy flag.
- `1.0.0` — remove legacy static tools; stable action IDs.

---

## 17. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Catalog discovery failure: agent cannot find the right action | Wrong action or extra round trips | Strong aliases, top-N suggestions, errors with schema/examples, eval harness, direct execute for known IDs. |
| Two-step latency | Slower tasks | Keep core tools static; aliases; `find_action` only when unclear; measure. |
| Generic execute bypasses client-level tool approval | Unsafe destructive operation | Risk tiers, `confirm=true`, read-only/destructive profiles, optional separate destructive executor, elicitation, audit. |
| Action explosion | Catalog becomes hard to search | Domain filters, tags, curation, deprecation, hidden expert actions, top-N results. |
| Schema drift | Agent sends wrong params | Zod-generated JSON Schema, contract tests, examples validated in CI. |
| Profile confusion | Agent uses the wrong server | `init` config generator, project-type matrix, clear bin names, `lasal_status` reports profile. |
| Multi-project races | Wrong project modified | Request-scoped context, project pin, write locks, stamps, tests. |
| LARS build differences | Wrong ports or failed starts | Effective-port probing, doctor, compatibility matrix, configured vs effective display. |
| HMI singleton | Cannot run two HMI simulations | Discovery first; per-project runtime if supported; otherwise explicit lease and limitation. |
| Engine concurrency | Bottleneck for agent swarms | Keep global lock for safety; experiment with per-engine locks; document throughput. |
| CI cannot run engines | Integration regressions | Self-hosted Windows runner, lab VM snapshots, nightly tests. |
| Legal/EULA | Distribution risk | No binary RE; legal review before protocol work; experimental/optional flag. |
| Scope creep | Delayed delivery | Non-goals, phases, acceptance criteria, capability matrix. |

---

## 18. Open decisions and ADRs

Create ADRs for:

1. **ADR-001:** Action catalog vs static tools; core tool boundary.
2. **ADR-002:** Domain profiles and packaging (bins + `--profile`).
3. **ADR-003:** Project context, IDs, pinning, and lock model.
4. **ADR-004:** LARS separate server and daemon timing.
5. **ADR-005:** File vs engine authority per file type.
6. **ADR-006:** Safety model and destructive executor.
7. **ADR-007:** Version/capability matrix and support policy.
8. **ADR-008:** Telemetry strategy (OPC UA, persistent engine, 1954).

Recommended defaults:

- Keep 3 core tools static.
- Implement bins and `--profile`.
- Start with one execute tool + `confirm`; add a destructive executor before public deploy.
- Deliver LARS stdio server first; daemon after the scenario runner.
- HMI multi-instance is a discovery task, not a promise.
- Port 1954 is a no-go until OPC UA and persistent-engine options are measured.
- Granular actions; wrap multiplexers first, split by usage.

---

## 19. Immediate next steps (first 10 working days)

1. Write ADR-001/002/003 and the action catalog types.
2. Add `src/core/actions/registry.ts` with validation and search.
3. Wrap 5 VISU actions and the 3 core tools; add `find`/`execute` in a preview server.
4. Add the benchmark tasks and record baseline token/latency numbers.
5. Add `ProjectContext` skeleton and `projectId`; migrate state keys without behavior changes.
6. Add a project write-lock and file-stamp prototype; test concurrent edits.
7. Spike LARSConfigTool field discovery in the lab VM and document the field matrix.
8. Generate `docs/ACTIONS.md` from the registry.

---

## Appendix A: Project type detection

| Detected files | Capability | Recommended profile |
|---|---|---|
| `.lcp` only (legacy layout) | CLASS 2 | `class2` |
| `.lsm` with `.lcp` | CLASS 2 | `class2` |
| `.lsm` with `.lvp` | VISU | `visu` |
| `.lsm` with `.lpr` | SCREEN | `screen` |
| `.lsm` with `.lcp` + `.lvp` | CLASS 2 + VISU | `solution` |
| `.lsm` with `.lcp` + `.lpr` | CLASS 2 + SCREEN | `solution` |
| `.lsm` with `.lvp` + `.lpr` | VISU + SCREEN (migration) | `solution` |
| `.lsm` with all three | Full solution | `solution` |

Detection is advisory. A project can contain multiple stations of different types; the profile is chosen by the task, not only the files.

---

## Appendix B: Example action definition

```ts
export const class2BuildCompile = defineAction({
  id: "class2.build.compile",
  aliases: ["build_project", "compile", "compile_plc"],
  domain: "class2",
  summary: "Compile the CLASS 2 project.",
  description:
    "Closes this project's CLASS 2 IDE, compiles the .lcp, and returns structured diagnostics and the log path.",
  schema: z.object({
    lcp_path: z.string().optional(),
    mode: z.enum(["RebuildAll", "BuildChanges", "UserClassesOnly", "NoDebugInfo"]).default("RebuildAll"),
    timeout_s: z.number().int().positive().optional(),
  }),
  handler: class2BuildCompileHandler,
  risk: "write",
  destructive: false,
  requiresConfirm: false,
  requiresProject: true,
  asyncCapable: true,
  tags: ["build", "compile", "class2", "diagnostics"],
  examples: [
    { params: { mode: "BuildChanges" }, note: "Fast incremental build." },
    { params: { mode: "RebuildAll" }, note: "Safest full build." },
  ],
  hints: ["The CLASS 2 IDE must be closed; the action handles this for the selected project."],
});
```

---

## Appendix C: Example `find_action` and `execute_action` payloads

```json
{
  "action": "lasal_find_action",
  "params": {
    "query": "compile plc",
    "domain": "class2",
    "limit": 3
  }
}
```

```json
{
  "action": "lasal_execute_action",
  "params": {
    "action": "class2.build.compile",
    "params": { "mode": "BuildChanges" },
    "project": "C:\\Projects\\Palletizer"
  }
}
```

```json
{
  "action": "lasal_execute_action",
  "params": {
    "action": "class2.build.download",
    "params": { "connection": "TCPIP:192.168.1.100" },
    "confirm": true
  }
}
```

---

## Appendix D: File classification summary

| File | Edit directly? | Validate with |
|---|---|---|
| `.lsm` | Yes, carefully | XML round-trip; station references |
| `.lss` | Yes, surgical | XML round-trip; preserve unknown elements |
| `.lcp` | Manifest registration only via engine | CLASS 2 compile/caches |
| `.st` | Method bodies via file; declarations/CRC via engine | latin1 + compile + `@CT_` checks |
| `.lcn` | Init values cautiously; structure via engine | XML round-trip + compile |
| `.lvp` | Use VISU engine for publish; inspect carefully | VISU engine |
| Dashboard JSON | Yes | JSON schema + VISU publish |
| `.lpr` | No | COM automation |
| `LSEOnlineConfig.xml` | Yes, surgical | XML round-trip |
| `Stations.txt` | Yes, carefully | Station table validation |
| `.lutc` | Generate | MachineManager schema + dry run |

---

## Appendix E: Evaluation task suite

1. “Publish the selected VISU project.”
2. “Add a `Motor` object to the `Main` network and connect `Sensor1.c_Speed` to `Motor1.s_Speed`.”
3. “Compile and download the PLC to the local LARS instance.”
4. “Read `Motor1.s_Speed` and set it to 1200.”
5. “Create a LARS workspace for the `PLC` station with a custom port block, start it, and run a scenario that asserts the motor starts.”
6. “Change the title text in dashboard `Main` and publish.”
7. “Compile the LASAL SCREEN project and download it to the panel.”
8. “Scan the project for duplicate GUIDs and fix them.”
9. “Switch from project A to project B and verify no state leaks.”
10. “Run two LARS workspaces from same-named projects.”
11. “Find the action for OPC UA export and run it.”
12. “Recover from an invalid `params` error using the schema and example returned by the tool.”

---

## Appendix F: Glossary

- **Action catalog:** Local registry of all callable LASAL capabilities with schemas, metadata, and handlers.
- **Profile:** A filtered view of the catalog for a project type or lifecycle.
- **ProjectContext:** Immutable snapshot of the target project for one action execution.
- **Project ID:** Stable hash of the canonical project path, used for state and runtime ownership.
- **Engine lock:** Cross-process mutex that serializes vendor engine operations.
- **Project write lock:** Cross-process lock for mutating actions on one project.
- **File stamp:** mtime/size/hash snapshot used for optimistic concurrency.
- **Lease:** Time-bounded ownership of a LARS instance by an agent.
- **Risk tier:** `read`, `write`, `destructive`, or `deploy`.
- **Effective port:** The port a LARS instance actually serves, which may differ from the configured port.

---

*End of plan.*
