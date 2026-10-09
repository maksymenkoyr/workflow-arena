#!/usr/bin/env node
// Collects the results of plan-code-review workflow runs
// (workflows/plan-code-review.js, launched by /plan-code-review) so
// stage models can be compared over many issues: grades, findings, and the
// minutes and tokens each stage used.
//
//   node tools/workflow-stats.mjs record wf_d5233a2c-fd5   # add a finished run
//   node tools/workflow-stats.mjs sweep                   # add every finished run not stored yet
//   node tools/workflow-stats.mjs report                  # per setup
//   node tools/workflow-stats.mjs report --issues         # plus one line per issue
//   node tools/workflow-stats.mjs report --json           # the raw rows
//   node tools/workflow-stats.mjs tokens [runId]           # per agent, latest run by default
//   node tools/workflow-stats.mjs export wf_d5233a2c-fd5   # one run's rows, to carry to another machine
//   node tools/workflow-stats.mjs import rows.jsonl        # add rows another machine exported
//
// `record` finds the run under ~/.claude/projects/*/*/workflows/<runId>.json,
// reads its journal and each agent's transcript next to it, and replaces any
// rows the store already has for that run, so recording twice is safe. Those
// files belong to the Claude Code session and are cleaned up with old
// sessions, so record a run soon after it finishes. `sweep` records every
// completed run of the plan-code-review workflow that the store lacks, from
// any session still on disk: the catch-up for runs nobody recorded.
//
// The store is one JSON row per issue in WORKFLOW_STATS_FILE, or
// ~/.claude/workflow-stats/runs.jsonl, kept outside any project repo on
// purpose: it's the owner's private log, and it outlives worktrees and
// branches. Nothing syncs it. A run recorded on another machine or in a cloud
// session comes over by hand: `export <runId>` there, `import` here. A shared
// database can come later, if the project is ever published.
// `report` asks `gh` which branches have a merged PR, the slowest but most
// honest signal of whether a run's work was any good. Pass --no-gh to skip it.
//
// Row building and the per-setup sums live in workflowStatsLib.mjs.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildRows, forkIndex, mergeRows, renderReport, summarize, transcriptStats } from "./workflowStatsLib.mjs";

const STORE = process.env.WORKFLOW_STATS_FILE ?? join(homedir(), ".claude", "workflow-stats", "runs.jsonl");
const PROJECTS = join(homedir(), ".claude", "projects");

const [cmd, ...rest] = process.argv.slice(2);

function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function readStore() {
  return existsSync(STORE) ? readJsonl(STORE) : [];
}

/** Adds rows to the store, replacing any it has for the same runs. */
function saveRows(added) {
  mkdirSync(dirname(STORE), { recursive: true });
  const rows = mergeRows(readStore(), added);
  writeFileSync(STORE, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/** Every session's workflows/ directory under ~/.claude/projects. */
function workflowDirs() {
  const dirs = [];
  for (const project of readdirSync(PROJECTS)) {
    const pdir = join(PROJECTS, project);
    let sessions;
    try {
      sessions = readdirSync(pdir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const s of sessions) {
      const dir = join(pdir, s.name, "workflows");
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function findRunRecord(runId) {
  for (const dir of workflowDirs()) {
    const path = join(dir, `${runId}.json`);
    if (existsSync(path)) return path;
  }
  return null;
}

async function record(runId) {
  if (!runId) throw new Error("usage: workflow-stats record <runId>");
  const recordPath = findRunRecord(runId);
  if (!recordPath) throw new Error(`no run record for ${runId} under ${PROJECTS}`);
  await recordFrom(runId, recordPath);
}

async function sweep() {
  const stored = new Set(readStore().map((r) => r.runId));
  let found = 0;
  for (const dir of workflowDirs()) {
    for (const name of readdirSync(dir).filter((f) => /^wf_.*\.json$/.test(f))) {
      const runId = name.replace(/\.json$/, "");
      if (stored.has(runId)) continue;
      let meta;
      try {
        meta = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue;
      }
      if (meta.workflowName !== "plan-code-review" || meta.status !== "completed") continue;
      found++;
      await recordFrom(runId, join(dir, name));
    }
  }
  if (!found) console.log(`every completed plan-code-review run on disk is already in ${STORE}`);
}

async function recordFrom(runId, recordPath) {
  const runRecord = JSON.parse(readFileSync(recordPath, "utf8"));
  if (runRecord.status && runRecord.status !== "completed") {
    console.warn(`warning: run ${runId} is ${runRecord.status}; recording what finished`);
  }
  const dir = join(dirname(dirname(recordPath)), "subagents", "workflows", runId);
  const labels = new Map();
  const results = new Map();
  for (const e of readJsonl(join(dir, "journal.jsonl"))) {
    if (e.type === "started") labels.set(e.agentId, e.label);
    if (e.type === "result") results.set(e.agentId, e.result);
  }
  const progress = new Map(
    (runRecord.workflowProgress ?? []).filter((p) => p.type === "workflow_agent").map((p) => [p.agentId, p]),
  );
  const agents = [...labels].flatMap(([agentId, label]) => {
    const tpath = join(dir, `agent-${agentId}.jsonl`);
    const entries = existsSync(tpath) ? readJsonl(tpath) : [];
    const result = results.get(agentId) ?? null;
    // A forked first review also fixed its copy; that half is its own agent.
    const cut = result?.fork_commit && /^review #\d+ r1$/.test(label) ? forkIndex(entries) : -1;
    if (cut < 0) return [{ label, result, transcript: transcriptStats(entries), progress: progress.get(agentId) }];
    return [
      { label, result, transcript: transcriptStats(entries.slice(0, cut)) },
      { label: label.replace(/^review (#\d+) r1$/, "opusfix $1"), result: { fixed: result.fork_fixed ?? [], commit: result.fork_commit }, transcript: transcriptStats(entries.slice(cut)) },
    ];
  });
  const rows = buildRows({ record: runRecord, agents, recordedAt: new Date().toISOString() });
  saveRows(rows);
  console.log(`recorded ${rows.length} issue(s) from ${runId} into ${STORE}`);
  for (const r of rows) {
    console.log(`  #${r.issue} plan ${r.planGrade ?? "-"} code ${r.codeGrade ?? "-"}→${r.finalCodeGrade ?? "-"} · ${r.reviewRounds} review(s) · $${r.cost.toFixed(2)}${r.alreadyDone ? " · already done" : ""}`);
  }
}

// One line per agent of one recorded run (the latest when no ID is given):
// where the tokens went and what they cost.
async function tokens(runId) {
  const all = readStore();
  const id = runId ?? all.at(-1)?.runId;
  const rows = all.filter((r) => r.runId === id);
  if (!rows.length) {
    console.log(runId ? `no recorded run ${runId}` : "no runs recorded yet");
    return;
  }
  const k = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : `${Math.round(x / 1e3)}k`);
  const usd = (x) => (x == null ? "-" : `$${x.toFixed(3)}`);
  console.log(`${id} · cost is an API-list-price estimate; output tokens are a floor`);
  console.log("agent               model/effort         req tools  min    fresh  c.write   c.read  out+   peak    cost  (fresh / write / read / out)");
  let total = 0;
  let graded = 0;
  for (const r of rows) {
    for (const a of r.agents) {
      const t = a.tokens;
      const c = a.cost;
      if (a.stage === "grade") graded += c?.total ?? 0;
      else total += c?.total ?? 0;
      console.log(
        `${a.label.padEnd(19)} ${`${(a.model ?? "?").replace(/^claude-/, "")}/${a.effort ?? "?"}`.padEnd(20)}` +
        ` ${String(a.requests).padStart(3)} ${String(a.toolCalls ?? "-").padStart(5)} ${a.minutes.toFixed(1).padStart(4)}` +
        ` ${k(t.input).padStart(8)} ${k(t.cacheWrite).padStart(8)} ${k(t.cacheRead).padStart(8)} ${k(t.outputSeen).padStart(5)} ${k(a.peakContext).padStart(6)}` +
        ` ${usd(c?.total).padStart(7)}  (${c ? [c.input, c.cacheWrite, c.cacheRead, c.output].map((x) => x.toFixed(3)).join(" / ") : "-"})`,
      );
    }
  }
  console.log(`total ${usd(total)}${graded ? ` (+ ${usd(graded)} of grade agents, the measurement, not counted)` : ""}`);
}

function prStates() {
  try {
    // REST, not `gh pr list`: cloud sessions refuse GraphQL. Pages are asked
    // for by number, since --paginate follows GitHub's numeric-id links, which
    // the cloud proxy refuses too.
    const jq = '.[] | [.head.ref, (if .merged_at then "MERGED" else (.state | ascii_upcase) end)] | @tsv';
    const states = new Map();
    for (let page = 1; ; page++) {
      const out = execFileSync("gh", ["api", `repos/{owner}/{repo}/pulls?state=all&per_page=100&page=${page}`, "--jq", jq], { encoding: "utf8" });
      const lines = out.split("\n").filter(Boolean);
      for (const line of lines) states.set(...line.split("\t"));
      if (lines.length < 100) return states;
    }
  } catch {
    console.warn("warning: listing PRs through gh api failed; merged counts show 0");
    return new Map();
  }
}

async function report(flags) {
  const rows = readStore();
  if (flags.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(`no runs recorded yet in ${STORE}`);
    return;
  }
  const prState = flags.includes("--no-gh") ? new Map() : prStates();
  console.log(renderReport(summarize(rows, prState), rows, { listIssues: flags.includes("--issues"), prState }));
}

async function importRows(path) {
  if (!path) throw new Error("usage: workflow-stats import <rows.jsonl>");
  const rows = readJsonl(path);
  const runs = new Set(rows.map((r) => r.runId));
  saveRows(rows);
  console.log(`imported ${rows.length} row(s) from ${runs.size} run(s) into ${STORE}`);
}

function exportRows(runId) {
  if (!runId) throw new Error("usage: workflow-stats export <runId>");
  const rows = readStore().filter((r) => r.runId === runId);
  if (!rows.length) throw new Error(`no recorded run ${runId} in ${STORE}`);
  process.stdout.write(rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

if (cmd === "record") await record(rest[0]);
else if (cmd === "export") exportRows(rest[0]);
else if (cmd === "import") await importRows(rest[0]);
else if (cmd === "sweep") await sweep();
else if (cmd === "report") await report(rest);
else if (cmd === "tokens") await tokens(rest[0]);
else {
  console.log("usage: workflow-stats record <runId> | sweep | export <runId> | import <rows.jsonl> | report [--issues] [--json] [--no-gh] | tokens [runId]");
  process.exit(cmd ? 1 : 0);
}
