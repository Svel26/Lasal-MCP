export interface ToolEnvelope {
  ok: boolean;
  durationMs?: number;
  errors?: string[];
  warnings?: string[];
  hints?: string[];
}

export function truncateArray<T>(arr: T[], limit: number, label: string): { items: T[]; truncated?: string } {
  if (arr.length <= limit) return { items: arr };
  return {
    items: arr.slice(0, limit),
    truncated: `Showing ${limit} of ${arr.length} ${label}. Use filters to narrow results.`,
  };
}
