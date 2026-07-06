import { existsSync, mkdirSync } from "fs";
import { SCRATCH } from "../utils/engine.js";

export function ensureScratch(): void {
  if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
}
