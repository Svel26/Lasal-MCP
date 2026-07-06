import { z } from "zod";

const envInt = z.coerce.number().int().positive();

const ConfigSchema = z.object({
  LASAL_MCP_TIMEOUT_COMPILE: envInt.default(600_000),
  LASAL_MCP_TIMEOUT_DOWNLOAD: envInt.default(600_000),
  LASAL_MCP_TIMEOUT_VISU: envInt.default(300_000),
  LASAL_MCP_TIMEOUT_SCRIPT: envInt.default(120_000),
  LASAL_MCP_HMI_DIR: z.string().default("C:\\lslvisu"),
  LASAL_MCP_SCRATCH_MAX_AGE_H: envInt.default(24),
});

function loadConfig() {
  const raw: Record<string, unknown> = {};
  for (const key of ConfigSchema.keyof().options) {
    const val = process.env[key];
    if (val !== undefined) raw[key] = val;
  }
  return ConfigSchema.parse(raw);
}

const cfg = loadConfig();

export const TIMEOUTS = {
  compile: cfg.LASAL_MCP_TIMEOUT_COMPILE,
  download: cfg.LASAL_MCP_TIMEOUT_DOWNLOAD,
  visu: cfg.LASAL_MCP_TIMEOUT_VISU,
  script: cfg.LASAL_MCP_TIMEOUT_SCRIPT,
};

export const HMI_DIR = cfg.LASAL_MCP_HMI_DIR;
export const SCRATCH_MAX_AGE_H = cfg.LASAL_MCP_SCRATCH_MAX_AGE_H;
