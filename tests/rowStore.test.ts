import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore: plain .mjs module
import { openStore, parsePipeline, pipelineBody, pipelineUrl, saveStatements } from "../tools/rowStore.mjs";

// A fake Turso: runs the pipeline's statements against a Map keyed like the
// real table, so the tests check what reaches the database, not the wire
// format alone.
function fakeTurso() {
  const table = new Map<string, { runId: string; issue: number; row: string }>();
  const calls: any[] = [];
  let down = false;
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    if (down) throw new Error("offline");
    const body = JSON.parse(init.body);
    const results = body.requests.map((r: any) => {
      if (r.type === "close") return { type: "ok", response: { type: "close" } };
      const { sql, args } = r.stmt;
      const v = args.map((a: any) => (a.type === "integer" ? Number(a.value) : a.value));
      let rows: any[] = [];
      if (sql.startsWith("DELETE")) for (const [k, x] of table) if (x.runId === v[0]) table.delete(k);
      if (sql.startsWith("INSERT")) table.set(`${v[0]}#${v[1]}`, { runId: v[0], issue: v[1], row: v[2] });
      if (sql.startsWith("SELECT")) rows = [...table.values()].map((x) => [{ type: "text", value: x.row }]);
      return { type: "ok", response: { type: "execute", result: { cols: [], rows } } };
    });
    return { ok: true, status: 200, json: async () => ({ results }) };
  };
  return { table, calls, fetchImpl, setDown: (d: boolean) => { down = d; } };
}

const row = (runId: string, issue: number, extra = {}) => ({ runId, issue, ...extra });

describe("rowStore", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "arena-")); });

  it("turns a libsql URL into the HTTPS pipeline endpoint", () => {
    expect(pipelineUrl("libsql://runs-me.turso.io/")).toBe("https://runs-me.turso.io/v2/pipeline");
  });

  it("types arguments and ends the pipeline with close", () => {
    const body = pipelineBody([{ sql: "INSERT INTO runs VALUES (?, ?)", args: ["wf_1", 346] }]);
    expect(body.requests[0].stmt.args).toEqual([{ type: "text", value: "wf_1" }, { type: "integer", value: "346" }]);
    expect(body.requests.at(-1)).toEqual({ type: "close" });
  });

  it("throws on a failed statement instead of returning partial rows", () => {
    expect(() => parsePipeline({ results: [{ type: "error", error: { message: "no such table" } }] })).toThrow(/no such table/);
  });

  it("deletes each run once before inserting its rows", () => {
    const sql = saveStatements([row("wf_a", 1), row("wf_a", 2)]).map((s: any) => s.sql.split(" ")[0]);
    expect(sql).toEqual(["CREATE", "DELETE", "INSERT", "INSERT"]);
  });

  it("re-recording a run replaces its rows, including an issue it no longer has", async () => {
    const t = fakeTurso();
    const store = openStore({ url: "libsql://x.turso.io", token: "t", file: join(dir, "f"), pending: join(dir, "p"), fetchImpl: t.fetchImpl });
    await store.save([row("wf_a", 1, { cost: 1 }), row("wf_a", 2), row("wf_b", 7)]);
    await store.save([row("wf_a", 1, { cost: 3 })]);
    const all = await store.all();
    expect(all.map((r: any) => `${r.runId}#${r.issue}`).sort()).toEqual(["wf_a#1", "wf_b#7"]);
    expect(all.find((r: any) => r.runId === "wf_a").cost).toBe(3);
    expect(t.calls[0].init.headers.authorization).toBe("Bearer t");
  });

  it("keeps rows in the pending file while offline, shows them, and sends them next time", async () => {
    const t = fakeTurso();
    const pending = join(dir, "p");
    const store = openStore({ url: "libsql://x.turso.io", token: "t", file: join(dir, "f"), pending, fetchImpl: t.fetchImpl });
    t.setDown(true);
    await store.save([row("wf_off", 5)]);
    expect(t.table.size).toBe(0);
    expect((await store.all()).map((r: any) => r.runId)).toEqual(["wf_off"]);
    t.setDown(false);
    await store.save([row("wf_on", 6)]);
    expect([...t.table.keys()].sort()).toEqual(["wf_off#5", "wf_on#6"]);
    expect(existsSync(pending)).toBe(false);
  });

  it("without a database URL, merges into the local file by run", async () => {
    const file = join(dir, "runs.jsonl");
    writeFileSync(file, JSON.stringify(row("wf_a", 1, { cost: 1 })) + "\n" + JSON.stringify(row("wf_b", 2)) + "\n");
    const store = openStore({ file, pending: join(dir, "p") });
    await store.save([row("wf_a", 1, { cost: 9 })]);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((r) => `${r.runId}:${r.cost ?? "-"}`)).toEqual(["wf_b:-", "wf_a:9"]);
  });

  it("refuses a database URL without a token", () => {
    expect(() => openStore({ url: "libsql://x.turso.io", file: "f", pending: "p" })).toThrow(/TOKEN/);
  });
});
