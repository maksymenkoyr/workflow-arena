// Type declarations for workflowStatsLib.mjs, hand-written because tests/*.ts
// is typechecked (tsconfig.json) and a .mjs has no inferred types of its own.
// Keep in sync with the JSDoc in workflowStatsLib.mjs by hand.

export const GRADE_POINTS: Record<string, number>;
export interface PriceCard {
  input: number;
  output: number;
  cacheRead: number;
}

export const PRICES: Record<string, PriceCard & { long?: PriceCard & { above: number } }>;
export const CACHE_WRITE_MULT: number;
export const STAGES: readonly string[];

export type StageName = "plan" | "replan" | "code" | "solo" | "fix" | "review" | "finish" | "opusfix" | "check" | "grade";

export interface Tokens {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  outputSeen: number;
}

export interface Cost {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

export interface TranscriptStats {
  model: string | null;
  effort: string | null;
  requests: number;
  tokens: Tokens;
  /** The part of `tokens` from requests billed at the model's `long` card. */
  longTokens: Tokens;
  peakContext: number;
  minutes: number;
}

export interface AgentStats {
  label: string;
  stage: StageName;
  round: number;
  model: string | null;
  effort: string | null;
  requests: number;
  toolCalls: number | null;
  minutes: number;
  peakContext: number;
  tokens: Tokens;
  longTokens: Tokens;
  cost: Cost | null;
}

export interface StageTotals {
  model: string | null;
  effort: string | null;
  agents: number;
  minutes: number;
  requests: number;
  toolCalls: number;
  peakContext: number;
  tokens: Tokens;
  cost: number;
  typecheckPassed?: boolean | null;
  testsPassed?: boolean | null;
  deviations?: string;
}

export interface Finding {
  severity: string | null;
  origin: string | null;
  kind: string | null;
  fixed: boolean | null;
  file: string | null;
  summary: string;
}

export interface Row {
  runId: string;
  workflow: string | null;
  version: number;
  maxRounds: number;
  forkRun: boolean;
  /** One agent built it alone and a `grade` agent measured it. */
  solo: boolean;
  /** The commit a benchmark run was pinned to; null on origin/main. */
  base: string | null;
  runStartedAt: string | null;
  recordedAt: string;
  issue: number;
  title: string | null;
  branch: string | null;
  alreadyDone: boolean | null;
  stages: Partial<Record<StageName, StageTotals>>;
  agents: AgentStats[];
  reviewRounds: number;
  converged: boolean | null;
  planGrade: string | null;
  codeGrade: string | null;
  finalCodeGrade: string | null;
  issueResolved: boolean | null;
  readyToShip: boolean | null;
  finalTypecheck: boolean | null;
  finalTests: boolean | null;
  findings: Finding[];
  findingsByRound: { round: number; findings: Finding[] }[];
  finishFixes: number;
  stalledFixes: number;
  fork: ForkArms | null;
  /** Every agent but `grade`. */
  cost: number;
  gradeCost: number | null;
}

/** Both arms after a forked first review; costs in USD per issue. */
export interface ForkArms {
  fixed: number;
  fixCost: number | null;
  checkCost: number | null;
  codeGrade: string | null;
  open: number | null;
  readyToShip: boolean | null;
  loopCost: number;
  loopOpen: number;
}

export interface StageSummary {
  issuesUsing: number;
  agents: number | null;
  minutes: number | null;
  requests: number | null;
  contextTokens: number | null;
  outputSeen: number | null;
  cost: number | null;
}

export interface Summary {
  setup: string;
  issues: number;
  runs: number;
  resolved: number;
  readyToShip: number;
  merged: number;
  converged: number | null;
  stalledFixes: number;
  reviewRounds: number | null;
  planGrade: number | null;
  codeGrade: number | null;
  finalCodeGrade: number | null;
  findingsPerIssue: { blocking: number; shouldFix: number; nit: number };
  fromPlanShare: number | null;
  weakTests: number;
  bugs: number;
  costPerIssue: number | null;
  fork: {
    issues: number;
    fixCost: number | null;
    checkCost: number | null;
    codeGrade: number | null;
    open: number | null;
    loopCost: number | null;
    loopOpen: number | null;
  } | null;
  stages: Partial<Record<StageName, StageSummary>>;
}

export function parseGrade(text: unknown): string | null;

export function wasBlocked(v: unknown): boolean;

export function parseLabel(label: string | null | undefined): { stage: StageName; issue: number; round: number } | null;

export function transcriptStats(entries: any[]): TranscriptStats;

export function forkIndex(entries: any[]): number;

export function costOf(model: string | null, tokens: Tokens, longTokens?: Tokens): Cost | null;

export function mergeRows(stored: Row[], added: Row[]): Row[];

export function setupKey(row: Row): string;

export function buildRows(run: {
  record: { runId: string; workflowName?: string; timestamp?: string; script?: string; args?: unknown };
  agents: { label: string; result: any; transcript: TranscriptStats; progress?: { toolCalls?: number; durationMs?: number } }[];
  recordedAt: string;
}): Row[];

export function summarize(rows: Row[], prState?: Map<string, string>): Summary[];

export function renderReport(
  summaries: Summary[],
  rows: Row[],
  opts?: { listIssues?: boolean; prState?: Map<string, string> },
): string;
