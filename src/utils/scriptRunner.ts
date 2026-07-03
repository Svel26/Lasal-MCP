import { existsSync, readFileSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";

export interface EngineRunOptions {
  exe: string;                             // CLASS2_EXE or VISUDESIGNER_EXE
  argsFor(scriptPath: string): string[];    // e.g. ["/script:..."] vs ["--script", "..."]
  timeoutMs: number;
  logEncoding: "latin1" | "utf-8";         // Class2 batch log = latin1, visu log = utf-8
  killOnFailure(): void;                   // killClass2 / killVisuDesigner
  expectedSteps: string[];                 // labels of "(STEP) <label> OK" markers the script must emit
  stepsPath: string;                       // Path to the sidecar steps file
}

export interface StepOutcome {
  label: string;
  status: "ok" | "failed" | "not_reached";
  detail?: string;
}

export interface EngineRunResult {
  ok: boolean;                             // exitCode===0 AND no (ERROR)/(FATAL) AND all expectedSteps confirmed
  exitCode: number;
  timedOut: boolean;                       // distinguish kill-on-timeout from real failure
  steps: StepOutcome[];                    // positive per-op confirmation
  errors: string[];
  warnings: string[];
  logTail: string[];
  logPath: string;
  durationMs: number;
  hints: string[];                         // recovery guidance mapped from known error patterns
}

const HINT_TABLE = [
  {
    pattern: /connect|timeout|1954|offline/i,
    hint: "PLC or HMI is unreachable. Check network/power, target IP with lasal_status, or set it via set_target_ip."
  },
  {
    pattern: /no project|load project|failed to load/i,
    hint: "Project failed to load. Verify the project path or call select_project."
  },
  {
    pattern: /lock|locked|sharing violation|permission denied/i,
    hint: "Project files or engine locked. Close CLASS 2 or VISUDesigner via manage_class2/manage_visudesigner close."
  },
  {
    pattern: /compile|syntax error|declaration/i,
    hint: "Compilation failed. Check the compiler log for syntax errors."
  },
  {
    pattern: /channel not found|not exist|unknown channel/i,
    hint: "Channel not found. Check ObjectName.ChannelName spelling/casing via inspect_project."
  }
];

export function runEngineScript(
  scriptPath: string,
  opts: EngineRunOptions,
  logPath: string
): EngineRunResult {
  const start = Date.now();
  let exitCode = 0;
  let timedOut = false;
  const errors: string[] = [];
  const warnings: string[] = [];
  const logTail: string[] = [];

  const args = opts.argsFor(scriptPath);

  try {
    execFileSync(opts.exe, args, {
      timeout: opts.timeoutMs,
      stdio: "pipe",
      windowsHide: true,
    });
  } catch (e: any) {
    if (e.code === "ETIMEDOUT" || e.signal === "SIGTERM") {
      timedOut = true;
      errors.push(`Engine execution timed out after ${opts.timeoutMs / 1000}s.`);
    } else {
      exitCode = e.status ?? 1;
      const stderr = (e.stderr ?? "").toString("utf-8").trim();
      if (stderr) {
        errors.push(...stderr.split("\n").map((l: string) => l.trim()).filter(Boolean));
      }
    }
    opts.killOnFailure();
  }

  const durationMs = Date.now() - start;

  // Read and parse logs
  let logContent = "";
  if (existsSync(logPath)) {
    try {
      logContent = readFileSync(logPath, opts.logEncoding);
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
      
      // If we failed, include the last 15 lines of the log for context
      if (exitCode !== 0 || errors.length > 0 || timedOut) {
        logTail.push(...lines.filter(l => l.trim()).slice(-15).map(l => l.trim()));
      }
    } catch {}
  }

  // Parse steps file
  const confirmed = new Set<string>();
  if (existsSync(opts.stepsPath)) {
    try {
      const stepsContent = readFileSync(opts.stepsPath, "utf-8");
      const lines = stepsContent.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("STEP ") && trimmed.endsWith(" OK")) {
          const label = trimmed.slice(5, -3).trim();
          confirmed.add(label);
        }
      }
    } catch {}
  }

  // Construct step outcomes
  const steps: StepOutcome[] = [];
  let hasFailed = false;
  for (const label of opts.expectedSteps) {
    if (confirmed.has(label)) {
      steps.push({ label, status: "ok" });
    } else if (timedOut || exitCode !== 0 || errors.length > 0) {
      if (!hasFailed) {
        steps.push({ label, status: "failed" });
        hasFailed = true;
      } else {
        steps.push({ label, status: "not_reached" });
      }
    } else {
      // Succeeded but step marker is missing (e.g. silent exit)
      if (!hasFailed) {
        steps.push({ label, status: "failed" });
        hasFailed = true;
      } else {
        steps.push({ label, status: "not_reached" });
      }
    }
  }

  // If there are unconfirmed expected steps, that itself is an error
  const allStepsConfirmed = opts.expectedSteps.every(s => confirmed.has(s));
  if (!allStepsConfirmed && errors.length === 0 && !timedOut) {
    errors.push("Engine exited but not all expected operations completed successfully.");
  }

  // Generate hints
  const hints: string[] = [];
  if (timedOut) {
    hints.push("Timed out — for large projects raise the timeout via the tool's timeout_s argument or LASAL_MCP_TIMEOUT_* environment variables.");
  }
  for (const mapping of HINT_TABLE) {
    const matched = errors.some(err => mapping.pattern.test(err)) || 
                    warnings.some(warn => mapping.pattern.test(warn)) ||
                    logContent.match(mapping.pattern);
    if (matched && !hints.includes(mapping.hint)) {
      hints.push(mapping.hint);
    }
  }

  return {
    ok: exitCode === 0 && errors.length === 0 && !timedOut && allStepsConfirmed,
    exitCode,
    timedOut,
    steps,
    errors,
    warnings,
    logTail,
    logPath,
    durationMs,
    hints
  };
}
