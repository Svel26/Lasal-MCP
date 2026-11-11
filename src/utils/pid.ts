/**
 * Liveness check for a process id without spawning a shell.
 *
 * `process.kill(pid, 0)` does not send a signal; it only asks the OS whether the
 * pid exists. On Windows it throws ESRCH for dead pids and EPERM for processes
 * owned by another user, which still means "alive".
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
