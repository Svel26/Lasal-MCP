import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { SCRATCH } from "./engine.js";
import { randomUUID } from "crypto";

export class EditTransaction {
  private runId = randomUUID();
  private backupDir: string;
  private backups = new Map<string, string>(); // originalPath -> backupPath

  constructor() {
    this.backupDir = join(SCRATCH, `backup-${this.runId}`);
  }

  public backup(filePath: string): void {
    if (this.backups.has(filePath)) return;
    if (!existsSync(filePath)) return;
    
    if (!existsSync(this.backupDir)) {
      mkdirSync(this.backupDir, { recursive: true });
    }
    
    const backupFile = join(this.backupDir, `${randomUUID()}-${basename(filePath)}`);
    copyFileSync(filePath, backupFile);
    this.backups.set(filePath, backupFile);
  }

  public commit(): void {
    this.backups.clear();
  }

  public rollback(): { restored: string[] } {
    const restored: string[] = [];
    for (const [originalPath, backupPath] of this.backups.entries()) {
      try {
        copyFileSync(backupPath, originalPath);
        restored.push(originalPath);
      } catch {}
    }
    this.backups.clear();
    return { restored };
  }
}
