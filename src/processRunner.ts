import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execPromise = promisify(exec);

export interface ProcessResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
}

/**
 * Terminate any running Lasal2 and VISUDesigner processes to free up file locks.
 */
export async function killActiveIDE(): Promise<void> {
  // Execute taskkill for both engines and ignore errors (if they aren't running)
  try {
    await execPromise('taskkill /F /IM Lasal2.exe /T');
  } catch {
    // Process was not running or couldn't be killed, ignore
  }

  try {
    await execPromise('taskkill /F /IM VISUDesigner.exe /T');
  } catch {
    // Process was not running or couldn't be killed, ignore
  }
}

/**
 * Specific teardown after a process execution fails or times out.
 */
export async function teardownEngine(engine: 'class2' | 'visudesigner' | 'machinemanager'): Promise<void> {
  const targets: string[] = [];
  if (engine === 'class2') {
    targets.push('Lasal2.exe');
  } else if (engine === 'visudesigner') {
    targets.push('VISUDesigner.exe');
  } else if (engine === 'machinemanager') {
    targets.push('MachineManager.exe');
  }

  for (const exe of targets) {
    try {
      await execPromise(`taskkill /F /IM ${exe} /T`);
    } catch {
      // Ignore errors
    }
  }
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  args?: string[];
}

/**
 * Runs a process with timeout and strict teardown on error/timeout.
 */
export async function runProcess(
  engine: 'class2' | 'visudesigner' | 'machinemanager',
  exePath: string,
  cliArgs: string[],
  options: RunOptions = {}
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 300000; // default 5 minutes
  const startTime = Date.now();
  const command = `"${exePath}" ${cliArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;

  return new Promise<ProcessResult>((resolve) => {
    let stdoutData = '';
    let stderrData = '';
    let resolved = false;

    const child = spawn(exePath, cliArgs, {
      cwd: options.cwd || path.dirname(exePath),
      windowsHide: true
    });

    const timeout = setTimeout(async () => {
      if (resolved) return;
      resolved = true;
      
      // Kill the child process and tree
      child.kill();
      await teardownEngine(engine);

      const durationMs = Date.now() - startTime;
      resolve({
        ok: false,
        exitCode: null,
        stdout: stdoutData + `\n[Process Timed Out after ${timeoutMs}ms]`,
        stderr: stderrData + `\n[Process Timed Out after ${timeoutMs}ms]`,
        durationMs,
        command
      });
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('error', async (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      
      await teardownEngine(engine);

      const durationMs = Date.now() - startTime;
      resolve({
        ok: false,
        exitCode: null,
        stdout: stdoutData,
        stderr: stderrData + `\n[Execution Error: ${err.message}]`,
        durationMs,
        command
      });
    });

    child.on('exit', async (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      const durationMs = Date.now() - startTime;

      // Class 2 exit code 102 indicates untrapped exception, VISUDesigner exits non-zero on crashes.
      // If exit code is not 0, or is 102, run taskkill teardown to ensure cleanup.
      const ok = code === 0;
      if (code !== 0) {
        await teardownEngine(engine);
      }

      resolve({
        ok,
        exitCode: code,
        stdout: stdoutData,
        stderr: stderrData,
        durationMs,
        command
      });
    });
  });
}
