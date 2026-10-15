import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runScript, emitPath } from "../../src/utils/batchScript.js";
import { applyProjectChangesHandler } from "../../src/tools/applyProjectChanges.js";
import { plcDiagnosticsHandler } from "../../src/tools/plcDiagnostics.js";

// Requires a local LASAL installation. Run via: npm run test:lab
const ENABLED = process.env.LASAL_LAB === "1";
const d = ENABLED ? describe : describe.skip;

function parse(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

d("LAB: CLASS 2 lifecycle on a fresh project", () => {
  it("creates a project, adds a class, compiles and checks code-analysis wiring", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lasal-lab-c2-"));
    const lcp = join(dir, "LabProject.lcp");
    const createLog = join(dir, "create.log");

    // 1. Fresh project (never a shipped example — those need version upgrades)
    const createScript =
      [
        "# -*- coding: utf-8 -*-",
        "import sigmatek.lasal.batch as batch",
        "batch.SetExceptionOnError(True)",
        `batch.OpenLogfile(${emitPath(createLog)})`,
        `prj = batch.CreateProject(${emitPath(lcp)})`,
        "if prj is None: raise RuntimeError('CreateProject returned None')",
        "batch.Save(prj)",
        "batch.CloseProject(prj)",
      ].join("\n") + "\n";
    const created = await runScript(createScript, createLog, 180_000);
    expect(created.ok, JSON.stringify(created.errors)).toBe(true);
    expect(existsSync(lcp)).toBe(true);

    // 2. File-level class creation through the MCP tooling (lcp manifest compat check)
    const classRes = await applyProjectChangesHandler({
      lcp_path: lcp,
      operations: [
        {
          type: "create_class",
          name: "LabMotor",
          servers: [{ name: "s_Speed" }],
          cyclicTask: true,
        },
      ],
    });
    const classBody = parse(classRes as unknown as { content: Array<{ text: string }> });
    expect(classBody.ok, JSON.stringify(classBody)).toBe(true);

    // 3. Compile the class-containing project through the batch engine.
    // Note: the FIRST compile on a brand-new project also bootstraps the project's
    // global base (Include/global.ldi/.lob) and can fail on base symbols once.
    // (Network creation on bare batch-created projects is flaky in CLASS 2 02.04 —
    // that path is exercised against established projects, not fresh ones.)
    const runCompile = () =>
      applyProjectChangesHandler({
        lcp_path: lcp,
        operations: [{ type: "compile" }],
      });
    let buildRes = await runCompile();
    let buildBody = parse(buildRes as unknown as { content: Array<{ text: string }> });
    if (buildBody.ok !== true) {
      const errs = JSON.stringify(buildBody);
      if (/Undefined (type|symbol)/i.test(errs)) {
        console.log("[lab] first compile hit the fresh-project base bootstrap — retrying once");
        buildRes = await runCompile();
        buildBody = parse(buildRes as unknown as { content: Array<{ text: string }> });
      }
    }
    expect(buildBody.ok, JSON.stringify(buildBody)).toBe(true);

    const lcbFiles: string[] = [];
    const walk = (p: string, depth: number): void => {
      if (depth < 0) return;
      try {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(p, e.name), depth - 1);
          else if (e.name.toLowerCase().endsWith(".lcb")) lcbFiles.push(join(p, e.name));
        }
      } catch {
        /* ignore */
      }
    };
    walk(dir, 2);
    expect(lcbFiles.length, "expected at least one compiled .lcb artifact").toBeGreaterThan(0);

    // 4. Code analysis (CLASS 2 >= 02.04 spelling). On machines without the
    // code-analysis license the engine refuses — then we only verify the call
    // reached the engine's DoCodeAnalysis command (wiring check).
    const analysisOut = join(dir, "analysis.xml");
    const diag = await plcDiagnosticsHandler({
      action: "code_analysis",
      lcp_path: lcp,
      output_path: analysisOut,
    });
    const diagBody = parse(diag as unknown as { content: Array<{ text: string }> });
    const diagText = JSON.stringify(diagBody);
    if (/needs a license/i.test(diagText)) {
      console.log("[lab] code analysis is license-gated on this machine — verifying wiring only");
      expect(diagText).toMatch(/DoCodeAnalysis/);
    } else {
      expect(diagBody.ok, diagText).toBe(true);
      expect(existsSync(analysisOut)).toBe(true);
    }
  });
});
