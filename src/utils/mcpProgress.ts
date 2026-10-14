import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

export type McpLogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

export interface McpReporter {
  report(progress: number, total?: number, message?: string): Promise<void>;
  log(level: McpLogLevel, data: unknown): Promise<void>;
}

export function createProgressReporter(extra?: RequestHandlerExtra<any, any>, loggerName = "lasal-mcp"): McpReporter {
  const progressToken = extra?._meta?.progressToken;

  return {
    async report(progress: number, total = 100, message?: string): Promise<void> {
      if (progressToken !== undefined && extra?.sendNotification) {
        try {
          await extra.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              total,
              message,
            },
          } as any);
        } catch {
          // Ignore failures when client disconnects or ignores progress
        }
      }
    },

    async log(level: McpLogLevel, data: unknown): Promise<void> {
      if (extra?.sendNotification) {
        try {
          await extra.sendNotification({
            method: "notifications/message",
            params: {
              level,
              data,
              logger: loggerName,
            },
          } as any);
        } catch {
          // Ignore failures when client ignores logs
        }
      }
    },
  };
}
