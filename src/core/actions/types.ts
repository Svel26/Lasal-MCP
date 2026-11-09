import type { z } from "zod";
import type { ProjectContext } from "../project/context.js";

export type Domain = "core" | "class2" | "visu" | "screen" | "lars" | "deploy";

export type Risk = "read" | "write" | "destructive" | "deploy";

export interface ActionLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface ActionContext {
  project: ProjectContext | null;
  projectId: string | null;
  agentPid: number;
  confirm: boolean;
  dryRun: boolean;
  async: boolean;
  logger: ActionLogger;
  progress?: (message: string, percent?: number) => void;
  signal?: AbortSignal;
}

export interface ActionExample {
  params: unknown;
  note?: string;
}

export interface ActionArtifact {
  name: string;
  path: string;
  kind: string;
}

export interface ActionImage {
  mimeType: string;
  data: string;
}

export interface ActionDefinition<TParams = unknown> {
  /** Canonical dot ID, e.g. `class2.build.compile`. */
  id: string;
  /** Backward-compatible and ergonomic aliases, lower-case. */
  aliases: string[];
  domain: Domain;
  summary: string;
  description?: string;
  schema: z.ZodType<TParams>;
  handler: (params: TParams, ctx: ActionContext) => Promise<ActionResult>;
  risk: Risk;
  destructive: boolean;
  requiresConfirm: boolean;
  requiresProject: boolean;
  dryRunSupported?: boolean;
  asyncCapable?: boolean;
  idempotent?: boolean;
  /** Gated behind `--allow-expert`; also hidden from find unless requested. */
  expert?: boolean;
  tags: string[];
  examples: ActionExample[];
  hints?: string[];
  deprecated?: { since: string; use: string; removeIn?: string };
}

export interface ActionErrorDetail {
  code: string;
  message: string;
  fieldErrors?: Array<{ path: string; message: string; code: string }>;
  schema?: unknown;
  example?: unknown;
  suggestions?: string[];
  hints?: string[];
}

export interface ActionResult {
  ok: boolean;
  data?: unknown;
  error?: ActionErrorDetail;
  warnings?: string[];
  hints?: string[];
  artifacts?: ActionArtifact[];
  images?: ActionImage[];
  jobId?: string;
  nextSteps?: string[];
}

export interface ActionEnvelope {
  ok: boolean;
  action?: string;
  project?: { id: string; root: string };
  result?: unknown;
  error?: string;
  code?: string;
  fieldErrors?: Array<{ path: string; message: string; code: string }>;
  schema?: unknown;
  example?: unknown;
  suggestions?: string[];
  warnings?: string[];
  hints?: string[];
  artifacts?: ActionArtifact[];
  images?: ActionImage[];
  jobId?: string;
  nextSteps?: string[];
  [key: string]: unknown;
}

export function defineAction<TParams>(definition: ActionDefinition<TParams>): ActionDefinition<TParams> {
  return definition;
}

/**
 * Type-erased action definition used by the registry and generic catalog tools.
 * Concrete actions remain fully typed at their definition site; the executor
 * validates params before calling the handler.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any>;
