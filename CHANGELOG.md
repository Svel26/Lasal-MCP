# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-11

### Added

- Action-catalog preview with `lasal_find_action` and `lasal_execute_action`.
- Five domain entrypoints: `lasal-class2-mcp`, `lasal-visu-mcp`,
  `lasal-screen-mcp`, `lasal-lars-mcp` and `lasal-solution-mcp`.
- 90 catalog actions across CLASS 2, VISUDesigner, LASAL SCREEN, LARS,
  deploy/MachineManager and shared project operations.
- Request-scoped project context, `--project` pinning, a cross-process project
  write lock, file stamps for class-source writes, destructive/deploy
  confirmation and an audit log.
- LARS workspace parity actions: `get`, `create`, `clone`, `validate`, `export`
  and `import`.
- LARS instance actions: `list`, `status`, `restart` and `logs`.
- Lossless LARS config export/import with validation, `.bak` backups and a
  confirmation gate for full replacement.
- LARS compatibility reporting: detected build version, configured vs effective
  ports, unmodeled config elements and per-build notes
  (`docs/LARS_COMPATIBILITY.md`).
- Scenario support for named `saveAs` reads, DataAnalyzer `trace_start` /
  `trace_stop`, LARS window screenshots, JUnit XML output and per-run artifacts.
- `lasal-mcp-init` project scanner / MCP config generator.
- Generated action reference (`docs/ACTIONS.md`), catalog preview guide
  (`docs/CATALOG_PREVIEW.md`) and implementation plan
  (`docs/IMPLEMENTATION_PLAN.md`).

### Changed

- LARS workspace updates now share validation for ports, data roots, drive
  maps, memory sizes and screen paths.
- `lars.doctor` reports both configured and effective online ports, detects
  unknown config fields and includes build compatibility information.
- LARS config writes continue to preserve unknown XML elements and attributes.
- Code formatting was normalized across the repository.

### Fixed

- LARS station targeting never trusts a recorded online port from a stopped
  instance.
- LARS shutdown is graceful where possible, preserving retained variables in the
  SRAM image.
- LARS instance records merge instead of replacing each other.
- HMI runtime starts from another project are refused instead of killing the
  existing runtime.

### Known limitations

- The lab suite requires a Windows workstation with the LASAL suite installed
  and was not run as part of this release.
- Multi-instance HMI DataService support is not implemented.
- Preflight ST linter, solution knowledge graph and fast telemetry are not
  implemented yet.
- The original `lasal-mcp` entrypoint still exposes the 23 static tools; the
  action catalog is an opt-in preview.

## Earlier releases

- [v0.3.2](https://github.com/Svel26/Lasal-MCP/releases/tag/v0.3.2)
- [v0.3.1](https://github.com/Svel26/Lasal-MCP/releases/tag/v0.3.1)
- [v0.3.0](https://github.com/Svel26/Lasal-MCP/releases/tag/v0.3.0)
- [v0.2.0](https://github.com/Svel26/Lasal-MCP/releases/tag/v0.2.0)
- [v0.1.0](https://github.com/Svel26/Lasal-MCP/releases/tag/v0.1.0)

[0.4.0]: https://github.com/Svel26/Lasal-MCP/compare/v0.3.2...v0.4.0
