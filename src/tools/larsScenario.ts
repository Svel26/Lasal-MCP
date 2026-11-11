import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { z } from "zod";
import { buildRawScript, emitPath, emitPy27String, runScript } from "../utils/batchScript.js";
import { withEngineLock, SCRATCH } from "../utils/engine.js";
import { TIMEOUTS } from "../utils/config.js";
import { resolveLcpPath } from "../utils/resolvePaths.js";
import { preflightPlc, resolveConnection } from "../utils/preflight.js";
import { ensureScratch } from "../core/scratch.js";
import { writeLarsScreenshotScript } from "../utils/lars.js";
import type { ActionArtifact, ActionResult } from "../core/actions/types.js";

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
    saveAs: z.string().optional().describe("Store this read's values under a name in the scenario result."),
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
  z.object({
    type: z.literal("trace_start"),
    config_path: z.string().optional().describe("DataAnalyzer config file. Falls back to trace_config_path."),
  }),
  z.object({
    type: z.literal("trace_stop"),
    output_path: z.string().optional().describe("Trace CSV output. Defaults to the scenario artifacts folder."),
    name: z.string().optional().describe("Artifact label."),
  }),
  z.object({
    type: z.literal("screenshot"),
    workspace: z.string().optional().describe("LARS workspace name. Falls back to the top-level workspace."),
    name: z.string().optional().describe("Artifact label."),
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
  workspace: z
    .string()
    .optional()
    .describe("LARS workspace used by screenshot steps. Required when a screenshot step omits workspace."),
  trace_config_path: z
    .string()
    .optional()
    .describe("Default DataAnalyzer config for trace_start steps that omit config_path."),
  junit: z.boolean().optional().default(false).describe("Write a JUnit XML result next to the scenario artifacts."),
};

export type LarsScenarioStep = z.infer<typeof larsScenarioStepSchema>;

export interface ScenarioStepResult {
  index: number;
  type: string;
  ok: boolean;
  value?: unknown;
  error?: string | null;
}

export interface ScenarioArtifact {
  type: string;
  path: string;
  name?: string;
}

export interface ScenarioBuildOptions {
  artifactsDir?: string;
  screenshotScriptPath?: string;
  workspace?: string;
  traceConfigPath?: string;
}

/**
 * Build the Python 2.7 body for a scenario. One connection is opened for all
 * steps; each step records a structured result and the first failure aborts.
 */
export function buildScenarioBody(
  connection: string,
  resultPath: string,
  steps: LarsScenarioStep[],
  options: ScenarioBuildOptions = {},
): string[] {
  const stepsJson = JSON.stringify(steps);
  return [
    "batch.SetExceptionOnError(False)",
    "import time",
    "import os",
    "import subprocess",
    "import json",
    `conn = ${emitPy27String(connection)}`,
    `steps = json.loads(${emitPy27String(stepsJson)})`,
    `result_path = ${emitPath(resultPath)}`,
    `artifacts_dir = ${emitPath(options.artifactsDir ?? "")}`,
    `workspace_name = ${emitPy27String(options.workspace ?? "")}`,
    `trace_config_path = ${emitPy27String(options.traceConfigPath ?? "")}`,
    `screenshot_script = ${emitPath(options.screenshotScriptPath ?? "")}`,
    "results = []",
    "saved = {}",
    "artifacts = []",
    "trace_outputs = []",
    "trace_active = [False]",
    "failed = [False]",
    "",
    "def to_mbcs(value):",
    "    if isinstance(value, unicode):",
    "        return value.encode('mbcs')",
    "    return value",
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
    "def save_read(name, values):",
    "    if name:",
    "        saved[name] = values",
    "",
    "def capture_screenshot(index, step):",
    "    target_workspace = step.get('workspace') or workspace_name",
    "    if not target_workspace:",
    "        return False, None, 'No workspace configured for screenshot step'",
    "    if not screenshot_script or not os.path.exists(screenshot_script):",
    "        return False, None, 'Screenshot helper script is missing'",
    "    label = step.get('name') or ('step_%d' % index)",
    "    safe = ''.join([c if (c.isalnum() or c in '._-') else '_' for c in label])",
    "    out = os.path.join(artifacts_dir, 'screenshot_%d_%s.png' % (index, safe))",
    "    cmd = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', screenshot_script, target_workspace, out]",
    "    rc = subprocess.call(cmd)",
    "    if rc == 0:",
    "        artifacts.append({'type': 'screenshot', 'path': out, 'name': label})",
    "        return True, out, None",
    "    return False, out, 'Screenshot helper exited with code %d' % rc",
    "",
    "def start_trace(index, step):",
    "    if trace_active[0]:",
    "        return False, None, 'Trace is already running'",
    "    cfg = step.get('config_path') or trace_config_path",
    "    if not cfg:",
    "        return False, None, 'No DataAnalyzer config_path for trace_start'",
    "    batch.DataAnalyzerLoadConfig(to_mbcs(cfg))",
    "    batch.DataAnalyzerRun(prj, conn)",
    "    trace_active[0] = True",
    "    return True, None, None",
    "",
    "def stop_trace(index, step):",
    "    if not trace_active[0]:",
    "        return False, None, 'Trace is not running'",
    "    out = step.get('output_path') or os.path.join(artifacts_dir, 'trace_%d.csv' % index)",
    "    out = to_mbcs(out)",
    "    batch.DataAnalyzerStop()",
    "    batch.DataAnalyzerSaveData(out)",
    "    trace_active[0] = False",
    "    trace_outputs.append(out)",
    "    artifacts.append({'type': 'trace', 'path': out, 'name': step.get('name') or ('trace_%d' % index)})",
    "    return True, out, None",
    "",
    "def write_result():",
    "    f = open(result_path, 'w')",
    "    json.dump({'ok': not failed[0], 'steps': results, 'saved': saved, 'artifacts': artifacts, 'traceOutputs': trace_outputs}, f)",
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
    "                save_read(step.get('saveAs'), values)",
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
    "            elif typ == 'trace_start':",
    "                ok, value, error = start_trace(idx, step)",
    "                record(idx, step, ok, value, error)",
    "                if not ok: failed[0] = True",
    "            elif typ == 'trace_stop':",
    "                ok, value, error = stop_trace(idx, step)",
    "                record(idx, step, ok, value, error)",
    "                if not ok: failed[0] = True",
    "            elif typ == 'screenshot':",
    "                ok, value, error = capture_screenshot(idx, step)",
    "                record(idx, step, ok, value, error)",
    "                if not ok: failed[0] = True",
    "            else:",
    "                record(idx, step, False, None, 'Unknown step type')",
    "                failed[0] = True",
    "            if failed[0]:",
    "                break",
    "    finally:",
    "        if trace_active[0]:",
    "            try:",
    "                batch.DataAnalyzerStop()",
    "                aborted = os.path.join(artifacts_dir, 'trace_aborted.csv')",
    "                batch.DataAnalyzerSaveData(aborted)",
    "                trace_outputs.append(aborted)",
    "            except:",
    "                pass",
    "        batch.ClosePlcConnection()",
    "",
    "write_result()",
    "if failed[0]:",
    "    raise RuntimeError('Scenario failed')",
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Render scenario step results as JUnit XML. */
export function renderJUnit(steps: ScenarioStepResult[], ok: boolean, suiteName = "lars-scenario"): string {
  const results = [...steps];
  if (!ok && !results.some((step) => !step.ok)) {
    results.push({ index: -1, type: "scenario", ok: false, error: "Scenario failed before any step could report." });
  }
  const failures = results.filter((step) => !step.ok).length;
  const cases = results.map((step) => {
    const name = `${step.index}_${step.type}`;
    if (step.ok) return `    <testcase classname="${escapeXml(suiteName)}" name="${escapeXml(name)}" time="0"/>`;
    const message = escapeXml(step.error ?? "Step failed.");
    return [
      `    <testcase classname="${escapeXml(suiteName)}" name="${escapeXml(name)}" time="0">`,
      `      <failure message="${message}">${message}</failure>`,
      "    </testcase>",
    ].join("\n");
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXml(suiteName)}" tests="${results.length}" failures="${failures}" errors="0" time="0">`,
    ...cases,
    "</testsuite>",
    "",
  ].join("\n");
}

interface ParsedScenarioResult {
  ok?: boolean;
  steps?: ScenarioStepResult[];
  saved?: Record<string, unknown>;
  artifacts?: ScenarioArtifact[];
  traceOutputs?: string[];
}

export async function runLarsScenario(args: {
  lcp_path?: string;
  connection?: string;
  steps: LarsScenarioStep[];
  timeout_s?: number;
  workspace?: string;
  trace_config_path?: string;
  junit?: boolean;
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

    const screenshotSteps = args.steps.filter(
      (step): step is Extract<LarsScenarioStep, { type: "screenshot" }> => step.type === "screenshot",
    );
    if (screenshotSteps.some((step) => !step.workspace && !args.workspace)) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message: "A screenshot step needs a LARS workspace.",
        },
        hints: ["Pass top-level workspace, or set workspace on each screenshot step."],
      };
    }
    const traceStart = args.steps.find(
      (step): step is Extract<LarsScenarioStep, { type: "trace_start" }> => step.type === "trace_start",
    );
    if (traceStart && !traceStart.config_path && !args.trace_config_path) {
      return {
        ok: false,
        error: {
          code: "INVALID_PARAMS",
          message: "trace_start needs a DataAnalyzer config file.",
        },
        hints: ["Set config_path on the step or pass top-level trace_config_path."],
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
    const runId = randomUUID();
    const artifactsDir = join(SCRATCH, "scenarios", runId);
    mkdirSync(artifactsDir, { recursive: true });
    const logPath = join(artifactsDir, "scenario.log");
    const stepsPath = join(artifactsDir, "scenario.steps");
    const resultPath = join(artifactsDir, "scenario.json");
    const screenshotScriptPath = screenshotSteps.length ? join(artifactsDir, "capture.ps1") : undefined;
    if (screenshotScriptPath) writeLarsScreenshotScript(screenshotScriptPath);

    const body = buildScenarioBody(connectionInfo.connection, resultPath, args.steps, {
      artifactsDir,
      ...(screenshotScriptPath ? { screenshotScriptPath } : {}),
      ...(args.workspace ? { workspace: args.workspace } : {}),
      ...(args.trace_config_path ? { traceConfigPath: args.trace_config_path } : {}),
    });
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

    let parsed: ParsedScenarioResult | undefined;
    if (existsSync(resultPath)) {
      try {
        parsed = JSON.parse(readFileSync(resultPath, "utf-8")) as ParsedScenarioResult;
      } catch {
        // The result file is best-effort; the log still explains the failure.
      }
    }

    const scenariosOk = result.ok && parsed?.ok !== false;
    let junitPath: string | undefined;
    if (args.junit) {
      junitPath = join(artifactsDir, "junit.xml");
      writeFileSync(junitPath, renderJUnit(parsed?.steps ?? [], scenariosOk), "utf-8");
    }

    const artifacts: ActionArtifact[] = (parsed?.artifacts ?? []).map((artifact) => ({
      name: artifact.name ?? artifact.path.split(/[\\/]/).pop() ?? "artifact",
      path: artifact.path,
      kind: artifact.type,
    }));
    if (junitPath) artifacts.push({ name: "junit.xml", path: junitPath, kind: "junit" });

    return {
      ok: scenariosOk,
      data: {
        ok: scenariosOk,
        steps: parsed?.steps ?? [],
        saved: parsed?.saved ?? {},
        artifacts: parsed?.artifacts ?? [],
        traceOutputs: parsed?.traceOutputs ?? [],
        artifactsDir,
        durationMs: result.durationMs,
        logPath,
        ...(junitPath ? { junitPath } : {}),
        ...(result.errors.length ? { errors: result.errors } : {}),
        ...(result.warnings.length ? { warnings: result.warnings } : {}),
      },
      ...(artifacts.length ? { artifacts } : {}),
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
