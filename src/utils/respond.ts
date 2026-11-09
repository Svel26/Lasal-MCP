export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResponse {
  content: ToolContent[];
  isError?: boolean;
  [key: string]: unknown;
}

export function respond(body: { ok: boolean; hints?: string[]; [k: string]: unknown }): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
    ...(body.ok ? {} : { isError: true }),
  };
}

export function fail(message: string, hints: string[], extra?: object): ToolResponse {
  return respond({
    ok: false,
    error: message,
    hints,
    ...extra,
  });
}
