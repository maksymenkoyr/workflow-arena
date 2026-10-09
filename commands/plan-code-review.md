---
description: Run GitHub issues through the plan → code → review workflow with correction rounds (a strong model plans and reviews, a cheaper one codes), or rerun the fixed benchmark, and record the results for model comparison
argument-hint: <issue numbers | bench> [solo] [plan=model/effort] [code=model/effort] [review=model/effort] [solo=model/effort] [rounds=N] [fork] [tag=name]
---

Run `$ARGUMENTS` through workflow-arena's workflow,
`.workflow-arena/workflows/plan-code-review.js` (the project's clone of
workflow-arena; its README says how a project sets that up). Its header says what each stage does, how a correction round works, and what
`solo` and a pinned `base` change. Its `DEFAULT_MODELS` and
`DEFAULT_MAX_ROUNDS` apply when nothing is given.

1. **Parse the arguments.**
   - Numbers are issue numbers.
   - `bench` reruns the fixed benchmark instead: take `issues` and `base` from
     `.claude/arena-bench.json` in this project and pass both. Its rows form their
     own series in the report, so setups compare across reruns.
   - `solo` runs one agent per issue with no plan and no review, then a
     `grade` agent whose cost stays out of the total.
   - A `plan=`, `code=`, `review=` or `solo=` override takes `model/effort`,
     such as `code=sonnet/medium`.
   - `rounds=N` caps the correction rounds.
   - `fork` turns on the Opus-fix fork the workflow header describes.
   - `tag=name` goes into the branch names, so a rerun of an issue gets fresh
     branches. Default it to a short tag that isn't in
     `git branch --list 'worktree-issue-*'` yet: `b<N>` for a bench run,
     `r<N>` otherwise.
   - With neither issue numbers nor `bench`, ask which issues to run, and stop.

2. **Check the issues are still open** with
   `gh api 'repos/{owner}/{repo}/issues/<n>' --jq .state` (REST: cloud sessions
   refuse `gh issue view`), and drop any closed ones. Skip this for `bench`:
   its issues may be closed by now, and the run is pinned to a commit from
   before their fixes. Leave
   overlap with `origin/main` and open PRs to the plan stage, which checks for it.

3. **Launch from outside a worktree.** If this session entered one
   (EnterWorktree), leave it with ExitWorktree (keep) first. The workflow
   header says why. Then launch with the Workflow tool, `scriptPath:
   ".workflow-arena/workflows/plan-code-review.js"`, and `args` as real JSON: `{ "issues": [346, 353], "tag": "r3", "maxRounds": 2, "fork": true, "models": { "code": { "model": "sonnet", "effort": "medium" } } }`,
   or for `bench solo`: `{ "issues": [346, 353, 355], "base": "<sha from the bench file>", "tag": "b2", "solo": true }`.
   Leave out what wasn't given. Tell the user the run ID and the setup, then
   wait for the completion notice.

4. **Record the run** right after it completes, before anything else:
   `node .workflow-arena/tools/workflow-stats.mjs record <runId>`. The rows
   go to a local file, synced by nothing (the `tools/workflow-stats.mjs`
   header). In a cloud session, also write
   `node .workflow-arena/tools/workflow-stats.mjs export <runId>` to a file
   the user can open, send it, and tell them to run `import` on it on their
   machine. The session's transcripts it reads are cleaned up with
   old sessions. If a run was ever left unrecorded,
   `node .workflow-arena/tools/workflow-stats.mjs sweep` records every
   finished one still on disk.

5. **Report** for each issue:
   - its branch and worktree
   - the plan grade, and the code grade at the first and the last review (for
     `solo`: the grade agent's code grade and findings)
   - how many review rounds ran, and whether the loop converged or the last
     review had to fix findings itself (`self_fixed`)
   - each first-round finding with its severity, origin (plan or code) and
     outcome
   - any open decision the review raised
   - with `fork`: the copy's branch, what the first review fixed there, and the
     check's grade and open findings next to the loop's

   Then print `node .workflow-arena/tools/workflow-stats.mjs tokens` for where the tokens and the
   estimated cost went per agent, and `node .workflow-arena/tools/workflow-stats.mjs report` to put
   this run next to earlier setups. For `bench`, compare against the other
   setups in the same "bench <sha>" series and show them as one table.

   One run per setup is mostly noise: two runs of the same setup have differed
   as much as two setups have. Don't call one setup better from a single run.
   Suggest a rerun (a fresh `tag`) when a setup's choice would hang on it, and
   only call a gap real when it holds across runs and is larger than the
   grader's own spread.

6. **Don't ship on your own.** Ask which branches to finish with `/ship`. Every
   branch stays local until then. Never offer to ship a `bench` branch: it
   starts from an old commit and exists only to be measured.
