import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runProcess, ProcessResult, teardownEngine, killActiveIDE } from './processRunner.js';

export interface JobState {
  ok: boolean;
  status: 'pending' | 'completed' | 'failed';
  jobId: string;
  engine: 'class2' | 'visudesigner' | 'machinemanager' | 'fs';
  exitCode: number | null;
  durationMs: number | null;
  logPath: string | null;
  errors: string[];
  warnings: string[];
  data: any;
  command: string;
}

// In-memory job store
const jobs = new Map<string, JobState>();

// Queue helper to serialize executions globally (ensuring single-instance IDE runs)
class TaskQueue {
  private pending = Promise.resolve();

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn);
    this.pending = next.then(
      () => {},
      () => {}
    );
    return next;
  }
}

const globalQueue = new TaskQueue();

/**
 * Runs a function on the global serialization queue and awaits its result.
 * Use for synchronous engine calls so they never run concurrently with queued jobs
 * (avoids two Lasal2 instances / teardown killing an in-flight read).
 */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  return globalQueue.enqueue(fn);
}

export function createJob(
  engine: JobState['engine'],
  command: string
): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    ok: true,
    status: 'pending',
    jobId,
    engine,
    exitCode: null,
    durationMs: null,
    logPath: null,
    errors: [],
    warnings: [],
    data: null,
    command
  });
  return jobId;
}

export function getJob(jobId: string): JobState | null {
  return jobs.get(jobId) || null;
}

export function updateJob(jobId: string, updates: Partial<JobState>): void {
  const job = jobs.get(jobId);
  if (job) {
    jobs.set(jobId, { ...job, ...updates });
  }
}

/**
 * Gets a deterministic temporary file path in the temp directory.
 */
export function getTempFilePath(prefix: string, ext: string): string {
  const tempDir = path.join(os.tmpdir(), 'lasal-mcp-jobs');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return path.join(tempDir, `${prefix}-${uuidv4()}${ext}`);
}

/**
 * Clean up old temp files (e.g. from previous server runs)
 */
export function cleanTempFolder(): void {
  try {
    const tempDir = path.join(os.tmpdir(), 'lasal-mcp-jobs');
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(tempDir, file));
        } catch {
          // Ignore files that are locked/in-use
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Run a task on a serialized queue and update the job registry.
 */
export function kickoffJob(
  jobId: string,
  engine: 'class2' | 'visudesigner' | 'machinemanager',
  exePath: string,
  cliArgs: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    logPath?: string;
    logFolderToScan?: string; // Used for MachineManager to scan for newest log
    dataExtractor?: (result: ProcessResult) => any;
    // Which processes to terminate BEFORE running, to free file locks. Runs
    // inside the serialized queue so it can never kill a still-running prior job.
    // 'ide' kills both IDEs (Lasal2 + VISUDesigner) ahead of a MachineManager run.
    teardownBefore?: 'class2' | 'visudesigner' | 'ide';
    // Path to a file where the VD Python script writes exception tracebacks.
    // VISUDesigner is a GUI app; stderr is not reliably captured, so errors
    // must be read back from this file after the process exits.
    visuErrorPath?: string;
    // Path to a file where the Class 2 script writes exception tracebacks.
    // Lasal2.exe is also a GUI-subsystem app; same capture problem as above.
    class2ErrorPath?: string;
  } = {}
): void {
  // Queue the execution so it runs in order
  globalQueue.enqueue(async () => {
    updateJob(jobId, { status: 'pending' });

    try {
      // Teardown MUST happen here (serialized), not in the dispatch handler:
      // doing it at dispatch time would taskkill a previously-queued job that
      // is still executing on this same queue.
      if (options.teardownBefore === 'ide') {
        await killActiveIDE();
      } else if (options.teardownBefore) {
        await teardownEngine(options.teardownBefore);
      }

      const runStartedAt = Date.now();
      const result = await runProcess(engine, exePath, cliArgs, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs
      });

      const errors: string[] = [];
      const warnings: string[] = [];
      let ok = result.ok;

      // Extract details from stdout/stderr.
      // VISUDesigner (Chromium/CEF) emits internal noise on stderr that matches
      // [pid:tid:timestamp:LEVEL:source.cc(line)] patterns — filter these out so
      // they don't pollute the errors array on otherwise-successful jobs.
      if (result.stderr) {
        const chromiumNoise = /^\[\d+:\d+:\d{4}\/\d{6}\.\d+:[A-Z]+:[^\]]+\(\d+\)]/;
        const errLines = result.stderr
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length > 0 && !chromiumNoise.test(l));
        errors.push(...errLines);
      }

      // Read VISUDesigner error file if provided (GUI app, stderr not captured)
      if (options.visuErrorPath && fs.existsSync(options.visuErrorPath)) {
        try {
          const errText = fs.readFileSync(options.visuErrorPath, 'utf8').trim();
          if (errText) {
            errors.push(...errText.split('\n').map(l => l.trim()).filter(l => l.length > 0));
            ok = false;
          }
          fs.unlinkSync(options.visuErrorPath);
        } catch { /* ignore cleanup errors */ }
      }

      // Read Class 2 error file if provided (Lasal2.exe is also a GUI app)
      if (options.class2ErrorPath && fs.existsSync(options.class2ErrorPath)) {
        try {
          const errText = fs.readFileSync(options.class2ErrorPath, 'latin1').trim();
          if (errText) {
            errors.push(...errText.split('\n').map(l => l.trim()).filter(l => l.length > 0));
            ok = false;
          }
          fs.unlinkSync(options.class2ErrorPath);
        } catch { /* ignore cleanup errors */ }
      }

      // Check log file if we have one (Class 2)
      if (options.logPath && fs.existsSync(options.logPath)) {
        try {
          const logContent = fs.readFileSync(options.logPath, 'latin1');
          const lines = logContent.split(/\r?\n/);
          let logHasErrors = false;
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.includes('(ERROR)') || trimmed.includes('(FATAL)')) {
              errors.push(trimmed);
              ok = false;
              logHasErrors = true;
            } else if (trimmed.includes('(WARN)') || trimmed.includes('(WARNING)')) {
              warnings.push(trimmed);
            }
          }
          // Class 2 exits with code 1 when a project has compile warnings but otherwise
          // succeeded. If the log was produced and has no ERROR/FATAL entries, treat
          // exit code 1 as a clean run with warnings only.
          if (engine === 'class2' && result.exitCode === 1 && !logHasErrors) {
            ok = true;
          }
        } catch (e: any) {
          errors.push(`Failed to read Class 2 log file: ${e.message}`);
          ok = false;
        }
      }

      // Check MachineManager log folder if applicable
      if (engine === 'machinemanager' && options.logFolderToScan && fs.existsSync(options.logFolderToScan)) {
        try {
          const files = fs.readdirSync(options.logFolderToScan);
          // Find the newest file written DURING this run. Anything older is a
          // stale log from a previous run and must not be parsed as our result.
          // (1s skew tolerance for clock/filesystem granularity.)
          let newestFile: string | null = null;
          let newestMtime = 0;
          for (const file of files) {
            const fullPath = path.join(options.logFolderToScan, file);
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && stat.mtimeMs >= runStartedAt - 1000 && stat.mtimeMs > newestMtime) {
              newestMtime = stat.mtimeMs;
              newestFile = fullPath;
            }
          }

          if (!newestFile) {
            warnings.push('No MachineManager log was produced for this run; result is based on exit code only.');
          } else {
            const logContent = fs.readFileSync(newestFile, 'latin1');
            // Parse MM log for status lines.
            // Example failure lines: "HOLD ON ERROR" or aborts, or non-100% states.
            const lines = logContent.split(/\r?\n/);
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed.toLowerCase().includes('error') || trimmed.toLowerCase().includes('failed') || trimmed.toLowerCase().includes('abort')) {
                errors.push(`MM Log: ${trimmed}`);
                ok = false;
              }
            }
            updateJob(jobId, { logPath: newestFile });
          }
        } catch (e: any) {
          errors.push(`Failed to scan MachineManager log folder: ${e.message}`);
          ok = false;
        }
      }

      // Extract custom data if provided
      let data: any = null;
      if (options.dataExtractor) {
        try {
          data = options.dataExtractor(result);
        } catch (e: any) {
          errors.push(`Failed to extract data: ${e.message}`);
          ok = false;
        }
      }

      updateJob(jobId, {
        status: ok ? 'completed' : 'failed',
        ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logPath: options.logPath || null,
        errors,
        warnings,
        data,
        command: result.command
      });

    } catch (err: any) {
      updateJob(jobId, {
        status: 'failed',
        ok: false,
        errors: [`Job wrapper crashed: ${err.message}`]
      });
    }
  });
}
