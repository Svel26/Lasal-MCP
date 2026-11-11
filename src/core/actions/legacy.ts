import type { ActionResult, ActionArtifact, ActionImage } from "./types.js";
import type { ToolResponse } from "../../utils/respond.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length ? strings : undefined;
}

function artifacts(value: unknown): ActionArtifact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: ActionArtifact[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name !== "string" || typeof entry.path !== "string" || typeof entry.kind !== "string") continue;
    result.push({ name: entry.name, path: entry.path, kind: entry.kind });
  }
  return result.length ? result : undefined;
}

/**
 * Temporary adapter for existing tool handlers. New domain handlers should
 * return `ActionResult` directly; this keeps the catalog usable while the
 * handlers are migrated incrementally.
 */
export function fromToolResponse(response: ToolResponse): ActionResult {
  const text = response.content
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("\n")
    .trim();

  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Plain-text result.
    }
  }

  const record = isRecord(data) ? data : undefined;
  const warnings = stringArray(record?.warnings);
  const hints = stringArray(record?.hints);
  const artifactList = artifacts(record?.artifacts);
  const images: ActionImage[] = response.content
    .filter((entry): entry is { type: "image"; data: string; mimeType: string } => entry.type === "image")
    .map((entry) => ({ mimeType: entry.mimeType, data: entry.data }));

  if (response.isError) {
    const message =
      typeof record?.error === "string"
        ? record.error
        : text || "The underlying tool reported an error without a message.";
    return {
      ok: false,
      data,
      error: { code: "ACTION_FAILED", message },
      ...(warnings ? { warnings } : {}),
      ...(hints ? { hints } : {}),
      ...(images.length ? { images } : {}),
    };
  }

  return {
    ok: true,
    data,
    ...(warnings ? { warnings } : {}),
    ...(hints ? { hints } : {}),
    ...(artifactList ? { artifacts: artifactList } : {}),
    ...(images.length ? { images } : {}),
  };
}
