# workflow-arena

Runs GitHub issues through agent workflow setups in Claude Code and records
how each setup did, so setups can be compared on grade and cost. A setup is
the model and effort of each stage: a strong model plans and reviews, a
cheaper one codes, and review findings loop back for correction rounds.
A `solo` setup has one agent do it all.

- `workflows/plan-code-review.js`: the workflow. Its header explains each
  stage, the correction rounds, `solo`, `fork`, and pinned benchmark runs.
- `commands/plan-code-review.md`: what `/plan-code-review` does, step by
  step.
- `tools/workflow-stats.mjs`: records finished runs from Claude Code's
  transcripts and prints the per-setup report. `tools/workflowStatsLib.mjs`
  builds the rows.

Planned next: a blind grader, script-run checks (the real fix's tests,
mutation testing), side-by-side judging and repeat runs. See
[the plan](https://github.com/maksymenkoyr/sine-visuals-lab/blob/main/plans/agent-models-and-cost.md).

## Using it in a project

Claude Code doesn't install plugins in cloud sessions, so a project keeps
its own clone of this repo instead, at `.workflow-arena/`:

1. **Gitignore** `.workflow-arena/`.
2. **Keep the clone current** from the project's SessionStart hook:

   ```sh
   if [ -d .workflow-arena/.git ]; then git -C .workflow-arena pull -q --ff-only 2>/dev/null
   else git clone -q --depth 1 https://github.com/maksymenkoyr/workflow-arena .workflow-arena 2>/dev/null; fi
   ```

3. **Add a stub command** at `.claude/commands/plan-code-review.md` that
   says to follow `.workflow-arena/commands/plan-code-review.md` with
   `$ARGUMENTS`.
4. **Optionally, add a benchmark** at `.claude/arena-bench.json`: a fixed
   list of `issues` and the `base` commit they always run from.

The agents run `npm ci`, `npm run typecheck` and `npm test`, so the project
needs those scripts.

## Where the results go

Results are one row per issue in `~/.claude/workflow-stats/runs.jsonl`, or
in `WORKFLOW_STATS_FILE` if set, outside the project. Nothing syncs that
file. To bring over a run recorded on another machine or in a cloud
session, run `node tools/workflow-stats.mjs export <runId> > run.jsonl`
there, then `node tools/workflow-stats.mjs import run.jsonl` here.

## Licence

AGPL-3.0-or-later. See `LICENSE`.
