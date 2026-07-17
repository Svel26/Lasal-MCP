import { existsSync, readFileSync } from "fs";
import { execFile } from "child_process";

export interface EngineRunOptions {
  exe: string;
  argsFor(scriptPath: string): string[];
  timeoutMs: number;
  logEncoding: "latin1" | "utf-8";
  killOnFailure(): void;
  expectedSteps: string[];
  stepsPath: string;
}

export interface StepOutcome {
  label: string;
  status: "ok" | "failed" | "not_reached";
  detail?: string;
}

export interface EngineRunResult {
  ok: boolean;
  exitCode: number;
  timedOut: boolean;
  steps: StepOutcome[];
  errors: string[];
  warnings: string[];
  logTail: string[];
  logPath: string;
  durationMs: number;
  hints: string[];
}

const HINT_TABLE = [
  {
    pattern: /connect|timeout|1954|offline/i,
    hint: "PLC or HMI is unreachable. Check network/power, target IP with lasal_status, or set it via set_target_ip.",
  },
  {
    pattern: /no project|load project|failed to load/i,
    hint: "Project failed to load. Verify the project path or call select_project.",
  },
  {
    pattern: /lock|locked|sharing violation|permission denied/i,
    hint: "Project files or engine locked. Close CLASS 2 or VISUDesigner via manage_class2/manage_visudesigner close.",
  },
  {
    pattern: /compile|syntax error|declaration/i,
    hint: "Compilation failed. Check the compiler log for syntax errors.",
  },
  {
    pattern: /channel not found|not exist|unknown channel/i,
    hint: "Channel not found. Check ObjectName.ChannelName spelling/casing via inspect_project.",
  },
];

function executeEngine(
  exe: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; timedOut: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(exe, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, _stdout, stderr) => {
      if (error) {
        const timedOut = error.killed || (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
        resolve({
          exitCode: error.code !== undefined && typeof error.code === "number" ? error.code : (child.exitCode ?? 1),
          timedOut,
          stderr: stderr?.toString() ?? "",
        });
      } else {
        resolve({ exitCode: 0, timedOut: false, stderr: "" });
      }
    });
  });
}

function parseLog(
  logPath: string,
  encoding: "latin1" | "utf-8",
  hasFailed: boolean,
): { errors: string[]; warnings: string[]; logTail: string[]; logContent: string } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const logTail: string[] = [];

  if (!existsSync(logPath)) return { errors, warnings, logTail, logContent: "" };

  let logContent = "";
  try {
    logContent = readFileSync(logPath, encoding);
    const lines = logContent.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.includes("(ERROR)") || trimmed.includes("(FATAL)")) {
        errors.push(trimmed);
      } else if (trimmed.includes("(WARN)")) {
        warnings.push(trimmed);
      }
    }

    if (hasFailed) {
      logTail.push(
        ...lines
          .filter((l) => l.trim())
          .slice(-15)
          .map((l) => l.trim()),
      );
    }
  } catch {}
  return { errors, warnings, logTail, logContent };
}

function parseSteps(stepsPath: string, expectedSteps: string[]): { steps: StepOutcome[]; allConfirmed: boolean } {
  const confirmed = new Set<string>();
  if (existsSync(stepsPath)) {
    try {
      const stepsContent = readFileSync(stepsPath, "utf-8");
      for (const line of stepsContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("STEP ") && trimmed.endsWith(" OK")) {
          confirmed.add(trimmed.slice(5, -3).trim());
        }
      }
    } catch {}
  }

  const steps: StepOutcome[] = [];
  let hasFailed = false;
  for (const label of expectedSteps) {
    if (confirmed.has(label)) {
      steps.push({ label, status: "ok" });
    } else {
      steps.push({ label, status: hasFailed ? "not_reached" : "failed" });
      hasFailed = true;
    }
  }

  return { steps, allConfirmed: expectedSteps.every((s) => confirmed.has(s)) };
}

export async function runEngineScript(
  scriptPath: string,
  opts: EngineRunOptions,
  logPath: string,
): Promise<EngineRunResult> {
  const start = Date.now();
  const args = opts.argsFor(scriptPath);

  const { exitCode, timedOut, stderr } = await executeEngine(opts.exe, args, opts.timeoutMs);

  if (timedOut || exitCode !== 0) {
    opts.killOnFailure();
  }

  const errors: string[] = [];
  if (timedOut) {
    errors.push(`Engine execution timed out after ${opts.timeoutMs / 1000}s.`);
  } else if (stderr.trim()) {
    errors.push(
      ...stderr
        .split("\n")
        .map((l: string) => l.trim())
        .filter(Boolean),
    );
  }

  const durationMs = Date.now() - start;

  const hasFailed = exitCode !== 0 || errors.length > 0 || timedOut;
  const log = parseLog(logPath, opts.logEncoding, hasFailed);
  errors.push(...log.errors);

  const { steps, allConfirmed } = parseSteps(opts.stepsPath, opts.expectedSteps);

  if (!allConfirmed && log.errors.length === 0 && !timedOut) {
    const lastConfirmed = [...opts.expectedSteps].reverse().find((s) =>
      steps.find((st) => st.label === s && st.status === "ok"),
    );
    const firstMissing = opts.expectedSteps.find((s) => !steps.find((st) => st.label === s && st.status === "ok"));
    errors.push(
      `Engine exited but not all expected operations completed. ` +
        `Last confirmed: ${lastConfirmed ?? "(none)"}. First missing: ${firstMissing ?? "(unknown)"}.`,
    );
  }

  const hints: string[] = [];
  if (timedOut) {
    hints.push(
      "Timed out — for large projects raise the timeout via the tool's timeout_s argument or LASAL_MCP_TIMEOUT_* environment variables.",
    );
  }
  const hasFailed2 = exitCode !== 0 || errors.length > 0 || timedOut || !allConfirmed;
  if (hasFailed2) {
    for (const mapping of HINT_TABLE) {
      const matched =
        errors.some((err) => mapping.pattern.test(err)) ||
        log.warnings.some((warn) => mapping.pattern.test(warn)) ||
        log.logTail.some((line) => mapping.pattern.test(line));
      if (matched && !hints.includes(mapping.hint)) {
        hints.push(mapping.hint);
      }
    }
  }

  return {
    ok: exitCode === 0 && errors.length === 0 && !timedOut && allConfirmed,
    exitCode,
    timedOut,
    steps,
    errors,
    warnings: log.warnings,
    logTail: log.logTail,
    logPath,
    durationMs,
    hints,
  };
}
