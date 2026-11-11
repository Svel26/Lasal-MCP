import type { AnyActionDefinition, Domain, Risk } from "./types.js";
import type { ActionRegistry } from "./registry.js";

export interface ActionSearchOptions {
  query?: string;
  domain?: Domain;
  tags?: string[];
  risk?: Risk[];
  includeExpert?: boolean;
  limit?: number;
}

export interface ActionSearchHit {
  action: AnyActionDefinition;
  score: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(insertion, deletion, substitution);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j] ?? 0;
  }
  return previous[b.length] ?? 0;
}

/**
 * Local, deterministic search over the action catalog. No engine calls, no
 * embeddings, no network — just enough ranking to make `find_action` useful.
 */
export function searchActions(registry: ActionRegistry, options: ActionSearchOptions = {}): ActionSearchHit[] {
  const query = normalize(options.query ?? "");
  const queryTokens = tokens(query);
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);

  const candidates = registry.list({
    ...(options.domain ? { domains: [options.domain] } : {}),
    ...(options.risk ? { risks: options.risk } : {}),
    ...(options.tags ? { tags: options.tags } : {}),
    includeExpert: options.includeExpert ?? false,
  });

  const hits: ActionSearchHit[] = [];
  for (const action of candidates) {
    const id = normalize(action.id);
    const aliases = action.aliases.map(normalize);
    const summary = normalize(action.summary);
    const description = normalize(action.description ?? "");
    const tags = action.tags.map(normalize);
    let score = 0;

    if (!query) {
      score = 1;
    } else if (id === query) {
      score = 1000;
    } else if (aliases.includes(query)) {
      score = 900;
    } else {
      if (id.includes(query)) score += 220;
      if (aliases.some((alias) => alias.includes(query))) score += 180;
      if (summary.includes(query)) score += 80;
      if (description.includes(query)) score += 30;
      if (tags.some((tag) => tag.includes(query))) score += 50;

      for (const token of queryTokens) {
        if (id.includes(token)) score += 40;
        if (aliases.some((alias) => alias.includes(token))) score += 30;
        if (summary.includes(token)) score += 15;
        if (description.includes(token)) score += 8;
        if (tags.some((tag) => tag.includes(token))) score += 20;
      }

      if (score === 0 && query.length >= 3) {
        const distances = [id, ...aliases].map((candidate) => levenshtein(query, candidate));
        const closest = Math.min(...distances);
        if (closest <= 3) score = 40 - closest * 8;
      }
    }

    if (score > 0) hits.push({ action, score });
  }

  return hits.sort((a, b) => b.score - a.score || a.action.id.localeCompare(b.action.id)).slice(0, limit);
}

export function suggestActions(registry: ActionRegistry, query: string, limit = 5): string[] {
  return searchActions(registry, { query, limit, includeExpert: true }).map((hit) => hit.action.id);
}
