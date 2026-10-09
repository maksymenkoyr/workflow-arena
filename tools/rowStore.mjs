// Where recorded rows live. With WORKFLOW_ARENA_DB_URL and
// WORKFLOW_ARENA_DB_TOKEN set, that's a Turso (libSQL) database the owner
// keeps private, reached over plain HTTPS, so every machine and every cloud
// session reads and writes the same rows with nothing to clone or sync.
// Without them, it's a local JSONL file.
//
// Turso's HTTP API takes a pipeline of SQL statements in one POST
// (`/v2/pipeline`), with each argument typed. One table, `runs`, holds one
// row per issue per run as JSON, keyed by run and issue. Saving a run
// replaces every row stored for it, as `mergeRows` does for a file: the
// rows of a run are deleted, then inserted again.
//
// When the database can't be reached, `save` keeps the rows in a pending
// file and says so; the next `save` sends them first, and `all` shows them
// meanwhile, so a report never hides a run that was recorded offline.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mergeRows } from "./workflowStatsLib.mjs";

const SCHEMA = "CREATE TABLE IF NOT EXISTS runs (run_id TEXT NOT NULL, issue INTEGER NOT NULL, row TEXT NOT NULL, PRIMARY KEY (run_id, issue))";

/** "libsql://db-org.turso.io" → "https://db-org.turso.io/v2/pipeline" */
export function pipelineUrl(url) {
  return `${url.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "")}/v2/pipeline`;
}

/** @param {string | number} v */
function arg(v) {
  return typeof v === "number" ? { type: "integer", value: String(v) } : { type: "text", value: v };
}

/** @param {{ sql: string, args?: (string | number)[] }[]} statements */
export function pipelineBody(statements) {
  return {
    requests: [
      ...statements.map((s) => ({ type: "execute", stmt: { sql: s.sql, args: (s.args ?? []).map(arg) } })),
      { type: "close" },
    ],
  };
}

/**
 * The rows of each statement's result, as arrays of plain values; throws on
 * the first statement that failed.
 */
export function parsePipeline(json) {
  const out = [];
  for (const r of json?.results ?? []) {
    if (r.type === "error") throw new Error(`turso: ${r.error?.message ?? "statement failed"}`);
    if (r.response?.type !== "execute") continue;
    out.push((r.response.result?.rows ?? []).map((row) => row.map((v) => (v.type === "null" ? null : v.value))));
  }
  return out;
}

/** The statements that replace every stored row of the given rows' runs. */
export function saveStatements(rows) {
  const runs = [...new Set(rows.map((r) => r.runId))];
  return [
    { sql: SCHEMA },
    ...runs.map((id) => ({ sql: "DELETE FROM runs WHERE run_id = ?", args: [id] })),
    ...rows.map((r) => ({ sql: "INSERT OR REPLACE INTO runs (run_id, issue, row) VALUES (?, ?, ?)", args: [r.runId, Number(r.issue), JSON.stringify(r)] })),
  ];
}

function readJsonl(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/**
 * @param {{ url?: string, token?: string, file: string, pending: string, fetchImpl?: typeof fetch }} opts
 * @returns {{ where: string, all(): Promise<any[]>, save(rows: any[]): Promise<void> }}
 */
export function openStore({ url, token, file, pending, fetchImpl = fetch }) {
  if (!url) {
    return {
      where: file,
      async all() { return readJsonl(file); },
      async save(rows) { writeJsonl(file, mergeRows(readJsonl(file), rows)); },
    };
  }
  if (!token) throw new Error("WORKFLOW_ARENA_DB_URL is set but WORKFLOW_ARENA_DB_TOKEN isn't");
  const exec = async (statements) => {
    const res = await fetchImpl(pipelineUrl(url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(pipelineBody(statements)),
    });
    if (!res.ok) throw new Error(`turso: HTTP ${res.status}`);
    return parsePipeline(await res.json());
  };
  return {
    where: url,
    async all() {
      const waiting = readJsonl(pending);
      try {
        const [, rows] = await exec([{ sql: SCHEMA }, { sql: "SELECT row FROM runs ORDER BY rowid" }]);
        return mergeRows(rows.map(([json]) => JSON.parse(json)), waiting);
      } catch (e) {
        console.warn(`warning: couldn't read the database (${e.message}); showing only rows waiting in ${pending}`);
        return waiting;
      }
    },
    async save(rows) {
      const all = mergeRows(readJsonl(pending), rows);
      try {
        await exec(saveStatements(all));
        rmSync(pending, { force: true });
      } catch (e) {
        writeJsonl(pending, all);
        console.warn(`warning: couldn't reach the database (${e.message}); the rows wait in ${pending} and the next record or import sends them`);
      }
    },
  };
}
