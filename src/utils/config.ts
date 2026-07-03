function envInt(name: string, fallback: number): number {
  const val = process.env[name];
  if (val !== undefined) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return fallback;
}

export const TIMEOUTS = {
  compile:  envInt("LASAL_MCP_TIMEOUT_COMPILE",  600_000),  // 600s
  download: envInt("LASAL_MCP_TIMEOUT_DOWNLOAD", 600_000), // 600s
  visu:     envInt("LASAL_MCP_TIMEOUT_VISU",     300_000),     // 300s
  script:   envInt("LASAL_MCP_TIMEOUT_SCRIPT",   120_000),   // 120s
};
