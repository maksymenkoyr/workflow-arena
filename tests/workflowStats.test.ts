import { describe, it, expect } from "vitest";
import {
  buildRows,
  costOf,
  forkIndex,
  mergeRows,
  parseGrade,
  parseLabel,
  PRICES,
  renderReport,
  setupKey,
  summarize,
  transcriptStats,
  wasBlocked,
} from "../tools/workflowStatsLib.mjs";

// The rows these build are what tools/workflow-stats.mjs stores and sums, so a
// wrong parse here quietly skews every comparison between setups.

type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number };

function assistant(model: string, effort: string, at: string, requestId: string, usage: Usage) {
  return { type: "assistant", effort, timestamp: at, requestId, message: { model, usage } };
}

function stage(model: string, effort: string, minutes: number) {
  const end = new Date(Date.UTC(2026, 9, 8, 0, minutes)).toISOString();
  return transcriptStats([
    { type: "user", timestamp: "2026-10-08T00:00:00.000Z" },
    assistant(model, effort, "2026-10-08T00:00:10.000Z", "req1", { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 40 }),
    assistant(model, effort, end, "req2", { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 60 }),
  ]);
}

const SCRIPT_V2 = "export const meta = {}\nconst WORKFLOW_VERSION = 2\n";
const SCRIPT_V3 = "export const meta = {}\nconst WORKFLOW_VERSION = 3\nconst DEFAULT_MAX_ROUNDS = 2\n";

const PLAN = { title: "Seven", already_done: false, branch: "b7", plan: "…" };
const CODE = { branch: "b7", typecheck_passed: true, tests_passed: false, deviations: "" };

function run(runId: string, script: string, review: Record<string, unknown>, coder = "claude-haiku-5-5") {
  return buildRows({
    record: { runId, workflowName: "plan-code-review", script, args: { issues: [7] } },
    recordedAt: "2026-10-08T01:00:00.000Z",
    agents: [
      { label: "plan #7", result: PLAN, transcript: stage("claude-sonnet-5-5", "high", 2) },
      { label: "code #7", result: CODE, transcript: stage(coder, "medium", 4) },
      { label: "review #7", result: review, transcript: stage("claude-opus-5-5", "high", 6) },
    ],
  });
}

const finding = (id: string, severity: string, fixed: boolean, origin = "code") =>
  ({ id, severity, origin, kind: "bug", file: "f.ts", summary: id, fixed });

describe("parseGrade", () => {
  it("reads a bare letter and the version-1 'letter: reason' text", () => {
    expect(parseGrade("A-")).toBe("A-");
    expect(parseGrade("B+: thorough but one slip")).toBe("B+");
    expect(parseGrade("B: followed the plan")).toBe("B");
  });

  it("refuses words that only start with a grade letter", () => {
    expect(parseGrade("Bad plan")).toBeNull();
    expect(parseGrade("E")).toBeNull();
    expect(parseGrade(undefined)).toBeNull();
  });
});

describe("wasBlocked", () => {
  it("takes a reason as a block and the words for nothing as no block", () => {
    expect(wasBlocked("could not cd into the worktree")).toBe(true);
    for (const v of ["", " ", "none", "None.", "N/A", "-", null, undefined]) expect(wasBlocked(v)).toBe(false);
  });
});

describe("mergeRows", () => {
  it("replaces a run's rows and keeps every other run's", () => {
    const row = (runId: string, issue: number) => ({ runId, issue }) as never;
    const merged = mergeRows([row("a", 1), row("a", 2), row("b", 1)], [row("a", 3)]);
    expect(merged).toEqual([row("b", 1), row("a", 3)]);
    expect(mergeRows([], [row("c", 1)])).toEqual([row("c", 1)]);
  });
});

describe("parseLabel", () => {
  it("splits a stage label into stage, issue and round", () => {
    expect(parseLabel("review #355")).toEqual({ stage: "review", issue: 355, round: 1 });
    expect(parseLabel("fix #346 r2")).toEqual({ stage: "fix", issue: 346, round: 2 });
    expect(parseLabel("grade #353")).toEqual({ stage: "grade", issue: 353, round: 1 });
    expect(parseLabel("verify #1")).toBeNull();
  });
});

describe("transcriptStats", () => {
  it("sums each request once and spans first to last timestamp", () => {
    const s = stage("claude-haiku-5-5", "medium", 3);
    expect(s).toMatchObject({ model: "claude-haiku-5-5", effort: "medium", requests: 2, minutes: 3, peakContext: 2005 });
    expect(s.tokens).toEqual({ input: 10, cacheWrite: 100, cacheRead: 3000, outputSeen: 100 });
  });

  it("does not double-count a request logged once per content block", () => {
    const usage = { input_tokens: 2, cache_creation_input_tokens: 500, cache_read_input_tokens: 7000, output_tokens: 8 };
    const s = transcriptStats([
      assistant("claude-opus-5-5", "high", "2026-10-08T00:00:00.000Z", "r", usage),
      assistant("claude-opus-5-5", "high", "2026-10-08T00:00:01.000Z", "r", { ...usage, output_tokens: 30 }),
    ]);
    expect(s.requests).toBe(1);
    expect(s.tokens).toEqual({ input: 2, cacheWrite: 500, cacheRead: 7000, outputSeen: 30 });
  });
});

describe("costOf", () => {
  it("prices cache writes above input and cache reads below it", () => {
    const c = costOf("claude-opus-5-5", { input: 1e6, cacheWrite: 1e6, cacheRead: 1e6, outputSeen: 1e6 })!;
    expect(c.cacheWrite).toBeGreaterThan(c.input);
    expect(c.cacheRead).toBeLessThan(c.input);
    expect(c.total).toBeCloseTo(c.input + c.cacheWrite + c.cacheRead + c.output);
    expect(costOf("claude-unknown", { input: 1, cacheWrite: 0, cacheRead: 0, outputSeen: 0 })).toBeNull();
  });

  it("bills a Haiku request whose prompt passes the long card's line at the long card", () => {
    const { long, ...short } = PRICES["claude-haiku-5-5"];
    const line = long!.above;
    const at = (n: number) => `2026-10-08T00:00:0${n}.000Z`;
    // One request just under the line, one just over it.
    const s = transcriptStats([
      assistant("claude-haiku-5-5", "xhigh", at(1), "under", { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: line, output_tokens: 1000 }),
      assistant("claude-haiku-5-5", "xhigh", at(2), "over", { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: line, output_tokens: 1000 }),
    ]);
    expect(s.longTokens).toEqual({ input: 1, cacheWrite: 0, cacheRead: line, outputSeen: 1000 });
    const c = costOf(s.model, s.tokens, s.longTokens)!;
    const expected = (line * short.cacheRead + 1000 * short.output + 1 * long!.input + line * long!.cacheRead + 1000 * long!.output) / 1e6;
    expect(c.total).toBeCloseTo(expected, 9);
    // Pricing it all at the short card is what the rows recorded before the split did.
    expect(costOf(s.model, s.tokens)!.total).toBeLessThan(c.total);
  });

  it("ignores longTokens for a model with no long card", () => {
    const t = { input: 1e6, cacheWrite: 0, cacheRead: 0, outputSeen: 0 };
    expect(costOf("claude-opus-5-5", t, t)!.total).toBeCloseTo(costOf("claude-opus-5-5", t)!.total);
    expect(transcriptStats([
      assistant("claude-opus-5-5", "high", "2026-10-08T00:00:00.000Z", "r", { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 900_000, output_tokens: 1 }),
    ]).longTokens).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, outputSeen: 0 });
  });
});

describe("buildRows", () => {
  it("joins plan, code and review into one row per issue", () => {
    const [row] = run("wf_a", SCRIPT_V2, {
      issue_resolved: true, ready_to_ship: true, plan_grade: "A-", code_grade: "B",
      typecheck_passed: true, tests_passed: true,
      findings: [{ severity: "should-fix", origin: "plan", kind: "weak-test", file: "t.ts", summary: "could not fail", fixed: true }],
    });
    expect(row).toMatchObject({
      runId: "wf_a", version: 2, issue: 7, title: "Seven", branch: "b7",
      planGrade: "A-", codeGrade: "B", issueResolved: true, readyToShip: true, reviewRounds: 1, converged: null,
    });
    expect(row.stages.code).toMatchObject({ testsPassed: false, minutes: 4, requests: 2 });
    expect(row.findings[0]).toMatchObject({ origin: "plan", kind: "weak-test", fixed: true });
    expect(row.cost).toBeCloseTo(row.agents.reduce((s, a) => s + (a.cost?.total ?? 0), 0));
  });

  it("treats a script without WORKFLOW_VERSION as version 1 and reads its haiku_grade", () => {
    const [row] = run("wf_old", "export const meta = {}", {
      plan_grade: "B-: one false fact", haiku_grade: "B+: solid", findings: [{ severity: "nit", file: "x", summary: "s", fixed: false }],
    });
    expect(row.version).toBe(1);
    expect(row.planGrade).toBe("B-");
    expect(row.codeGrade).toBe("B+");
    expect(row.findings[0].origin).toBeNull();
  });

  it("follows correction rounds: first-review grades, last-review grade, convergence", () => {
    const review = (code: string, findings: unknown[]) =>
      ({ issue_resolved: true, ready_to_ship: true, plan_grade: "B", code_grade: code, findings });
    const t = (m: string) => stage(m, "high", 1);
    const agents = (lastFindings: unknown[], fixResult: unknown = { commit: "c2", addressed: ["F1"], blocked: "" }) => [
      { label: "plan #7", result: PLAN, transcript: t("claude-sonnet-5-5") },
      { label: "code #7", result: CODE, transcript: t("claude-haiku-5-5") },
      { label: "review #7 r1", result: review("C", [finding("F1", "blocking", false, "plan"), finding("F2", "nit", false)]), transcript: t("claude-opus-5-5") },
      { label: "replan #7 r1", result: { amendment: "…" }, transcript: t("claude-sonnet-5-5") },
      { label: "fix #7 r1", result: fixResult, transcript: t("claude-haiku-5-5") },
      { label: "review #7 r2", result: review("A-", lastFindings), transcript: t("claude-opus-5-5") },
    ];
    const record = { runId: "wf_3", script: SCRIPT_V3, args: { issues: [7] } };
    const [passed] = buildRows({ record, recordedAt: "", agents: agents([finding("F1", "blocking", true, "plan"), finding("F2", "nit", false)]) });
    expect(passed).toMatchObject({ version: 3, maxRounds: 2, reviewRounds: 2, converged: true, codeGrade: "C", finalCodeGrade: "A-", finishFixes: 0 });
    expect(passed.stages.review?.agents).toBe(2);
    expect(passed.stages.replan?.agents).toBe(1);
    expect(passed.findings.map((f) => f.summary)).toEqual(["F1", "F2"]);
    expect(setupKey(passed)).toContain("up to 2 correction round(s)");

    const [stuck] = buildRows({ record, recordedAt: "", agents: agents([finding("F1", "blocking", false, "plan")]) });
    expect(stuck.converged).toBe(false);
    expect(stuck.stalledFixes).toBe(0);

    const [blocked] = buildRows({ record, recordedAt: "", agents: agents([finding("F1", "blocking", false, "plan")], { commit: "none", addressed: [], blocked: "sandbox" }) });
    expect(blocked.stalledFixes).toBe(1);
  });

  it("counts a version 6 last review's own fixes as reviewer fixes, not convergence", () => {
    const record = { runId: "wf_6", script: SCRIPT_V3.replace("= 3", "= 6"), args: { issues: [7] } };
    const t = (m: string) => stage(m, "high", 1);
    const lastReview = (selfFixed: string[]) => ({
      issue_resolved: true, ready_to_ship: true, plan_grade: "B", code_grade: "B",
      findings: [finding("F1", "should-fix", true), finding("F2", "nit", false)], self_fixed: selfFixed,
    });
    const agents = (selfFixed: string[]) => [
      { label: "plan #7", result: PLAN, transcript: t("claude-opus-5-5") },
      { label: "code #7", result: CODE, transcript: t("claude-haiku-5-5") },
      { label: "review #7 r1", result: lastReview(selfFixed), transcript: t("claude-opus-5-5") },
    ];
    const [fixedItself] = buildRows({ record, recordedAt: "", agents: agents(["F1"]) });
    expect(fixedItself).toMatchObject({ version: 6, converged: false, finishFixes: 1 });
    const [clean] = buildRows({ record, recordedAt: "", agents: agents([]) });
    expect(clean).toMatchObject({ converged: true, finishFixes: 0 });
  });
});

describe("buildRows fork", () => {
  it("prices and grades the reviewer-fix arm apart from the correction loop", () => {
    const record = { runId: "wf_7", script: SCRIPT_V3.replace("= 3", "= 7"), args: { issues: [7], fork: true } };
    const t = (m: string) => stage(m, "high", 1);
    const review = (code: string, findings: unknown[], extra = {}) =>
      ({ issue_resolved: true, ready_to_ship: true, plan_grade: "B", code_grade: code, findings, self_fixed: [], ...extra });
    const [row] = buildRows({ record, recordedAt: "", agents: [
      { label: "plan #7", result: PLAN, transcript: t("claude-sonnet-5-5") },
      { label: "code #7", result: CODE, transcript: t("claude-haiku-5-5") },
      { label: "review #7 r1", result: review("C", [finding("F1", "blocking", false), finding("F2", "should-fix", false)], { fork_commit: "f1", fork_fixed: ["F1", "F2"] }), transcript: t("claude-opus-5-5") },
      { label: "opusfix #7", result: { fixed: ["F1", "F2"], commit: "f1" }, transcript: t("claude-opus-5-5") },
      { label: "check #7", result: review("A-", [finding("F1", "blocking", true), finding("F2", "should-fix", false)]), transcript: t("claude-opus-5-5") },
      { label: "fix #7 r1", result: { commit: "c2", addressed: ["F1", "F2"], blocked: "" }, transcript: t("claude-haiku-5-5") },
      { label: "review #7 r2", result: review("B+", [finding("F1", "blocking", true), finding("F2", "should-fix", true)]), transcript: t("claude-opus-5-5") },
    ] });
    const cost = (label: string) => row.agents.find((a) => a.label === label)!.cost!.total;
    expect(row).toMatchObject({ version: 7, forkRun: true, reviewRounds: 2, codeGrade: "C", finalCodeGrade: "B+", converged: true });
    expect(row.fork).toMatchObject({ fixed: 2, codeGrade: "A-", open: 1, loopOpen: 0, readyToShip: true });
    expect(row.fork!.fixCost).toBeCloseTo(cost("opusfix #7"), 8);
    expect(row.fork!.loopCost).toBeCloseTo(cost("fix #7 r1") + cost("review #7 r2"), 8);
    expect(setupKey(row)).toMatch(/Opus-fix fork$/);
    expect(renderReport(summarize([row]), [row])).toContain("code grade after 3.70 · open after 1.0");
  });
});

describe("buildRows solo", () => {
  it("grades a solo branch by its grade agent and leaves the grade out of the cost", () => {
    const base = "39cbc28bdd7fa0e9cbed8003c7f478c1dadfb602";
    const record = { runId: "wf_s", script: SCRIPT_V3.replace("= 3", "= 7"), args: { issues: [7], solo: true, fork: true, base } };
    const [row] = buildRows({ record, recordedAt: "", agents: [
      { label: "solo #7", result: { title: "Seven", already_done: false, branch: "s7", typecheck_passed: true, tests_passed: true, summary: "…" }, transcript: stage("claude-opus-5-5", "medium", 4) },
      { label: "grade #7", result: { issue_resolved: true, ready_to_ship: false, code_grade: "B", findings: [finding("F1", "should-fix", false)] }, transcript: stage("claude-opus-5-5", "high", 9) },
    ] });
    const cost = (label: string) => row.agents.find((a) => a.label === label)!.cost!.total;
    expect(row).toMatchObject({
      solo: true, forkRun: false, base, title: "Seven", branch: "s7",
      planGrade: null, codeGrade: "B", finalCodeGrade: "B", reviewRounds: 0, converged: null, readyToShip: false,
    });
    expect(row.stages.solo).toMatchObject({ testsPassed: true, minutes: 4 });
    expect(row.findings).toHaveLength(1);
    expect(row.cost).toBeCloseTo(cost("solo #7"), 8);
    expect(row.gradeCost).toBeCloseTo(cost("grade #7"), 8);
    expect(setupKey(row)).toBe("v7 · solo opus-5-5/medium · graded by opus-5-5/high · bench 39cbc28b");
    expect(renderReport(summarize([row]), [row])).toContain("the measurement, not in the cost");
  });
});

describe("forkIndex", () => {
  it("cuts at the first entry of the request that made the copy", () => {
    const bash = (requestId: string, command: string) =>
      ({ type: "assistant", requestId, message: { content: [{ type: "tool_use", input: { command } }] } });
    const entries = [
      bash("a", "git worktree list"),
      { type: "assistant", requestId: "b", message: { content: [{ type: "text", text: "now the copy" }] } },
      bash("b", "git worktree add /wt-opusfix -b x-opusfix HEAD"),
      bash("c", "npm ci"),
    ];
    expect(forkIndex(entries)).toBe(1);
    expect(forkIndex(entries.slice(0, 2))).toBe(-1);
  });
});

describe("summarize", () => {
  it("keeps setups apart and averages within one", () => {
    const review = (code: string) => ({
      issue_resolved: true, plan_grade: "A", code_grade: code,
      findings: [
        { severity: "should-fix", origin: "plan", kind: "weak-test", file: "a", summary: "", fixed: true },
        { severity: "nit", origin: "code", kind: "style", file: "b", summary: "", fixed: false },
      ],
    });
    const rows = [
      ...run("wf_1", SCRIPT_V2, review("B")),
      ...run("wf_2", SCRIPT_V2, review("A")),
      ...run("wf_3", SCRIPT_V2, review("C"), "claude-sonnet-5-5"),
    ];
    expect(setupKey(rows[0])).toBe("v2 · plan sonnet-5-5/high · code haiku-5-5/medium · review opus-5-5/high");
    const summaries = summarize(rows, new Map([["b7", "MERGED"]]));
    expect(summaries).toHaveLength(2);
    const haiku = summaries.find((s) => s.setup.includes("code haiku"))!;
    expect(haiku).toMatchObject({ issues: 2, runs: 2, resolved: 2, merged: 2, codeGrade: 3.5, weakTests: 2, fromPlanShare: 0.5 });
    expect(haiku.findingsPerIssue).toEqual({ blocking: 0, shouldFix: 1, nit: 1 });
    expect(haiku.stages.code).toMatchObject({ minutes: 4, requests: 2, contextTokens: 3110 });
    expect(renderReport(summaries, rows)).toContain("plan 4.00 · code at first review 3.50");
  });

  it("leaves issues the planner found already done out of the sums", () => {
    const [row] = run("wf_x", SCRIPT_V2, { plan_grade: "A", code_grade: "A", findings: [] });
    expect(summarize([{ ...row, alreadyDone: true }])).toEqual([]);
  });
});
