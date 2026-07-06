import { execSync } from "child_process";

export function isPidRunning(pid: number): boolean {
  try {
    execSync(`tasklist /FI "PID eq ${pid}" | findstr ${pid}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function getPortForPid(pid: number): number {
  try {
    const out = execSync(
      `powershell -Command "(Get-NetTCPConnection -OwningProcess ${pid} -State Listen).Port"`,
      { encoding: "utf-8" },
    ).trim();
    const ports = out
      .split(/[\r\n]+/)
      .map((p) => parseInt(p.trim()))
      .filter((p) => !isNaN(p) && p > 0);
    if (ports.length > 0) {
      ports.sort((a, b) => a - b);
      const port = ports[0];
      if (port !== undefined) {
        return port;
      }
    }
  } catch {}
  return 9980;
}
