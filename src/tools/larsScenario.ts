import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { buildRawScript, emitPath, emitPy27String, runScript } from "../utils/batchScript.js";
import { withEngineLock, SCRATCH } from "../utils/engine.js";
import { TIMEOUTS } from "../utils/config.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { preflightPlc, resolveConnection } from "../utils/preflight.js";
import { ensureScratch } from "../core/scratch.js";
import type { ActionResult } from "../core/actions/types.js";

const valueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const larsScenarioStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set"),
    channel: z.string().describe("Channel in 'ObjectName.ChannelName' format."),
    value: valueSchema.describe("Value to write."),
  }),
  z.object({
    type: z.literal("read"),
    channels: z.array(z.string()).min(1).describe("Channels to read."),
  }),
  z.object({
    type: z.literal("wait"),
    channel: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    timeout_ms: z.number().int().positive().default(5000),
    poll_ms: z.number().int().positive().default(100),
  }),
  z.object({
    type: z.literal("assert"),
    channel: z.string(),
    equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    message: z.string().optional().describe("Failure message."),
  }),
  z.object({
    type: z.literal("sleep"),
    ms: z.number().int().min(0),
  }),
]);

export const larsScenarioSchema = {
  lcp_path: z.string().optional().describe("Absolute path to the .lcp. Omit to use the selected project."),
  connection: z
    .string()
    .optional()
    .describe("PLC connection string, e.g. 'TCPIP:127.0.0.1:1954'. Omit to use the project's .lss target."),
  steps: z.array(larsScenarioStepSchema).min(1).describe("Ordered scenario steps."),
  timeout_s: z.number().int().positive().optional().describe("Overall scenario timeout in seconds."),
};

export type LarsScenarioStep = z.infer<typeof larsScenarioStepSchema>;

/**
 * Build the Python 2.7 body for a scenario. One connection is opened for all
 * steps; each step records a structured result and the first failure aborts.
 */
export function buildScenarioBody(connection: string, resultPath: string, steps: LarsScenarioStep[]): string[] {
  const stepsJson = JSON.stringify(steps);
  return [
    "batch.SetExceptionOnError(False)",
    "import time",
    `conn = ${emitPy27String(connection)}`,
    `steps = json.loads(${emitPy27String(stepsJson)})`,
    `result_path = ${emitPath(resultPath)}`,
    "results = []",
    "failed = [False]",
    "",
    "def read_channel(ch):",
    "    variants = [ch]",
    "    if '.' in ch and '\\\\' not in ch:",
    "        obj_part, chan_part = ch.split('.', 1)",
    "        variants.append(obj_part + '\\\\_base.' + chan_part)",
    "        variants.append(obj_part + '\\\\_base\\\\_base.' + chan_part)",
    "    for variant in variants:",
    "        dic = {}",
    "        ok = batch.ReadPlcValue(variant, dic)",
    "        if ok:",
    "            value = None",
    "            for _k, _v in dic.items():",
    "                value = _v",
    "                break",
    "            return True, str(value), variant",
    "    return False, None, ch",
    "",
    "def to_num(text):",
    "    try:",
    "        return float(text)",
    "    except:",
    "        return None",
    "",
    "def coerce(value):",
    "    if isinstance(value, bool):",
    "        return value",
    "    text = str(value)",
    "    if text.lower() == 'true':",
    "        return True",
    "    if text.lower() == 'false':",
    "        return False",
    "    num = to_num(text)",
    "    if num is not None:",
    "        if num == int(num):",
    "            return int(num)",
    "        return num",
    "    return text",
    "",
    "def condition_met(step, value):",
    "    if value is None:",
    "        return False",
    "    expected = step.get('equals')",
    "    if expected is not None:",
    "        if isinstance(expected, bool):",
    "            text = str(value).lower()",
    "            return text in ('true', '1') if expected else text in ('false', '0')",
    "        if isinstance(expected, (int, float)):",
    "            num = to_num(value)",
    "            return num is not None and num == float(expected)",
    "        return str(value) == str(expected)",
    "    num = to_num(value)",
    "    if num is None:",
    "        return False",
    "    if step.get('min') is not None and num < float(step.get('min')):",
    "        return False",
    "    if step.get('max') is not None and num > float(step.get('max')):",
    "        return False",
    "    return True",
    "",
    "def record(index, step, ok, value, error):",
    "    results.append({'index': index, 'type': step.get('type'), 'ok': bool(ok), 'value': value, 'error': error})",
    "",
    "def write_result():",
    "    f = open(result_path, 'w')",
    "    json.dump({'ok': not failed[0], 'steps': results}, f)",
    "    f.close()",
    "",
    "if not batch.OpenPlcConnection(prj, conn):",
    "    record(-1, {'type': 'connect'}, False, None, 'Failed to open PLC connection')",
    "    failed[0] = True",
    "else:",
    "    try:",
    "        for idx, step in enumerate(steps):",
    "            typ = step.get('type')",
    "            if typ == 'sleep':",
    "                time.sleep(float(step.get('ms', 0)) / 1000.0)",
    "                record(idx, step, True, None, None)",
    "            elif typ == 'set':",
    "                ok = bool(batch.WritePlcValue(step.get('channel'), coerce(step.get('value'))))",
    "                record(idx, step, ok, step.get('value'), None if ok else 'WritePlcValue failed')",
    "                if not ok: failed[0] = True",
    "            elif typ == 'read':",
    "                values = {}",
    "                ok_all = True",
    "                for ch in step.get('channels', []):",
    "                    ok, value, used = read_channel(ch)",
    "                    values[ch] = {'ok': bool(ok), 'value': value, 'path': used}",
    "                    if not ok: ok_all = False",
    "                record(idx, step, ok_all, values, None if ok_all else 'One or more reads failed')",
    "                if not ok_all: failed[0] = True",
    "            elif typ == 'wait':",
    "                deadline = time.time() + float(step.get('timeout_ms', 5000)) / 1000.0",
    "                poll = float(step.get('poll_ms', 100)) / 1000.0",
    "                ok = False",
    "                value = None",
    "                while time.time() <= deadline:",
    "                    ok, value, _used = read_channel(step.get('channel'))",
    "                    if ok and condition_met(step, value):",
    "                        break",
    "                    ok = False",
    "                    time.sleep(poll)",
    "                record(idx, step, ok, value, None if ok else 'Condition not met before timeout')",
    "                if not ok: failed[0] = True",
    "            elif typ == 'assert':",
    "                ok, value, _used = read_channel(step.get('channel'))",
    "                passed = bool(ok and condition_met(step, value))",
    "                record(idx, step, passed, value, None if passed else step.get('message') or 'Assertion failed')",
    "                if not passed: failed[0] = True",
    "            else:",
    "                record(idx, step, False, None, 'Unknown step type')",
    "                failed[0] = True",
    "            if failed[0]:",
    "                break",
    "    finally:",
    "        batch.ClosePlcConnection()",
    "",
    "write_result()",
    "if failed[0]:",
    "    raise RuntimeError('Scenario failed')",
  ];
}

export async function runLarsScenario(args: {
  lcp_path?: string;
  connection?: string;
  steps: LarsScenarioStep[];
  timeout_s?: number;
}): Promise<ActionResult> {
  return withEngineLock(async () => {
    const resolved = resolveLcpPath(args.lcp_path);
    if ("error" in resolved) {
      return {
        ok: false,
        error: { code: "PRECONDITION_FAILED", message: resolved.error },
        hints: ["Select a project first or pass lcp_path."],
      };
    }

    const connectionInfo = resolveConnection(resolved.path, args.connection);
    const preflight = await preflightPlc(resolved.path, args.connection);
    if (!preflight.ok) {
      return {
        ok: false,
        error: {
          code: "PRECONDITION_FAILED",
          message: preflight.problems.map((problem) => problem.message).join("\n") || "PLC preflight failed.",
        },
        hints: preflight.problems.map((problem) => problem.fix),
      };
    }

    ensureScratch();
    const id = randomUUID();
    const logPath = join(SCRATCH, `${id}.scenario.log`);
    const stepsPath = join(SCRATCH, `${id}.scenario.steps`);
    const resultPath = join(SCRATCH, `${id}.scenario.json`);
    const body = buildScenarioBody(connectionInfo.connection, resultPath, args.steps);
    const script = buildRawScript(resolved.path, body, logPath, stepsPath, ["scenario"]);

    let result = await runScript(
      script,
      logPath,
      args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.script,
      ["scenario"],
      stepsPath,
    );
    if (!result.ok && result.errors.some((error) => /connect|timeout|socket/i.test(error))) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 1000));
      result = await runScript(
        script,
        logPath,
        args.timeout_s ? args.timeout_s * 1000 : TIMEOUTS.script,
        ["scenario"],
        stepsPath,
      );
    }

    let parsed: { ok?: boolean; steps?: unknown[] } | undefined;
    if (existsSync(resultPath)) {
      try {
        parsed = JSON.parse(readFileSync(resultPath, "utf-8")) as { ok?: boolean; steps?: unknown[] };
      } catch {
        // The result file is best-effort; the log still explains the failure.
      }
    }

    const scenariosOk = result.ok && parsed?.ok !== false;
    return {
      ok: scenariosOk,
      data: {
        ok: scenariosOk,
        steps: parsed?.steps ?? [],
        durationMs: result.durationMs,
        logPath,
        ...(result.errors.length ? { errors: result.errors } : {}),
        ...(result.warnings.length ? { warnings: result.warnings } : {}),
      },
      ...(scenariosOk
        ? {}
        : {
            error: {
              code: "ACTION_FAILED",
              message: result.errors[0] ?? "Scenario failed.",
            },
          }),
    };
  });
}
