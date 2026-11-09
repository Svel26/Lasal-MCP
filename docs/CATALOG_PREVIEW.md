# Action Catalog Preview

This is the first working slice of the action-catalog architecture described in
`docs/IMPLEMENTATION_PLAN.md`.

It is a separate entrypoint so the existing `lasal-mcp` server stays untouched
while the new interface is evaluated.

## What is implemented

- `src/core/actions/` — action types, registry, local search, JSON Schema
  generation, execution guard, audit and legacy adapter.
- `lasal_find_action` — local, read-only catalog search.
- `lasal_execute_action` — runs one action with parameter validation,
  profile/domain filtering, confirmation and async-job support.
- **80 actions**: shared project targeting plus the CLASS 2, VISU, LASAL
  SCREEN and LARS domains.
- Request-scoped project overrides in `state.ts` via `runWithProject()`.
- Project capability detection (`class2` / `visu` / `screen` / `solution`) and
  `--profile auto`.
- A cross-process **project write lock** for mutating actions, plus file-stamp
  primitives for optimistic concurrency.
- Risk metadata, `confirm=true` enforcement, destructive-action gating and a
  JSONL audit log (`%LOCALAPPDATA%\lasal-mcp\audit.jsonl` by default).
- Unit tests for the registry, search, executor, MCP tool wrappers, project
  override propagation, project locks and capability detection.

## Run it

```powershell
npm run build
npm run start:catalog -- --profile visu
```

MCP client configuration:

```json
{
  "mcpServers": {
    "lasal-visu": {
      "command": "node",
      "args": [
        "C:\\_Projects\\Lasal-MCP\\dist\\serverCatalog.js",
        "--profile",
        "visu",
        "--project",
        "C:\\Projects\\MyVisuSolution"
      ]
    }
  }
}
```

Options:

| Flag | Meaning |
|---|---|
| `--profile <name>` | `auto`, `class2`, `visu`, `screen`, `lars`, `solution`. `auto` detects the project type from `--project`. |
| `--project <path>` | Pin the server process to one project. Required for `--profile auto`. |
| `--allow-destructive` | Allow destructive/deploy actions. They still require `confirm=true`. |
| `--allow-expert` | Allow expert actions such as `class2.script.run`. |

The existing environment variables `LASAL_MCP_PROJECT`, `LASAL_MCP_STATE_FILE`
and `LASAL_MCP_AUDIT_FILE` still apply.

Auto-detection example:

```powershell
npm run start:catalog -- --profile auto --project "C:\Projects\MySolution"
```

### Dedicated bins

The package exposes one bin per profile:

| Bin | Default profile |
|---|---|
| `lasal-class2-mcp` | `class2` |
| `lasal-visu-mcp` | `visu` |
| `lasal-screen-mcp` | `screen` |
| `lasal-lars-mcp` | `lars` |
| `lasal-solution-mcp` | `solution` |
| `lasal-mcp-init` | project scanner / config generator |

They all share the same code and state; only the catalog filter and default
profile differ. `--profile` still overrides the bin's default, and
`--profile auto` detects the project type when `--project` is supplied.

```powershell
npm run build
npm run start:class2 -- --project "C:\Projects\MySolution"
npm run start:lars
```

### Generate an MCP config

Scan a project and print (or write) a ready-to-use MCP client config:

```powershell
npm run init -- --project "C:\Projects\MySolution"
npm run init -- --project "C:\Projects\MySolution" --write .mcp.json
```

`--json` prints only the config. `--write` refuses to overwrite an existing
file unless `--force` is passed.



## Tools

| Tool | Purpose |
|---|---|
| `select_project` | Select the session project. |
| `lasal_status` | Engine, project, process, HMI and agent status. |
| `check_job_status` | Poll async actions started with `async: true`. |
| `lasal_find_action` | Search action IDs, schemas, hints, risk flags and examples. |
| `lasal_execute_action` | Execute one action by canonical ID or alias. |

The full generated reference is [`docs/ACTIONS.md`](ACTIONS.md). Regenerate
it with `npm run docs:actions`; CI can verify it with
`npm run docs:actions:check`.

Resources: `lasal://guide`, `lasal://project/status`, `lasal://stations`,
`lasal://projects`, and `lasal://classes/{className}`.

## Pilot actions

**Project**

- `project.target_ip.set` — `set_target_ip`, `set_target`

**CLASS 2**

- `class2.project.inspect`
- `class2.class.read_source`
- `class2.class.write_source`
- `class2.build.compile`
- `class2.build.download` (deploy, `confirm=true`)
- `class2.plc.state`
- `class2.plc.start` (destructive, `confirm=true`)
- `class2.plc.stop` (destructive, `confirm=true`)
- `class2.plc.values.read`
- `class2.plc.values.write`
- `class2.changes.apply`
- `class2.network.create`
- `class2.object.add`
- `class2.connection.create`
- `class2.class.create`
- `class2.project.file.add`
- `class2.project.clean`
- `class2.guid.validate`
- `class2.script.run` (expert, `confirm=true`, requires `--allow-expert`)
- `class2.diagnostics.code_analysis`
- `class2.diagnostics.trace`
- `class2.diagnostics.file.upload`
- `class2.diagnostics.file.download`
- `class2.diagnostics.file.delete` (destructive, `confirm=true`)
- `class2.diagnostics.os.download` (deploy, `confirm=true`)
- `class2.diagnostics.ram.clear` (destructive, `confirm=true`)
- `class2.diagnostics.project.backup`
- `class2.editor.open`
- `class2.editor.close` (destructive, `confirm=true`)
- `class2.bootdisk.create` (deploy, `confirm=true`)

**VISUDesigner**

- `visu.project.inspect`
- `visu.editor.open`
- `visu.editor.close` (destructive, `confirm=true`)
- `visu.hmi.start`
- `visu.hmi.stop` (destructive, `confirm=true`)
- `visu.hmi.status`
- `visu.publish`
- `visu.download` (deploy, `confirm=true`)
- `visu.textlist.export`
- `visu.textlist.import`
- `visu.project.update_stations`

**LASAL SCREEN**

- `screen.project.info`
- `screen.project.create`
- `screen.project.compile`
- `screen.project.download` (deploy, `confirm=true`)
- `screen.project.apply_changes`
- `screen.project.merge`
- `screen.project.fuse`
- `screen.text.export_xml`
- `screen.text.import_xml`
- `screen.variables.import`
- `screen.textlist.create`
- `screen.textlist.import`
- `screen.textlist.get_texts`
- `screen.language.add`
- `screen.settings.set`
- `screen.image.insert`
- `screen.server.get_property`
- `screen.server.set_property`
- `screen.buttons.update`
- `screen.softkeys.update`
- `screen.editor.open`
- `screen.editor.close` (destructive, `confirm=true`)
**LARS**

- `lars.workspace.list`
- `lars.workspace.setup`
- `lars.workspace.update`
- `lars.workspace.remove` (destructive, `confirm=true`)- `lars.workspace.gc` (destructive, `confirm=true`)
- `lars.instance.start`
- `lars.instance.stop` (destructive, `confirm=true`)
- `lars.instance.screenshot`
- `lars.station.target`
- `lars.station.restore`
- `lars.project.target_pc`
- `lars.doctor`
- `lars.simulate`
- `lars.scenario.run`

**Deploy / MachineManager**

- `deploy.all.run` (deploy, `confirm=true`)
- `deploy.solution.run` (deploy, `confirm=true`)

## Example calls

Find CLASS 2 compile actions:

```json
{
  "tool": "lasal_find_action",
  "arguments": {
    "query": "compile plc",
    "domain": "class2",
    "limit": 5
  }
}
```

Compile incrementally:

```json
{
  "tool": "lasal_execute_action",
  "arguments": {
    "action": "class2.build.compile",
    "params": {
      "options": "BuildChanges"
    }
  }
}
```

Download and start a PLC:

```json
{
  "tool": "lasal_execute_action",
  "arguments": {
    "action": "class2.build.download",
    "params": {},
    "confirm": true
  }
}
```

Find the text-list actions:

```json
{
  "tool": "lasal_find_action",
  "arguments": {
    "query": "textlist",
    "domain": "visu",
    "limit": 5
  }
}
```

Export text lists:

```json
{
  "tool": "lasal_execute_action",
  "arguments": {
    "action": "visu.textlist.export",
    "params": {
      "csv_path": "C:\\Temp\\visu-texts.csv"
    }
  }
}
```

Download to a panel:

```json
{
  "tool": "lasal_execute_action",
  "arguments": {
    "action": "visu.download",
    "params": {
      "connection": "TCPIP:192.168.1.100"
    },
    "confirm": true
  }
}
```

Start a long-running publish as a background job:

```json
{
  "tool": "lasal_execute_action",
  "arguments": {
    "action": "visu.publish",
    "params": {},
    "async": true
  }
}
```

Then poll `check_job_status` with the returned `jobId`.

Run a LARS/PLC scenario in one engine call:

```json
{
  "tool": "lasal_execute_action",
  "arguments": {
    "action": "lars.scenario.run",
    "params": {
      "steps": [
        { "type": "set", "channel": "Motor1.s_Speed", "value": "1200" },
        { "type": "wait", "channel": "Motor1.s_Speed", "equals": "1200", "timeout_ms": 2000 },
        { "type": "assert", "channel": "Motor1.s_Speed", "min": 1100, "max": 1300 }
      ]
    }
  }
}
```

Generate a multi-station `.lutc` for review:

```json
{
  "tool": "lasal_execute_action",
  "arguments": {
    "action": "deploy.solution.run",
    "params": {
      "stations": [{ "station": "PLC", "class2": true }],
      "dry_run": true
    },
    "confirm": true
  }
}
```

## Safety defaults

- Destructive and deploy actions are disabled unless `--allow-destructive` is
  set.
- Even when enabled, they require top-level `confirm=true`; putting `confirm`
  inside `params` does not satisfy the check.
- Every executed action writes an audit record with redacted sensitive values.
- Mutating actions take a cross-process **project write lock**; read-only
  actions do not. Two agents editing the same project therefore serialize
  instead of racing.
- File-stamp helpers (`stampFile` / `assertUnchanged`) are available for
  optimistic concurrency; legacy handlers are being migrated to use them.
- `lasal_find_action` never calls an engine or PLC.
- Invalid parameters return the field errors, JSON Schema and a valid example.

## Known limitations

- LARS workspace update covers ports, paths, memory sizes and the screen project.
  Full LARSConfigTool parity (drive maps, every GUI field, config import/export)
  is still pending.
- The LARS scenario runner supports set/read/wait/assert/sleep. Trace capture
  and screenshot steps in the same scenario are not implemented yet.
- Project context detects stations and capabilities, but there is no cached
  project registry yet; capability detection re-reads the solution per action.
- The HMI runtime is still a singleton. A second project's start is now refused
  instead of silently killing the first; use separate processes/VMs for
  parallel HMI simulations.
- `stampFile` / `assertUnchanged` exist, but the legacy file-writing handlers
  do not call them yet; the project write lock is the current protection.
- `--profile` filters execution, but the preview catalog contains all 80
  actions; unavailable domains are rejected by `lasal_find_action` and
  `lasal_execute_action`.
- `lasal-mcp init` writes a standalone config; it does not merge into an
  existing client config automatically.

## Next steps

1. Complete LARSConfigTool parity (config import/export, every GUI field) and
   add trace capture to scenarios.
2. Wire file stamps into `apply_project_changes` and VISU/LSE file mutations.
3. Add the full LLM-driven eval harness on top of the deterministic search
   benchmark.
4. Run the lab suite for the new domains and bins.
5. Investigate multi-instance HMI DataService support.
