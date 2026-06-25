# Universal LASAL MCP Server — Technical Specification

> Reverse-engineered from a local Sigmatek LASAL installation (LASAL CLASS 2,
> VISUDesigner, MachineManager, LARS) and the reference solution
> `NVeniaFil1057A01`. Scope is strictly the **software lifecycle mechanism**
> (file layout, build, config, deploy, verify) — no application logic.

---

## 0. Executive Summary

LASAL exposes a **fully scriptable, headless lifecycle** through three
CLI-invokable engines, each hosting an embedded Python interpreter with a
Sigmatek automation module:

| Engine | Executable | Script flag | Python | Module | Domain |
|---|---|---|---|---|---|
| LASAL CLASS 2 | `Class2\Bin\Lasal2.exe` | `/script:"<py>"` | 2.7 | `sigmatek.lasal.batch` | PLC compile / bootdisk / download / online |
| VISUDesigner | `VISUDesigner\VISUDesigner.exe` | `--script "<py>" <args>` | 3.12 | `sigmatek.lasal.lvd` | HMI create / publish / download |
| MachineManager | `MachineManager\Bin\MachineManager.exe` | `/update:"<lutc>"` | (REXX/online) | Update-Tool instruction table | Multi-station orchestrated deployment + verify |

The MCP server is therefore a **script-generator + process-runner + log/exit-code
parser**, plus a thin **plain-text config editor** for target addresses.

---

## 1. Project Architecture & File Mapping

### 1.1 Topology (reference solution `NVeniaFil1057A01`)

```
NVeniaFil1057A01.lsm                      ← Solution master (XML, ISO-8859-1)
├─ Internal\OpenViews.xml                 ← IDE UI state (ignore)
└─ Stations\
   ├─ HMI\HMI.lss                         ← Station def (XML) → online conn + projects
   │  ├─ NveniaFil_HMI1057A01\…lcp        ← CLASS 2 project (PLC-style logic on panel)
   │  └─ NveniaFil_Visu1057A01\…lvp       ← VISUDesigner project (folder DB, JSON)
   ├─ PLC\PLC.lss
   │  └─ NveniaFilMach1057A01\…lcp        ← CLASS 2 project (machine PLC)
   └─ Local\Local.lss
      └─ LocalV1.0\…lcp                   ← CLASS 2 project (no online conn = sim/local)
```

### 1.2 File-type dictionary

| Ext | Format | Role |
|---|---|---|
| `.lsm` | XML | **Solution** master — lists station `.lss` files |
| `.lss` | XML | **Station** — **online connection (target IP/port/TLS)** + member projects |
| `.lcp` | XML | **CLASS 2 project** definition (source/networks/objects/HW tree) |
| `.lvp` | JSON | **VISUDesigner project** metadata (project is a *folder database*) |
| `.lpr` | — | **LASAL Screen / LSE** project (legacy HMI; supported by MachineManager) |
| `.lcb` | binary | Compiled **CLASS 2 binary** (build artifact) |
| `.lob` | binary | **Bootdisk** load objects (per-architecture: `arm` / `x86`) + `project.idx`, `index.txt` |
| `.lba` | binary | Object/config network archive (e.g. `Network\ConfigObjects.lba`) |
| `.lcf` | binary | **Connection file** (encryptable) |
| `.lbi` | binary | **OS image** (firmware) |
| `.lutc` | XML/binary | **MachineManager Update-Tool procedure** (instruction table) |
| `.mme` | text | MultiMaster export (inter-station server map) |
| `.lcz` | zip | Class/network import bundle |

### 1.3 Where the network/target config lives — **plain text**

**(A) IDE download/online target — `<station>.lss` (plain XML):**
```xml
<SlnStation Name="PLC" OnlineConnection="PLC10 (Project)" Color="5295279">
  <OnlineConnectionInfo>
    <TCPIP ConfigName="PLC10" BUS="3" Password="" IP="10.195.0.10"
           PORT="1954" SomeFlags="0" PLCID="" Repeater="0"
           SSLTLS="0" Favorite="0"/>
  </OnlineConnectionInfo>
  <SlnProjects> … </SlnProjects>
</SlnStation>
```
- `IP` / `PORT` (1954 = Sigmatek online protocol) / `SSLTLS` (0|1) / `Password` / `BUS` (3 = TCP/IP) / `Repeater` (routing).
- **This is the file `set_target_ip` edits.** It is the connection profile the IDE writes when a user configures a target.

**(B) Runtime inter-station map — `…\Network\Stations.txt` (plain text):**
```
[VERSION]
1.00
[CONNECTIONS]
"PLC","TCPIP:10.195.0.10",0
```
Used by the running application (MultiMaster/DSCOMM) to reach peer stations — *separate* from the IDE download channel.

**(C) VISUDesigner project meta — `.lvp` (JSON):** `name`, `id`, `version`,
per-file-entry versions. The HMI station's runtime connection is set through the
`lvd` API (`CreateStation`/`SetStationProperties`, `strConnSetting`), not the `.lvp`.

---

## 2. Toolchain & Installation Discovery

> Note the **split install root**: 32-bit tools under `Program Files (x86)`,
> the 64-bit VISUDesigner under `Program Files`. Discover via the default paths
> below; optional registry fallback `HKLM\SOFTWARE\[WOW6432Node\]Sigmatek\*`
> (verify on each target).

### 2.1 LASAL CLASS 2 — `C:\Program Files (x86)\Sigmatek\Lasal\Class2`
- `Bin\Lasal2.exe` — IDE **and headless script host** (`/script`, `/project`, `/download`, `/ip`).
- `Bin\PlcDiag.exe` — PLC diagnostics / log viewer.
- `Bin\Encrypter.exe`, `BOOTDISK.EXE`, `arch.exe`.
- `Runtime\CCompiler\bin\{arm,intel}` — GCC-style cross compilers (target codegen).
- `Runtime\Scripting\` — embedded **CPython 2.7** + `Lib.zip` + `DLLs\`.
- `Runtime\Scripting\sigmatek\lasal\batch.py` — **the CLASS 2 automation API** (wraps C modules `_batch`, `_internal`, `_classes`, `_drive`).
- `Runtime\Rexx\` — bootdisk/updatedisk REXX macros (`autoexec.lsl`, `AUTOSTRT*.rex`).
- `Bin\LASAL_CLASS_2_EN.chm` — full reference (scripting chapter).

### 2.2 VISUDesigner — `C:\Program Files\Sigmatek\Lasal\VISUDesigner`
- `VISUDesigner.exe` (+ `VISUDesigner.dll`) — WPF app + **headless script host** (`--script`).
- `Scripting\3_12\sigmatek\lasal\lvd.py` (and a copy at `VISUDesigner\lvd.py`) — **the VISU automation API** (Python 3.12).
- `ScriptingWrapper.dll`, `PythonInterpreter3_12.dll`, `Blockly\` — in-app scripting (not needed externally).
- `LVD_MM_IPC.dll`, `Nancy.Hosting.Self.dll` — IPC/HTTP bridge to MachineManager (internal).
- `Help\VISUDesigner_EN.chm`, `Help\VISURuntime_EN.chm`.

### 2.3 MachineManager — `C:\Program Files (x86)\Sigmatek\Lasal\MachineManager`
- `Bin\MachineManager.exe` — multi-station deploy orchestrator (`/update:"<.lutc>"`, `/connection`).
- `Runtime\Examples\` — sample `.lutc` procedures.
- `Bin\LASAL_MachineManager_EN.chm` — Update-Tool command reference.

### 2.4 LARS (LASAL Runtime System) — `C:\Program Files (x86)\Sigmatek\Lars`
- `Lars.exe` (PC soft-runtime / online server), `LARSConfigTool.exe`, `autoexec.lsl`.
- Relevant for a **virtual/local target** (the `Local` station). Optional for the MCP.

### 2.5 Headless invocation contracts (verified from help docs)

**CLASS 2:**
```
Lasal2.exe /script:"C:\gen\build.py"
Lasal2.exe /script:"C:\gen\build.py 'arg with space' 3 PARAM"
```
- Args reach the script via `sys.argv`.
- **Exit code `0` = success; `102` = aborted by an untrapped exception.**

**VISUDesigner:**
```
VISUDesigner.exe --script "C:\gen\deploy.py" "C:\…\Proj.lvp" 4 true
```
- `--script` (double dash) + script path; following tokens are `sys.argv[1..]`
  (always strings) until the next `--` flag. Quote tokens containing spaces.
- `--script` also **suppresses the crash-report dialog** (true headless).
- App **exits after the script** unless `lvd.SetExitAppAfterScript(False)`.

**MachineManager:**
```
MachineManager.exe /update:"D:\proj\MyUpdate.lutc"
```
- Runs the Update-Tool instruction table headlessly; writes one log file per run
  into the configured **Log-Folder**; `HOLD ON ERROR` aborts the sequence.

---

## 3. Deployment & Transfer Mechanism

### 3.1 Transport
Download/online uses Sigmatek's **proprietary online protocol over TCP, default
port `1954`** (optionally **TLS** when `SSLTLS=1`, via the bundled
`libssl-1_1`/`libcrypto-1_1`). Implemented in `OnlineSigmatek.dll`,
`ATLOnlineConfig32.dll`, `LasalOnlineHelper.dll`, `Lasal32.dll`.
**It is NOT FTP/SFTP/SMB.** `BUS="3"` in the `.lss` selects TCP/IP (vs CAN/serial).

### 3.2 What gets pushed
- **CLASS 2:** compiled `.lob`/RAM image + `project.idx` (+ connection file,
  MultiMaster `Stations.txt`, OPC-UA config, optional loader/OS).
- **VISUDesigner:** the **`Publish\webroot\`** tree (HTML5 web HMI) + the
  **`Runtime\rt\`** engine bundle.
- **Whole solution:** MachineManager bundles per-station artifacts and transfers
  each to its station's IP (online) or to an **update stick** (`.lutc` + boot folder).

### 3.3 Where target connection profiles are written
- IDE/download channel → **`<station>.lss` → `<TCPIP …>`** (§1.3 A).
- VISU runtime station → `lvd.CreateStation(..., strConnSetting=…)` /
  `lvd.SetStationProperties(...)`.
- CLASS 2 MultiMaster peer → `batch.MMChangeConnectionOption(prj, station, ip)`
  and the runtime `Stations.txt`.
- A download may also target an **ad-hoc address** with no stored profile via the
  `TCPIP:<ip>[:port]` / `TCPIP:<dns>` connection string (both `batch.Download`
  and `lvd.DownloadProject` accept it).

---

## 4. Verification & Logging

### 4.1 Programmatic success signals
| Engine | Success signal | Failure signal |
|---|---|---|
| CLASS 2 (`Lasal2 /script`) | process exit `0`; per-command `bool` True | exit `102` (untrapped exception); `bool` False; `BatchError` if `SetExceptionOnError(True)` |
| VISUDesigner (`--script`) | command returns `True`; clean exit | returns `False`; raises if `SetExceptionOnError(True)` |
| MachineManager (`/update`) | per-instruction STATE 100%; no `HOLD ON ERROR` abort | non-100% / abort in log; on-device 7-seg `98`, Error-LED |

### 4.2 Log capture
- **CLASS 2:** `batch.OpenLogfile(path, layout="[%d{%H:%M:%S} (%p) %c] %m%n", append)`
  → log4cpp file (parse `(ERROR)`/`(FATAL)` tokens); plus IDE Output window.
- **VISUDesigner:** Python log file (UTC timestamps) + Python output panel; capture
  the process stdout/stderr.
- **MachineManager:** one timestamped log per run in the Update-Tool **Log-Folder**.
- **MCP convention:** every generated script first calls `OpenLogfile()` to a
  server-controlled path so the server has a deterministic artifact to parse,
  in addition to the exit code.

### 4.3 Live target state (CLASS 2 `batch`)
- `GetPlcState(prj, conn)` → `PLCStates` enum (`Offline=39`, Run/Stop/…).
- `OpenPlcConnection` → `ReadPlcValue(name, dict)` / `WritePlcValue(name, val)` → `ClosePlcConnection`.
- `GetProcessorArch(conn)` → `"x86"` | `"ARM"` | `"unknown"`.

### 4.4 Live target state (MachineManager Update-Tool instructions)
- `WAIT FOR STATE <status> <timeout_ms>`, `WAIT FOR TIME`, `EXISTS FILE`.
- `WRITE NUMBER`/`WRITE STRING` to a server; `CLI COMMAND RESPONSE` (response → log).
- Runtime reachability via the generated `_SIG_LSL_CMultimasterState` class
  (`Offline` / `Online_Initializing` / `Online` / `Online_NotAllServerAvailable`).

---

## 5. MCP Server Specification

### 5.1 Architecture

```
                ┌─────────────────────────── LASAL MCP Server ───────────────────────────┐
 MCP client ───►│  tool dispatch → { config editor | script generator | process runner } │
                │      │                                   │                              │
                │      ▼ (XML/JSON/txt edit)               ▼ (spawn + capture)            │
                │  .lss / Stations.txt              Lasal2.exe /script:gen.py             │
                │                                   VISUDesigner.exe --script gen.py …     │
                │                                   MachineManager.exe /update:gen.lutc    │
                │      ▲ parse exit code (0/102), log4cpp/python/MM log, bool returns      │
                └──────┴──────────────────────────────────────────────────────────────────┘
```

Implementation notes:
- Host language is free (Node/TS or Python). The server **emits** Python 2.7
  (`batch`) and Python 3.12 (`lvd`) scripts and `.lutc` files; it does not import
  them. Scripts are written to the scratch dir and passed by path.
- Long operations (compile/publish/download) run async; expose a job id + poll.
- Discover engine paths once at startup (§2) and expose via `get_toolchain_info`.
- Treat compile/deploy as **serialized per project** (the IDE host is single-instance).

### 5.2 Tool catalogue

#### A. Discovery & State

**`get_toolchain_info`** — locate installed engines & versions.
```json
{ "type": "object", "properties": {}, "additionalProperties": false }
```

**`list_solution`** — parse `.lsm`/`.lss` into a structured tree.
```json
{
  "type": "object",
  "properties": { "solutionPath": { "type": "string", "description": "Path to the .lsm file" } },
  "required": ["solutionPath"], "additionalProperties": false
}
```

**`get_target_config`** — read a station's `<TCPIP>` profile.
```json
{
  "type": "object",
  "properties": {
    "stationLssPath": { "type": "string", "description": "Path to the <station>.lss file" }
  },
  "required": ["stationLssPath"], "additionalProperties": false
}
```

**`set_target_ip`** — write the IDE download/online target into the `.lss`
(and optionally the runtime `Stations.txt`).
```json
{
  "type": "object",
  "properties": {
    "stationLssPath": { "type": "string" },
    "ip":   { "type": "string", "pattern": "^(\\d{1,3}\\.){3}\\d{1,3}$|^[A-Za-z0-9.-]+$" },
    "port": { "type": "integer", "default": 1954, "minimum": 1, "maximum": 65535 },
    "useTls":   { "type": "boolean", "default": false },
    "password": { "type": "string", "default": "" },
    "configName": { "type": "string", "description": "Address-book label, e.g. PLC10" },
    "updateRuntimeStationsTxt": { "type": "boolean", "default": false }
  },
  "required": ["stationLssPath", "ip"], "additionalProperties": false
}
```
*Under the hood:* edit `<TCPIP IP PORT SSLTLS Password ConfigName BUS="3">`;
preserve ISO-8859-1 encoding; optionally rewrite the `[CONNECTIONS]` line in
`…\Network\Stations.txt`.

**`read_plc_state`** — live CPU state.
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string", "description": ".lcp; omit to use connectionString only" },
    "connectionString": { "type": "string", "description": "Address-book name or 'TCPIP:<ip>[:port]'" }
  },
  "required": [], "additionalProperties": false
}
```
*Under the hood (CLASS 2):* `GetPlcState` → enum string; also returns
`GetProcessorArch`.

**`read_plc_value` / `write_plc_value`** — online channel I/O (CLASS 2).
```json
{
  "type": "object",
  "properties": {
    "connectionString": { "type": "string" },
    "name":  { "type": "string", "description": "Object.Channel path" },
    "value": { "type": "string", "description": "write only" }
  },
  "required": ["connectionString", "name"], "additionalProperties": false
}
```

#### B. CLASS 2 (PLC) lifecycle  — engine: `Lasal2.exe /script`

**`compile_class2_project`**
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string", "description": "Path to the .lcp file" },
    "mode": { "type": "string", "enum": ["RebuildAll","BuildChanges","UserClassesOnly"], "default": "RebuildAll" },
    "extraOptions": { "type": "array", "items": { "type": "string",
      "enum": ["EraseObjs","SuppressRebuild","NoDebugInfo","NoClearOutput"] }, "default": [] }
  },
  "required": ["projectPath"], "additionalProperties": false
}
```
*Generated script:* `OpenLogfile` → `LoadProject` → `Compile(prj, <flags>)` →
`Save` → `CloseProject`; success = exit 0 + no `(ERROR)` in log.

**`create_class2_bootdisk`**
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string" },
    "outputPath":  { "type": "string" },
    "platform": { "type": "string", "enum": ["AUTO","ALL","ARM","X86"], "default": "AUTO" },
    "overwrite": { "type": "boolean", "default": true },
    "visuPublishFolder": { "type": "string", "description": "optional LVD Publish dir to bundle" },
    "includeOs": { "type": "string", "description": "optional LasalOS file" }
  },
  "required": ["projectPath","outputPath"], "additionalProperties": false
}
```
*Generated script:* `CreateBootdisk` / `CreateBootdiskMngr(..., iPlatformType,
rstrFolderVisu_LVD=...)`.

**`deploy_class2_project`** — download to live PLC.
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string" },
    "connectionString": { "type": "string", "description": "name or 'TCPIP:<ip>[:port]'; omit = use project profile" },
    "addLoaderAnyway": { "type": "boolean", "default": false },
    "startAfter": { "type": "boolean", "default": false }
  },
  "required": ["projectPath"], "additionalProperties": false
}
```
*Generated script:* `LoadProject` → `Download(prj, conn, bAddLoaderAnyway)` →
optional `Start(prj, conn)` → `GetPlcState` for confirmation.

**`set_plc_run_state`** — start / stop / reset.
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string" },
    "connectionString": { "type": "string" },
    "action": { "type": "string", "enum": ["start","stop"] }
  },
  "required": ["action"], "additionalProperties": false
}
```

**`analyze_class2_code`** — static analysis → result file.
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string" },
    "resultFile":  { "type": "string" },
    "sourceFile":  { "type": "string", "description": "optional: analyze one file" }
  },
  "required": ["projectPath","resultFile"], "additionalProperties": false
}
```

**`run_class2_script`** — escape hatch for any `batch` sequence.
```json
{
  "type": "object",
  "properties": {
    "scriptBody": { "type": "string", "description": "Python 2.7 using 'import sigmatek.lasal.batch as batch'" },
    "args": { "type": "array", "items": { "type": "string" }, "default": [] }
  },
  "required": ["scriptBody"], "additionalProperties": false
}
```

#### C. VISUDesigner (HMI) lifecycle — engine: `VISUDesigner.exe --script`

**`publish_visu_project`**
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string", "description": ".lvp file or project dir" },
    "debugPublish": { "type": "boolean", "default": false }
  },
  "required": ["projectPath"], "additionalProperties": false
}
```
*Generated script:* `lvd.SetExceptionOnError(True)` → `LoadProject` →
`PublishProject(prj, debug)` → produces `Publish\webroot`.

**`deploy_visu_project`** — publish (optional) + download to panel.
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string" },
    "connectionString": { "type": "string", "description": "conn name or 'TCPIP:<ip>[:port]'/'TCPIP:<dns>'" },
    "mode": { "type": "string", "enum": ["full","changes","publish_and_changes"], "default": "full",
              "description": "maps to uiFlags 0/1/2" },
    "addRuntime": { "type": "boolean", "default": false }
  },
  "required": ["projectPath","connectionString"], "additionalProperties": false
}
```
*Generated script:* `LoadProject` → optional `PublishProject` →
`DownloadProject(prj, conn, uiFlags, bAddRuntime)`; success = return `True`.

**`set_visu_station_connection`** — set/replace an HMI runtime station target.
```json
{
  "type": "object",
  "properties": {
    "projectPath": { "type": "string" },
    "stationNr": { "type": "integer" },
    "connSetting": { "type": "string", "description": "e.g. 'TCPIP:10.195.0.10'" },
    "name": { "type": "string" }
  },
  "required": ["projectPath","stationNr","connSetting"], "additionalProperties": false
}
```
*Under the hood:* `CreateStation`/`SetStationProperties(strConnSetting=…)` then `SaveProject`.

**`run_visu_script`** — escape hatch for any `lvd` sequence.
```json
{
  "type": "object",
  "properties": {
    "scriptBody": { "type": "string", "description": "Python 3.12 using 'import sigmatek.lasal.lvd as lvd'" },
    "args": { "type": "array", "items": { "type": "string" }, "default": [] },
    "keepAppOpen": { "type": "boolean", "default": false, "description": "calls SetExitAppAfterScript(False)" }
  },
  "required": ["scriptBody"], "additionalProperties": false
}
```

#### D. Orchestration & device ops — engine: `MachineManager.exe /update`

**`deploy_solution`** — build a `.lutc` and deploy multiple stations with verify.
```json
{
  "type": "object",
  "properties": {
    "solutionPath": { "type": "string", "description": ".lsm" },
    "stations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "target": { "type": "string", "description": "station name in the solution" },
          "kind": { "type": "string", "enum": ["class2","visudesigner","screen"] },
          "artifactPath": { "type": "string", "description": ".lcp/.lob dir | .lvp/Publish dir | .lpr/runtime dir" },
          "runtimePath": { "type": "string", "description": "LVD only: …\\Runtime\\rt" },
          "waitForState": { "type": "string", "description": "optional CPU state to wait for" }
        },
        "required": ["target","kind","artifactPath"]
      }
    },
    "logFolder": { "type": "string" },
    "holdOnError": { "type": "boolean", "default": true },
    "rebootAfter": { "type": "boolean", "default": false }
  },
  "required": ["solutionPath","stations"], "additionalProperties": false
}
```
*Under the hood:* emit a `.lutc` whose instruction rows are
`DOWNLOAD LASAL CLASS 2 PROJECT` / `DOWNLOAD LASALVISU DESIGNER PROJECT` /
`DOWNLOAD LASALSCREEN PROJECT`, optional `WAIT FOR STATE`, `RUN PROJECT`,
`REBOOT`; run `MachineManager.exe /update:"<lutc>"`; parse the per-run log.

**`download_os`**
```json
{
  "type": "object",
  "properties": {
    "connectionString": { "type": "string" },
    "osFile": { "type": "string", "description": ".lbi" },
    "rebootTimeoutMs": { "type": "integer", "default": 600000 }
  },
  "required": ["connectionString","osFile"], "additionalProperties": false
}
```

**`transfer_file`** — push/pull/delete on the control.
```json
{
  "type": "object",
  "properties": {
    "connectionString": { "type": "string" },
    "direction": { "type": "string", "enum": ["download","upload","delete"] },
    "localPath": { "type": "string" },
    "remotePath": { "type": "string" }
  },
  "required": ["connectionString","direction","remotePath"], "additionalProperties": false
}
```
*Under the hood:* `batch.DownloadFile/UploadFile/DeleteFileOnPLC` **or** the MM
`DOWNLOAD/UPLOAD/DELETE FILE` instruction.

**`reboot_target`**
```json
{
  "type": "object",
  "properties": {
    "connectionString": { "type": "string" },
    "timeoutMs": { "type": "integer", "default": 300000 }
  },
  "required": ["connectionString"], "additionalProperties": false
}
```

### 5.3 Standard tool result envelope
```json
{
  "type": "object",
  "properties": {
    "ok": { "type": "boolean" },
    "engine": { "type": "string", "enum": ["class2","visudesigner","machinemanager","fs"] },
    "exitCode": { "type": "integer", "description": "0 ok; 102 = CLASS 2 untrapped exception" },
    "durationMs": { "type": "integer" },
    "logPath": { "type": "string" },
    "errors":   { "type": "array", "items": { "type": "string" } },
    "warnings": { "type": "array", "items": { "type": "string" } },
    "data": { "type": "object", "description": "tool-specific (e.g. plcState, arch, value)" },
    "command": { "type": "string", "description": "exact CLI executed (audit)" }
  },
  "required": ["ok","engine"]
}
```

### 5.4 Execution parameters (exact)

| Tool group | Command template | Env / notes |
|---|---|---|
| CLASS 2 | `"<…>\Class2\Bin\Lasal2.exe" /script:"<scratch>\<id>.py"` | script: `import sigmatek.lasal.batch as batch`; first line `batch.OpenLogfile(r"<log>")`, `batch.SetExceptionOnError(True)`. Success = exit 0. |
| VISUDesigner | `"<…>\VISUDesigner\VISUDesigner.exe" --script "<scratch>\<id>.py" <arg1> <arg2> …` | script: `import sigmatek.lasal.lvd as lvd`; `lvd.SetExceptionOnError(True)`; for chained ops `lvd.SetExitAppAfterScript(False)`. |
| MachineManager | `"<…>\MachineManager\Bin\MachineManager.exe" /update:"<scratch>\<id>.lutc"` | set Log-Folder inside the `.lutc`; one log per run; `HOLD ON ERROR` per row. |

- The interpreters and Sigmatek modules ship **inside** each install
  (`Class2\Runtime\Scripting`, `VISUDesigner\Scripting\3_12`); no system Python or
  `PYTHONPATH` is required — the host exe wires `import sigmatek.lasal.*`.
- `REXX_MACROS=C:\LSLCMD` is a LARS/runtime concern (bootdisk REXX), not needed
  for the three script engines.
- Always pass **absolute paths**; quote any path containing spaces (the install
  roots do).

### 5.5 State assessment strategy
1. **Project state** — parse `.lsm` → `.lss` (stations, `<TCPIP>` targets, member
   `.lcp`/`.lvp`); detect VISU build freshness via presence/mtime of
   `Publish\webroot` and `Runtime\rt`; CLASS 2 artifact freshness via `.lcb`/`.lob`
   vs source mtime.
2. **Target reachability/state** — `read_plc_state` (`GetPlcState` enum +
   `GetProcessorArch`) before/after deploy; MM `WAIT FOR STATE` gates within a
   solution deploy.
3. **Build success** — engine exit code (`0` vs `102`) **plus** log scan for
   `(ERROR)`/`(FATAL)` / non-100% MM rows.
4. **Deploy success** — `Download*` boolean/return **plus** post-deploy
   `GetPlcState == Run` (PLC) or HMI station `Online` via MultimasterState; the
   server should re-read state rather than trust the call alone.

---

## 6. Open items to confirm on the live bench
- Exact `PLCStates` enum integers beyond `Offline=39` (read at runtime via `print`).
- Whether `Lasal2.exe /download` / `/ip` direct switches (present in the binary)
  offer a no-script fast path equivalent to the `batch.Download` script.
- `.lutc` on-disk schema (generate one from a known MM solution and diff) before
  emitting them programmatically; `Runtime\Examples` has samples.
- TLS handshake specifics when `SSLTLS=1` (cert/PSK expectations on the target).
