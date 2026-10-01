import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { buildRawScript, emitPy27String, runScript, validateMbcsEncodable } from "../utils/batchScript.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { killClass2, SCRATCH } from "../utils/engine.js";
import { TIMEOUTS } from "../utils/config.js";
import { fail } from "../utils/respond.js";
import { batchResultToResponse } from "../core/response.js";
import { ensureScratch } from "../core/scratch.js";

export const runClass2ScriptSchema = {
  script_body: z
    .string()
    .min(1)
    .describe(
      "Python 2.7 statements executed inside the CLASS 2 batch context. `batch` (sigmatek.lasal.batch) and " +
        "the loaded project `prj` are in scope; the project is closed afterwards (call batch.Save(prj) yourself " +
        "if the change must persist). Example: batch.Compile(prj, batch.CompileOptions.BuildChanges)",
    ),
  args: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Optional arguments exposed to the script as sys.argv[1:]. Default []."),
  lcp_path: z
    .string()
    .optional()
    .describe("Absolute path to the .lcp file. Omit to use the currently selected project."),
};

/**
 * Assemble the raw batch body: optional sys.argv injection followed by the
 * caller's statements. Pure so the escape-hatch contract is unit-testable.
 */
export function buildClass2ScriptBody(scriptBody: string, args: string[] = []): string[] {
  const lines: string[] = [];
  if (args.length > 0) {
    lines.push(`sys.argv = [u"class2_script"] + [${args.map(emitPy27String).join(", ")}]`);
  }
  lines.push(...scriptBody.replace(/\r\n/g, "\n").split("\n"));
  return lines;
}

export async function runClass2ScriptHandler(args: { script_body: string; args?: string[]; lcp_path?: string }) {
  const resolved = resolveLcpPath(args.lcp_path);
  if ("error" in resolved) {
    return fail(resolved.error, ["Select a project first using select_project or specify lcp_path."]);
  }

  const argv = args.args ?? [];
  try {
    validateMbcsEncodable(args.script_body);
    for (const a of argv) validateMbcsEncodable(a);
  } catch (e: any) {
    return fail(`Script is not mbcs/latin1 encodable: ${e.message}`, [
      "Escape-hatch scripts must be latin1-compatible (no characters above U+00FF).",
    ]);
  }

  ensureScratch();
  const id = randomUUID();
  const logPath = join(SCRATCH, `${id}.log`);
  const stepsPath = join(SCRATCH, `${id}.steps`);
  const expectedSteps = ["script_body"];
  const script = buildRawScript(
    resolved.path,
    buildClass2ScriptBody(args.script_body, argv),
    logPath,
    stepsPath,
    expectedSteps,
  );

  killClass2();
  const result = await runScript(script, logPath, TIMEOUTS.script, expectedSteps, stepsPath);
  return batchResultToResponse(result);
}
