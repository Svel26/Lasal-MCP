# Contributing to Lasal-MCP

Thank you for your interest in contributing to **Lasal-MCP**! We welcome contributions from developers, automation engineers, and users alike.

Please read this guide to learn about our development process, design philosophy, and how to get started.

---

## Code of Conduct

This project and everyone participating in it is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## Architecture & Design Philosophy

Lasal-MCP follows a deliberate design principle:
> **The MCP server only exposes tools for operations that require an external engine or hardware** (compiling, deploying, PLC control, LARS simulations, and CLASS 2/VISU batch scripts).
>
> For everything else (reading/editing `.st`, `.lcp`, `.lcn`, `.lss`, `.lvp`, dashboard JSON files), AI agents should work directly with files using native file tools. This keeps the tool surface small, dependable, and efficient.

### Directory Structure

```text
src/
+-- core/             # Shared primitives
|   +-- actions/      # Action catalog: types, registry, search, executor, profiles, audit
|   +-- project/      # Project context, capability detection, cross-process write locks
|   +-- ...           # Process management, HTTP server, error envelopes, scratch dir
+-- domains/          # Catalog action definitions (class2, visu, screen, lars, deploy, core)
+-- servers/          # Thin catalog profile entrypoints
+-- cli/init.ts       # Project scanner / MCP config generator
+-- scripts/          # docs/ACTIONS.md generator
+-- resources/        # MCP resources (lasal://guide, status, stations, class template)
+-- tools/            # Static MCP tool handlers and Zod input schemas
|   +-- applyProjectChanges.ts  # CLASS 2 batch engine commands & class manifests
|   +-- deployAll.ts            # Complete compile -> download -> visu -> HMI pipeline
|   +-- hmiRuntime.ts           # LasalVISUDataService web runtime manager
|   +-- inspectProject.ts       # Read-only CLASS 2 project scanning
|   +-- larsRuntime.ts          # Local LARS simulation multi-station manager
|   +-- larsDoctor.ts           # LARS config/runtime diagnostics and compatibility report
|   +-- larsScenario.ts         # One-connection scenario runner (trace/screenshot/JUnit)
|   +-- lasalApps.ts            # CLASS 2 & VISUDesigner IDE window control
|   +-- plcControl.ts           # Compile, download, start/stop PLC runtime, live channels
|   +-- plcDiagnostics.ts       # Tracing, file transfer, static analysis
|   +-- readClassSource.ts      # Structured Text (.st) reading & latin1-validated writing
|   +-- runClass2Script.ts      # Python 2.7 batch script escape hatch
|   +-- selectProject.ts        # Set active project directory
|   +-- setTargetIp.ts          # Surgical .lss connection IP updating
|   +-- status.ts               # Overall health & process inspection
|   +-- validateGuids.ts        # GUID collision auto-resolution and CRC-32 hashing
|   +-- visuControl.ts          # VISUDesigner batch engine operations
+-- utils/            # Helper modules (batch script generators, XML parsing, LARS setup, completions, progress)
+-- server.ts         # Static MCP server entrypoint, tool and resource registrations
+-- serverCatalog.ts  # Backward-compatible action-catalog preview entrypoint
+-- state.ts          # Global state (active project, target IPs, cached data)

test/                 # Vitest test suites (script generators, XML parsers, LARS config, encoding, actions)
```

---

## Getting Started

### Prerequisites

- **Windows OS**: Sigmatek LASAL CLASS 2, VISUDesigner, and LARS run exclusively on Windows.
- **Node.js**: v20.0.0 or higher (v22 LTS recommended; CI runs the test matrix on 20.x and 22.x).
- **Sigmatek LASAL Software Suite** (optional for unit tests, required for end-to-end testing):
  - LASAL CLASS 2
  - VISUDesigner
  - LARS (LASAL Runtime System for local simulation)

### Local Setup

1. Fork the repository on GitHub.
2. Clone your fork:
   ```bash
   git clone https://github.com/<your-username>/Lasal-MCP.git
   cd Lasal-MCP
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```
5. Run the test suite:
   ```bash
   npm test
   ```

---

## Development Workflow

### Branching Strategy
We use a standard two-tier branching strategy:

- **`main`**: Production and release branch. Contains stable, published code. Releases (`v*.*.*`) are tagged from here. Direct pushes and deletions are blocked by branch protection rules.
- **`dev`**: Active development and integration branch. All feature work lands here first.
- **Feature/Fix branches (`feat/*`, `fix/*`, `refactor/*`)**: Branch off `dev`. When your changes are ready and tests pass, submit a Pull Request targeting `dev`.
- **PR gates**: every PR must pass CI (ESLint, Prettier check, TypeScript build, and the Vitest suite on Node 20.x + 22.x), and the branch must be up to date with its base (strict required status checks). Release PRs (`dev` → `main`) run the same checks.
- **Releases**: Merged from `dev` into `main` via PR when ready for release.

### Watch Mode
To automatically recompile TypeScript files when changes are saved:
```bash
npm run dev
```

### Running Tests
We use [Vitest](https://vitest.dev/) for unit testing:
```bash
npm test            # Single run
npm run test:watch  # Interactive watch mode
```

### Linting & Code Formatting
We use ESLint and Prettier. Please ensure your code conforms to the formatting rules before submitting:
```bash
npm run lint          # Check for lint warnings/errors
npm run format:check  # Check formatting
npm run format        # Automatically format files
```

### Debugging with the MCP Inspector
You can test the MCP server interactively in a web-based inspector:
```bash
npm run inspector
```
This opens the Model Context Protocol Inspector where you can test tool schemas, run tools manually, and inspect responses.

---

## Adding Static Tools or Catalog Actions

### Static tools

The original 23-tool server remains the default. When adding or updating a
static tool:

1. **Keep it focused**: Ensure the operation cannot be done by simply editing a text/XML file directly.
2. **Define Schema with Zod**: Place tool schemas in `src/tools/<toolName>.ts` using `zod`.
3. **Encodings matter**:
   - CLASS 2 source files (`.st`, `.lcn`, `.lcp`, `.lss`, `.lsm`) must use **`latin1`** encoding.
   - VISU dashboards and JSON files must use **`utf-8`**.
4. **Engine state**: Many Sigmatek engines (CLASS 2, VISUDesigner) cannot perform batch operations while their GUI is actively locking the project. Use the process helpers to check or close instances when running batch scripts.
5. **Add tests**: Add unit tests in `test/` verifying script generation, parameter serialization, and error conditions.
6. **Register the tool**: Register the tool and its description in `src/server.ts`.

### Catalog actions

The opt-in action catalog lives in `src/domains/<domain>/actions.ts` and is
described in [`docs/CATALOG_PREVIEW.md`](docs/CATALOG_PREVIEW.md) and
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md). To add an action:

1. **Pick the domain**: `class2`, `visu`, `screen`, `lars`, `deploy` or `core`.
2. **Define it** with `defineAction` from `src/core/actions/types.ts`: canonical
   ID, aliases, summary, Zod schema, handler, risk tier, project requirement,
   tags and at least one valid example.
3. **Respect the safety model**: destructive/deploy actions require
   `confirm=true`; expert actions require `--allow-expert`; mutating actions run
   under the project write lock.
4. **Reuse existing handlers** where possible with `fromToolResponse(...)`; new
   handlers should return an `ActionResult` directly.
5. **Add tests** in `test/` and include the file in `npm run test:actions` when
   it covers catalog behavior.
6. **Regenerate docs** with `npm run build && npm run docs:actions`; do not edit
   `docs/ACTIONS.md` by hand. Verify with `npm run docs:actions:check`.

---

## Commit Guidelines

We encourage [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add support for XYZ engine command`
- `fix: handle missing LARS workspace gracefully`
- `docs: update npx setup in README`
- `test: add unit tests for visuPropertyEncoding`
- `refactor: simplify process launcher`

---

## Pull Request Process

1. Create a descriptive branch from `dev`:
   ```bash
   git checkout -b feature/my-new-feature
   ```
2. Make your changes, adhering to code style and typing standards.
3. Ensure all checks pass locally:
   ```bash
   npm run lint
   npm run format:check
   npm run build
   npm test
   ```
4. Push your branch to GitHub:
   ```bash
   git push origin feature/my-new-feature
   ```
5. Open a Pull Request on GitHub against `dev`. Fill in the PR template with details about your changes and testing performed.
6. Address any feedback during code review. Once approved, maintainers will merge your PR.

---

## Need Help?

If you have questions or run into issues:
- Open an issue using the [Bug Report](https://github.com/Svel26/Lasal-MCP/issues/new?template=bug_report.yml) or [Feature Request](https://github.com/Svel26/Lasal-MCP/issues/new?template=feature_request.yml) template.
- Check the [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/](docs/) for in-depth system designs.
