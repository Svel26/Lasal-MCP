import { z } from "zod";
import type { AnyActionDefinition } from "./types.js";

const schemaCache = new WeakMap<object, unknown>();

/** Convert an action's Zod schema to JSON Schema for `find_action`. */
export function actionJsonSchema(action: AnyActionDefinition): unknown {
  const cached = schemaCache.get(action as object);
  if (cached !== undefined) return cached;

  try {
    const schema = z.toJSONSchema(action.schema);
    schemaCache.set(action as object, schema);
    return schema;
  } catch {
    // Some custom schemas are not representable as JSON Schema. The action is
    // still executable; `find_action` simply returns the example without a schema.
    return undefined;
  }
}

export function actionExamples(action: AnyActionDefinition): Array<{ action: string; params: unknown; note?: string }> {
  return action.examples.map((example) => ({
    action: action.id,
    params: example.params,
    ...(example.note ? { note: example.note } : {}),
  }));
}
