export type McpLogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

export type McpExtra = unknown;

export interface McpReporter {
  report(progress: number, total?: number, message?: string): Promise<void>;
  log(level: McpLogLevel, data: unknown): Promise<void>;
}

interface McpNotificationSender {
  _meta?: {
    progressToken?: string | number;
  };
  sendNotification?: (notification: { method: string; params?: unknown }) => Promise<void>;
}

export function createProgressReporter(extra?: unknown, loggerName = "lasal-mcp"): McpReporter {
  const sender = extra as McpNotificationSender | undefined;
  const progressToken = sender?._meta?.progressToken;

  return {
    async report(progress: number, total = 100, message?: string): Promise<void> {
      if (progressToken !== undefined && sender?.sendNotification) {
        try {
          await sender.sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              total,
              message,
            },
          });
        } catch {
          // Ignore failures when client disconnects or ignores progress
        }
      }
    },

    async log(level: McpLogLevel, data: unknown): Promise<void> {
      if (sender?.sendNotification) {
        try {
          await sender.sendNotification({
            method: "notifications/message",
            params: {
              level,
              data,
              logger: loggerName,
            },
          });
        } catch {
          // Ignore failures when client ignores logs
        }
      }
    },
  };
}
