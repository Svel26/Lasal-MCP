# LASAL SCREEN (LSE) Automation Reference

> Reverse-engineered from a local Sigmatek LASAL installation (LASAL SCREEN
> **01.01.197**, `Screen\LSE_modeless.exe`), its registered type library
> `LASALScreen.tlb` (v2.0), the shipped MachineManager examples, and live COM
> probes against the example project. All calls listed as "verified" were
> executed successfully against LSE 01.01.197 on Windows.

The MCP surfaces this through the `lse_project`, `manage_lasalscreen`, and
`deploy_solution` tools plus the LARS screen workflow in `lars_runtime`.

---

## 1. Automation server

| Property | Value |
|---|---|
| ProgID | `LASALScreen.Application` (version-independent), `LASALScreen.Application.1` |
| CLSID | `{82A49236-710D-4A68-8D66-1FC2312CABAB}` |
| Type library | `LASALScreen 2.0`, `{DC9303D6-0976-4025-AF16-6C1139ACC527}`, `Screen\LASALScreen.tlb` |
| LocalServer32 | `C:\Program Files (x86)\Sigmatek\Lasal\Screen\LSE_modeless.exe` |
| Registration | **32-bit view only** (`HKLM\SOFTWARE\Classes\CLSID\...\LocalServer32` under WOW6432Node). Clients must be 32-bit or COM will report "Class not registered". |
| Registration UI | LSE has a registration dialog ("Scripting / Automation") to (un)register the components — see LSE change history DS2202 (01.01.129). |
| Lifetime | The server is out-of-process; it exits when the last client releases it (no `Quit` method exists). Killing `LSE_modeless.exe` releases `.lpr` file locks. |

The MCP checks the registration (32/64 registry views) and runs generated
PowerShell through `%SystemRoot%\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`
when the server is registered 32-bit.

## 2. Object model (from the type library)

### IApplication
`Open(PrjFileName)` · `New(PrjFileName)` (verified: creates a fresh project) · `ActiveProject` ·
`ExportTo(PrjFileName, Overwrite)` · `ShowWindow(lKind)` · `EnableLSE(bEnableLSE)` ·
`LogFileName` · `LogLevel` · `TestFunc_V1_5`

### IProject
Lifecycle: `Compile()` · `Save()` · `SaveAs(PrjFileName)` · `Close(Save)` ·
`DownloadProject(Run)` · `Fuse(FuseFileName, DoCriticalChanges)`

Merge/import: `Merge(PrjFileName, Overwrite)` · `MergeEx(PrjFileName)` ·
`MergeParameter` (→ IMergeParameter) · `ImportSCL(SCLName)` ·
`ImportVariables(VarFileName, StationNumber)` · `ImportTextList(TextList, TextFileName, LanguageID)` ·
`ImportTextFile(TextFileName, LanguageID)` · `ImportFromXML(XMLFileName)`

Text/XML export: `ExportToXML(XMLFileName, Overwrite)` · `ExportTextLists` ·
`ExportTextList(pTextListItem)` · `ExportTextListsToXML()` · `ExportTextListToXML(pTextListItem)` ·
`ExportLanguagesToXML()` · `ExportLanguageToXML(pLanguageAtm)` ·
`AddContainerInfo(AddContainerInfo)` · `UseSortedArray(UseSortedArray)` (options for XML export, added 01.01.167)

Project export: `Export(SettingsFileName, PrjFileName, Overwrite)` · `ExportTo(PrjFileName, Overwrite)` (application level)

Languages: `Languages` · `ClearCompilationLanguages()` · `AddCompilationLanguage(LanguageID)` ·
`ActualLanguage` (getter takes `RestoreToOriginalAtExit`; verified set `ActualLanguage = <LCID>`)

Bulk updates: `UpdateButtons(PropertyIndex, variant_in, Invers)` · `UpdateSoftkeys(PropertyIndex, variant_in, Invers)`

Collections: `Screens` · `Windows` · `Servers` · `Images` · `TextLists` · `Alarms` ·
`TextSchemes` · `Themes` · `Colors` · `Objects` · `GlobalScreen` · `Settings`

### IMergeParameter
`Overwrite` · `DeepMerge` · `SearchByName` · `SkipGlobalScreen` ·
`ScreenXOffset` · `ScreenYOffset` · `SoftkeyOffset` · `SoftkeyValid`
(verified: property get/set through late binding works)

### Collections / items
- `IScreenCollection.Item(ScreenIdentifier, IDIsIndex)` · `.Count`; `IScreen`: `Name`, `Delete`, `Export`, `TextList`, `UpdateButton(ButtonName, PropertyIndex, variant_in, Invers)`
- `IServerCollection.Item(ServerIdentifier, StationNumber)` · `.Count`; `IServer`: `Name`, `Delete`, `Export`, `Property(PropertyIndex)` (get/set), `SetTextProperty(PropertyIndex, TextMngrName, TextIndex)`, `SetTextPropertyParam(PropertyIndex, ParameterIndex, ParameterValue)`

  *Server access note (verified on 01.01.197):* the station-number parameter of `Item` is
  mandatory — a name lookup without it fails with "Missing parameter (station number)", and
  passing the wrong station fails with "Requested server not found". The practical headless
  approach (used by the MCP `server_get_property`/`server_set_property` operations) is to
  **enumerate** with `Item(index)` and match `Name`, then get/set via `Property(id)` with the
  `LSServerProperty` constants above.
- `ITextListCollection.Item(TextListIdentifier)` · `.Count` · `Insert(TextListName, Text)`; `ITextListItem`: `Name`, `Export`, `Item(TextItemIdentifier)` · `.Count` · `ItemGUID(strGUID)` · `Insert(Text)`; `ITextItem`: `Text(LanguageID)` (get/set), `GUID(LanguageID)`
- `IWindowCollection` / `ILSEWindow`: as screens
- `IImageCollection.Item(ImageIdentifier)` · `.Count` · `Insert(ImageFile, TransparentRGB)`; `ILSEImage`: `Name`, `Delete`
- `IAlarmAtmCollection.Item(AlarmIdentifier)` · `.Count`; `IAlarmAtm`: `Name`, `Export`, `Property(PropertyIndex)`, `SetTextProperty`, `SetTextPropertyParam`
- `ITextSchemeAtmCollection` / `IThemeCollection` (+`ItemByID`) / `IColorAtmCollection` / `IObjectAtmCollection` / `ILanguageAtmCollection` (+`ItemByLanguageID`)
- `ISettings`: `CompilerVersion` (get/set), `CompilerWarnings`/`SetCompilerWarnings`, `OnlineConnection` (name; must exist in the LASAL address book — verified error otherwise), `OnlineIPAddress`, `ScreenResolution`/`SetScreenResolution(w,h)`, `TargetResolution`/`SetTargetResolution(w,h)`, `SoftkeyWidth/Height/Count/Direction/HorizontalAlignment/VerticalAlignment`, `AutoOpenEdit`

### Property / enum constants

- `LSButtonProperty`: `Doubleclick=1`, `Theme=2`, `ColorBackground=3`, `ColorFill=4`, `ColorText=5`, `ColorTopLeft=6`, `ColorBottomRight=7`, `Zoom=8` (Zoom added 01.01.196)
- `LSSoftkeyProperty`: `Theme=2`
- `LSServerProperty` (40 IDs): `Stationnumber=1`, `Permanent=2`, `Refreshtime=3`, `Accessnumber=4`, `BitNr=5`, `InversBit=6`, `StringSize=7`, `BitSize=8`, `TimeSize=9`, `DateSize=10`, `Leading0=11`, `Lowerlimit=12`, `Upperlimit=13`, `Unit=14`, `Unitschema=15`, `Menu=16`, `ListText1=17`/`Text1=18` … `ListText3`/`Text3`, `ListBubblehelptext=23`, `Bubblehelptext=24`, `Stateschema=25`, `Userconfig=26`, `Group=27`, `Parameter=28`, `Invers=29`, `CheckBit=30`, `Link1type=31`/`Link1=32` … `Link4type=35`/`Link4=36`, `OnlyAscii=39`, `HostName=40` (added via scripting, 01.01.171)
- `LSAlarmProperty`: `Userconfig=1`, `Priority=2`, `GroupNr=3`, `ListTextShort=4`, `TextShort=5`, `ListTextLong=6`, `TextLong=7`, colors 8–15, `Invers=16`, `CheckBit=17`, `Variable=18`
- `LSLinkType`: `noValue=0`, `Rampsetpoint=1`, `Setpoint=2`, `Actualvalue=3`, `Colorchange=4`, `StateSchmoverload=5`, `Adjustmentpar=6`, `Functionswitch=7`, `ReducedUpLimit=8`, `ReducedUpLimitEn=9`, `XIndex=10`
- `LSRefreshType`: `High=0`, `Medium=1`, `Standard=2`, `Low=3`
- Also: `LSDateSizeType`, `LSTimeSizeType`, `LSBitSizeType`, `LSSoftkeyDirection`, `LSSoftkeyHorzAlign`, `LSSoftkeyVertAlign`

## 3. Verified behaviors (live probes, LSE 01.01.197)

- `Open(.lpr)` returns an `IProject`; the process exits cleanly after `Close($false)` + release — no zombie process, no lingering file locks.
- Collections enumerate with `Item(index, $true)` / `Item(index)` fallbacks; `Count()` works as a parameterless call.
- Text lists resolve **by name** (`TextLists.Item('TitleTexts')`), items by index or GUID; `Text(<LCID>)` reads/writes per language (verified write persists after `Save()` + reopen).
- `Compile()` populates/updates `<project>\Runtime` (41 files for the example project) without dialogs.
- `Save()` works headlessly.
- `Settings.ScreenResolution`/`TargetResolution` return `IScreenSize` (`Width`/`Height`); `SetScreenResolution`/`SetTargetResolution`/`SetCompilerWarnings`/`CompilerVersion =` setters work.
- `OnlineConnection = "name"` validates against the address book ("Online connection name can not be found"); `OnlineIPAddress = "<ip>"` is accepted.
- `MergeParameter` property sets work (`Overwrite`, `DeepMerge`, …).

### Known limitation: XML text export selection

`ExportToXML(path, overwrite)` in 01.01.197 fails with *"No language selected.
Please choose at least one language."* even after `AddCompilationLanguage(lcid)`,
`ActualLanguage = lcid`, `Save()` + reopen (all 8 combinations probed, including
a pristine project). The GUI's *Text > XML Texts > Export* dialog lets the user
deselect languages/text lists — the automation equivalent of that selection is
not exposed in the published type library. `AddContainerInfo`/`UseSortedArray`
exist for the scripting XML export (per change history DEVSW-514) but do not
satisfy the language gate.

Re-verified after the full LASAL suite update (CLASS 2 02.04.001, VISUDesigner
01.04.004, MachineManager 01.00.057, LARS 01.03.216 — LASAL SCREEN unchanged at
1.1.197): a project created fresh through `IApplication.New` shows the same gate,
so it is intrinsic to the 01.01.197 automation interface rather than project
state. `npm run test:lab` carries a watchdog that flags it if a future LSE build
fixes the gate.

Practical alternatives:
- export once from the LSE editor and let agents work on the XML file, importing via `ImportFromXML` (import path is not gated), or
- use the granular APIs (proven): `textlist_get_texts` / `textlist_set_text` / `textlist_import_file` / `textlist_import`, server property updates, `UpdateButtons`/`UpdateSoftkeys`.

Also note the standalone exports (`ExportTextListsToXML()` etc., no path
argument) silently no-op when no selection exists — they return `null` and write
nothing.

## 4. Project files

| Ext | Role |
|---|---|
| `.lpr` | LASAL SCREEN project — **binary** container (mixed records + UTF-16 strings; embeds the online connection string). Never edit by hand. |
| `.lsn` | Screen definition (binary) |
| `.lwn` | Window definition (binary) |
| `.lse` | Data pool / scheme / text-list storage (binary) |
| `.esf` | Project export settings file (merge workflow) |
| `LSEOnlineConfig.xml` | Online/download target for the project (plain XML, `<TCPIP .../>` same schema as `.lss`) |
| `Runtime\` | Compiled output written by Build > Rebuild All / `Compile()`; MachineManager's `DwnLdLSE` accepts this folder or the `.lpr` |
| `.ini`, `.cif` | Compiler/info stamps (`LSE_VISU.ini`, `LSE_VISU.cif` = build string) |

Station wiring: `<SlnProjects><SlnScreenProject Name="…” File="…\visu.lpr"/></SlnProjects>` in the station `.lss`.

Templates shipped with LSE: `Screen\Template\<resolution>\` (e.g. `_NewAge1280x1024`);
supported display resolutions in `Screen\Resolutions.txt`; user-defined
components in `Screen\UDC`; themes in `Screen\Themes`.

## 5. MachineManager `.lutc` (update files)

CLI: `MachineManager.exe /update:"<file.lutc>"` (run from any cwd; relative
artifact paths resolve against the working directory — the MCP writes absolute
paths). Verified schema from `MachineManager\Runtime\Examples\...\Example.lutc`:

```xml
<?xml version="1.0" encoding="ISO-8859-1" ?>
<UpdateConfig TargetId="0" MachineNr="004">
  <Targets>
    <Target Station="Terminal_Station0">
      <PC>
        <TCPIP ConfigName="..." BUS="3" Password="" IP="10.10.116.222" PORT="1954"
               SomeFlags="0" PLCID="" Repeater="0" SSLTLS="0" Favorite="0"/>
      </PC>
    </Target>
  </Targets>
  <Instructions>
    <DwnLdLC2 TargetId="0"><Param Val="...\MachineControl.lcp"/><Param SavePrj="true" Platform="Arm"/></DwnLdLC2>
    <DwnLdLSE TargetId="0"><Param Val="...\LSE_VISU\lse_visu.lpr"/></DwnLdLSE>
    <PrjRun TargetId="0"></PrjRun>
  </Instructions>
</UpdateConfig>
```

`TargetId` = 0-based index into `<Targets>`. Instruction vocabulary (all shipped
in examples): `DwnLdLC2`, `DwnLdLSE`, `DwnLdLVD` (publish folder + optional runtime folder),
`DwnLdOS` (file + reboot timeout ms), `DwnLdFile`, `DwnLdFld`, `UpLdFile`, `UpLdFld`,
`MvFile`, `DelFile`, `MkDir`, `ExistFile`, `PrjRun`, `Boot` (timeout ms),
`WrNr` (channel + value), `CLICmd`, `InstPack` (package name + zip), and a
`<Folder Name="…">` grouping element. Per-run logs go to MachineManager's
configured Update-Tool log folder.

## 6. LARS screen simulation

`%APPDATA%\lasalos2.xml` workspaces accept `SCREEN_PRJ_PATH` (next to
`CLASS_PRJ_PATH`). LARSConfigTool exposes this as "Lasal Screen Project" and can
derive the window resolution "From LSE Project". `Lars.exe` contains the GDI4LSE
renderer (`GDI4LSE_Init`, `LRS_SCREEN_CONFIG`), so LASAL SCREEN projects run on
the PC inside the LARS workspace window — the MCP wires this in `lars_runtime
setup` and captures the window via `lars_runtime screenshot`.

## 7. Translation workflow

- Text lists: `Text(LCID)` per item; `ImportTextFile` / `ImportTextList` import
  classic LSE text exports (".txt" Excel-compatible); XML Texts import creates
  new texts/lists/languages (classic imports only update existing ones — per LSE
  help, `lse_text.htm`).
- `LSE_Translate.exe` is a GUI tool for the "Sigmatek LSE Text Export V2.0"
  files; it has no documented headless mode. Prefer the COM text-list APIs.
- Language list: `Screen\LngDesc.txt` (LCID + names), e.g. 3079 German (Austria), 2057 English (UK).

## 8. Version notes (from the LSE change history)

- 01.01.133: modal LSE dropped — modeless editor is the only variant.
- 01.01.129: registration dialog for scripting/automation components.
- 01.01.133: new automation methods for images (with transparent color), text lists, texts.
- 01.01.154/157/162: XML texts export/import introduced and hardened.
- 01.01.167: `AddContainerInfo` / `UseSortedArray` for scripting XML export.
- 01.01.171: server `HostName` setter via automation.
- 01.01.176: XML export UTF-8 (old UTF-16 files are converted on import).
- 01.01.196: `Zoom` button property for bulk updates.
