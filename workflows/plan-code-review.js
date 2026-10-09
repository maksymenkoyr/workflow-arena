export const meta = {
  name: 'plan-code-review',
  description: 'Per GitHub issue: a strong model plans and reviews, a cheaper one codes; findings loop back for correction rounds',
  whenToUse: 'Run through /plan-code-review. Record every run with workflow-arena's tools/workflow-stats.mjs so the stage models can be compared.',
  phases: [
    { title: 'Plan', detail: 'a detailed plan per issue, no edits' },
    { title: 'Code', detail: 'implements the plan on a fresh branch in a fresh worktree' },
    { title: 'Review', detail: 'typecheck, tests, graded review; only the last review fixes what is left' },
    { title: 'Correct', detail: 'the coder fixes every finding, plan ones by the reviewer\'s amendment, then review again' },
    { title: 'Check', detail: 'with fork: grades the copy the first review fixed itself' },
  ],
}

// Part of workflow-arena. A project runs it from its own clone of this repo
// (`.workflow-arena/`, which its session-start hook keeps current) through
// the Workflow tool's `scriptPath`, so every agent works in that project.
//
// One issue goes through plan → code → review in a pipeline, so issues don't
// wait on each other. A review that leaves blocking or should-fix findings
// starts a correction round: the coder fixes every finding in the same
// worktree, then the reviewer looks again. For findings the plan caused, the
// reviewer writes the corrected instruction itself, as a plan amendment in the
// same review. Until version 4 a separate planner agent wrote it, and that
// agent cost about as much just to start up as the whole fix step (the
// recorder's `tokens` view shows it). The review after the last correction
// round (or after a fix round that made no commit) is the last word: it grades
// the branch as it found it, then fixes what is still open itself and lists
// those ids in `self_fixed`, so every branch ends shippable and the stats show
// what the loop couldn't do. Until version 6 a separate finish agent did that
// fixing, at the price of starting one more reviewer-model agent; with
// `maxRounds: 0` the first review is the last, as in the first trial run.
//
// With `fork: true` the run compares two ways to act on the first review's
// findings, from the same findings. The first review also fixes them itself,
// on a copy of the branch in its own worktree (`<branch>-opusfix`), while the
// correction loop above carries on in the original; one more reviewer-model
// agent, `check`, then grades the copy the way a correction round's review
// would, so both arms end with a grade. The recorder splits the first
// review's tokens where it made the copy, so the copy's fixing shows as its
// own cost, the price of "the reviewer just fixes it".
//
// With `solo: true` the setup has no plan and no review: one agent
// (`models.solo`) reads the issue, implements, tests and commits it alone.
// One reviewer-model `grade` agent then grades the branch without fixing
// anything. The grade is the measurement, not part of the setup, so the
// recorder leaves its cost out of the issue's cost. This answers "would the
// strong model alone be cheaper?" on the same terms as the reviewed runs.
//
// With `base` set to a commit, the run is pinned to it. Every stage branches
// from that commit and diffs against it instead of origin/main, the planner
// skips the "already done" check, and agents read only the issue's title and
// body, since later comments may describe the fix. This keeps a benchmark
// comparable after its issues are fixed on main; /plan-code-review's `bench`
// reads the issues and the commit from the project's .claude/arena-bench.json.
// The agents still load today's CLAUDE.md, so a big change there
// shifts every setup at once: compare bench runs from about the same time.
//
// The stage models come from `args.models` and default to `DEFAULT_MODELS`.
// Different models in different runs are the experiment that
// workflow-arena's tools/workflow-stats.mjs compares. The recorder reads `WORKFLOW_VERSION`
// from this script, so bump it when a prompt or schema changes enough to make
// old runs a different setup. Agent labels ("review #346 r2") are what the
// recorder parses, so keep their shape.
//
// Agents reach GitHub only through `gh api` (REST), never `gh issue view` or
// `gh pr list`: those use GraphQL, which cloud sessions refuse with a 403, and
// every agent would spend calls finding the REST route on its own. No
// --paginate either: it follows numeric-id links the cloud proxy refuses.
//
// Launch it from a session that is NOT inside a worktree (EnterWorktree).
// Only the code stage gets its own worktree; every later stage cds into that
// one, and an agent spawned from a worktree-isolated session inherits the
// sandbox and may not write anywhere else. The second trial run lost every
// fix round that way. A fix round that didn't move the branch now stops the
// loop and the run says so, instead of reviewing the same commit again.
//
// args: an array of issue numbers, or
//   { issues: [346, 353], tag: 'r3', maxRounds: 2, fork: true, models: { code: { model: 'sonnet', effort: 'medium' } } }
//   { issues: [346, 353, 355], base: '39cbc28b…', tag: 'b1', solo: true }
// `tag` goes into branch names, so a rerun of the same issue gets a fresh
// branch instead of colliding with an earlier attempt.

const WORKFLOW_VERSION = 7
const DEFAULT_MAX_ROUNDS = 2

const DEFAULT_MODELS = {
  plan: { model: 'opus', effort: 'medium' },
  code: { model: 'haiku', effort: 'xhigh' },
  review: { model: 'opus', effort: 'high' },
  solo: { model: 'opus', effort: 'medium' },
}

const input = Array.isArray(args) ? { issues: args } : (args || {})
const pick = (stage) => ({ ...DEFAULT_MODELS[stage], ...((input.models || {})[stage] || {}) })
const models = { plan: pick('plan'), code: pick('code'), review: pick('review'), solo: pick('solo') }
const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS
const tag = input.tag || `v${WORKFLOW_VERSION}`
const solo = !!input.solo
const fork = !!input.fork && maxRounds > 0 && !solo
const pinned = !!input.base
const BASE = input.base || 'origin/main'
const ISSUES = (input.issues || []).map(i => (typeof i === 'number' ? { n: i } : i))
if (!ISSUES.length) throw new Error('plan-code-review: pass issue numbers in args')
const ms = (m) => `${m.model}/${m.effort}`
log(`v${WORKFLOW_VERSION} · ` +
  (solo ? `solo ${ms(models.solo)} · graded by ${ms(models.review)}` : `plan ${ms(models.plan)} · code ${ms(models.code)} · review ${ms(models.review)} · up to ${maxRounds} correction round(s)${fork ? ' · Opus-fix fork' : ''}`) +
  `${pinned ? ` · bench at ${BASE.slice(0, 8)}` : ''} · tag ${tag}`)

const GRADE = { type: 'string', enum: ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'] }

const FINDING = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'short stable id, e.g. F1; keep the same id for the same problem across rounds' },
    severity: { type: 'string', enum: ['blocking', 'should-fix', 'nit'] },
    origin: { type: 'string', enum: ['plan', 'code', 'environment'], description: 'plan = the coder followed a wrong or missing instruction; code = the coder went wrong on its own' },
    kind: { type: 'string', enum: ['bug', 'weak-test', 'missing-test', 'docs', 'style', 'dead-code', 'other'] },
    file: { type: 'string' },
    line: { type: 'number' },
    summary: { type: 'string', description: 'what is wrong and what a correct fix looks like' },
    fixed: { type: 'boolean', description: 'true only if this is a finding from an earlier round that is now resolved' },
  },
  required: ['id', 'severity', 'origin', 'kind', 'file', 'summary', 'fixed'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'the issue title' },
    already_done: { type: 'boolean', description: 'true if origin/main or an open PR already covers this issue' },
    overlap_note: { type: 'string' },
    slug: { type: 'string', description: 'two or three lowercase words joined by dashes, for the branch name' },
    plan: { type: 'string', description: 'detailed step-by-step implementation plan in markdown' },
  },
  required: ['title', 'already_done', 'overlap_note', 'slug', 'plan'],
}

const CODE_SCHEMA = {
  type: 'object',
  properties: {
    worktree_path: { type: 'string', description: 'absolute path of the worktree you worked in (output of pwd)' },
    branch: { type: 'string' },
    base: { type: 'string', description: 'the sha the branch started from' },
    commit: { type: 'string', description: 'final commit sha' },
    typecheck_passed: { type: 'boolean' },
    tests_passed: { type: 'boolean' },
    deviations: { type: 'string', description: 'where and why you departed from the plan; empty if none' },
  },
  required: ['worktree_path', 'branch', 'base', 'commit', 'typecheck_passed', 'tests_passed', 'deviations'],
}

// `blocked` lets an agent that couldn't reach the worktree say so and still
// return valid output; without it a blocked agent burns its retries on the
// schema and kills the issue's whole pipeline. Agents have filled it with
// "none" when nothing blocked them, and with ordinary notes (slow tests), and
// each stopped the loop before the last review could fix what was left, so
// `wasBlocked` ignores the "nothing" words and the description says where
// notes go.
const BLOCKED = { type: 'string', description: 'Leave empty unless you could not cd into or write to the worktree at all; then say why. Problems met while doing the work (failing or slow tests, findings left open) go in your other fields, never here.' }
const wasBlocked = (v) => typeof v === 'string' && v.trim() !== '' && !/^(none|n\/?a|no|null|nothing|-)\.?$/i.test(v.trim())
// Keep in step with `wasBlocked` in tools/workflowStatsLib.mjs.

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    issue_resolved: { type: 'boolean' },
    plan_grade: GRADE,
    plan_grade_reason: { type: 'string' },
    code_grade: GRADE,
    code_grade_reason: { type: 'string', description: 'grade of the branch as it stands now' },
    findings: { type: 'array', items: FINDING, description: 'every finding still open, plus earlier-round findings now resolved (fixed: true)' },
    typecheck_passed: { type: 'boolean' },
    tests_passed: { type: 'boolean' },
    ready_to_ship: { type: 'boolean' },
    notes: { type: 'string' },
    plan_amendment: { type: 'string', description: "empty when no open finding has origin 'plan'; otherwise, for each one, the corrected instruction the coder should follow, with code shapes and test inputs where they help" },
    self_fixed: { type: 'array', items: { type: 'string' }, description: 'last round only: ids of the findings you fixed yourself; empty otherwise' },
    final_commit: { type: 'string', description: 'last round only: HEAD sha after your own fixes; empty if you made none' },
    fork_commit: { type: 'string', description: 'only when asked to fix a copy: HEAD sha of the copy after your fixes; empty otherwise' },
    fork_fixed: { type: 'array', items: { type: 'string' }, description: 'only when asked to fix a copy: ids of the findings you fixed there' },
    blocked: BLOCKED,
  },
  required: ['issue_resolved', 'plan_grade', 'plan_grade_reason', 'code_grade', 'code_grade_reason', 'findings', 'typecheck_passed', 'tests_passed', 'ready_to_ship', 'notes', 'plan_amendment', 'self_fixed'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    commit: { type: 'string', description: 'HEAD sha after your commit' },
    addressed: { type: 'array', items: { type: 'string' }, description: 'finding ids you fixed' },
    not_addressed: { type: 'string', description: 'finding ids you could not fix, and why' },
    typecheck_passed: { type: 'boolean' },
    tests_passed: { type: 'boolean' },
    blocked: BLOCKED,
  },
  required: ['commit', 'addressed', 'not_addressed', 'blocked'],
}

const SOLO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'the issue title' },
    already_done: { type: 'boolean', description: 'true if you stopped because origin/main already covers this issue' },
    worktree_path: { type: 'string', description: 'absolute path of the worktree you worked in (output of pwd)' },
    branch: { type: 'string' },
    base: { type: 'string', description: 'the sha the branch started from' },
    commit: { type: 'string', description: 'final commit sha' },
    typecheck_passed: { type: 'boolean' },
    tests_passed: { type: 'boolean' },
    summary: { type: 'string', description: 'what you changed, and any open question for the maintainer' },
  },
  required: ['title', 'already_done', 'worktree_path', 'branch', 'base', 'commit', 'typecheck_passed', 'tests_passed', 'summary'],
}

const GRADE_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(['issue_resolved', 'code_grade', 'code_grade_reason', 'findings', 'typecheck_passed', 'tests_passed', 'ready_to_ship', 'notes', 'blocked']
    .map(k => [k, REVIEW_SCHEMA.properties[k]])),
  required: ['issue_resolved', 'code_grade', 'code_grade_reason', 'findings', 'typecheck_passed', 'tests_passed', 'ready_to_ship', 'notes'],
}

const GIT_RULES = 'Never use git stash (refs/stash is shared with parallel agents), never push, never touch main. '
const INDEPENDENT = `This is an independent attempt: do not look at other worktrees under .claude/worktrees, other local branches for this issue, or earlier attempts at it. Work only from ${BASE} and what you are given here. `
const TRAILER = 'Co-Authored-By: Claude <noreply@anthropic.com>'
const issueApi = (n) => `gh api 'repos/{owner}/{repo}/issues/${n}`
const readIssue = (n) => pinned
  ? `\`${issueApi(n)}' --jq '.title, .body'\`, title and body only, since this run is pinned to commit ${BASE} and later comments may describe a fix`
  : `\`${issueApi(n)}' --jq '.title, .body'\`, then its comments: \`${issueApi(n)}/comments?per_page=100' --jq '.[].body'\``
const whereIs = (branch, path) => `The work is on branch ${branch} in the worktree ${path}: cd there and run every command there. If you cannot cd there or write there, stop at once and say why in \`blocked\`; never do the work anywhere else. ${GIT_RULES}`
const open = (findings) => findings.filter(f => !f.fixed && f.severity !== 'nit')
// Agents report short or full shas; a prefix only counts at abbreviation length.
const sameSha = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a))))
const listFindings = (fs) => fs.map(f => `- [${f.id}] ${f.severity}, ${f.origin}, ${f.kind}: ${f.file}${f.line ? `:${f.line}` : ''}: ${f.summary}`).join('\n')

if (solo) {
  const soloResults = await pipeline(
    ISSUES,
    (issue) => agent(
      `Resolve GitHub issue #${issue.n} in this repo on your own: there is no plan before you and no review after you. You are in a fresh git worktree. ${GIT_RULES}${INDEPENDENT}\n` +
      `1. \`pwd\`; remember it. \`git fetch origin\`. Read the issue: ${readIssue(issue.n)}.\n` +
      (pinned
        ? `2. Skip any check of whether the issue is already done; set already_done false.\n`
        : `2. Grep origin/main (\`git grep <term> origin/main\`) to see whether it is already done. If it is, set already_done true, leave the other fields empty, and stop.\n`) +
      `3. Pick a slug of two or three lowercase words joined by dashes, then \`git checkout -b worktree-issue-${issue.n}-${tag}-<slug> ${BASE}\`. \`git status --porcelain\` must print nothing and \`git rev-parse HEAD\` must equal \`git rev-parse ${BASE}\`; report that sha as base.\n` +
      `4. If node_modules exists and is a symlink, remove the link. Run \`npm ci\`. The worktree must have its own install.\n` +
      `5. Read the code involved and the file headers CLAUDE.md's table points to for this area, then implement the issue.\n` +
      `6. Run \`npm run typecheck\` and \`npm test\` and fix failures you caused. For each new test, break the code it guards for a moment and check that the test fails, then restore.\n` +
      `7. Commit with a plain-words message ending with a blank line and:\n${TRAILER}`,
      { label: `solo #${issue.n}`, phase: 'Code', ...models.solo, isolation: 'worktree', schema: SOLO_SCHEMA },
    ),
    async (built, issue) => {
      if (!built || built.already_done) { log(`#${issue.n}: skipped (${built ? 'already done' : 'no result'})`); return null }
      const grade = await agent(
        `Grade the implementation of GitHub issue #${issue.n} ("${built.title}"). ${whereIs(built.branch, built.worktree_path)}\n` +
        `One agent resolved it alone, with no plan and no review, in an experiment that compares setups across runs. You are the measurement: grade it as honestly as a correction round's review would, and do NOT fix anything.\n` +
        `1. Read the issue (${readIssue(issue.n)}) and the diff \`git diff ${BASE}...HEAD\`.\n` +
        `2. Run \`npm run typecheck\` and \`npm test\`.\n` +
        `3. Review for correctness (does it resolve the issue, edge cases, regressions), test strength (break the guarded code: does each new test fail?), code quality (matches the surrounding idiom and comment density, no dead code) and the CLAUDE.md rules for comments.\n` +
        `4. Give every finding origin 'code' and write each summary so a coder could fix it without asking.`,
        { label: `grade #${issue.n}`, phase: 'Review', ...models.review, schema: GRADE_SCHEMA },
      )
      return { issue: issue.n, title: built.title, branch: built.branch, worktree: built.worktree_path, base: built.base, summary: built.summary, review: grade }
    },
  )
  return { version: WORKFLOW_VERSION, models: { solo: models.solo, review: models.review }, solo, base: pinned ? BASE : null, tag, results: soloResults.filter(Boolean) }
}

const results = await pipeline(
  ISSUES,
  (issue) => agent(
    `You are planning GitHub issue #${issue.n} in this repo. Do NOT edit any files. ${INDEPENDENT}\n` +
    `1. Read the issue: ${readIssue(issue.n)}.\n` +
    (pinned
      ? `2. \`git fetch origin\`. This run is pinned to commit ${BASE}: skip the already-done check, set already_done false, and plan against that commit even where origin/main has moved on.\n`
      : `2. \`git fetch origin\`, then grep origin/main (\`git grep <term> origin/main\`) to see whether it is already done, and skim the open PR titles (\`gh api 'repos/{owner}/{repo}/pulls?state=open&per_page=100' --jq '.[].title'\`) for overlap.\n`) +
    `3. Read the code involved on ${BASE} (\`git show ${BASE}:<path>\`, since the checkout may be behind) and the file headers CLAUDE.md's table points to for this area.\n` +
    `4. Write a DETAILED plan a smaller model can follow mechanically: exact files, functions, the code shape of each change (snippets welcome), the header comments to update (CLAUDE.md: explain code at the top of its file; don't copy numbers from code into comments), and the verification commands. Call out pitfalls.\n` +
    `5. For every test you ask for, give inputs whose expected value is NOT trivial (not 0, not an empty result, not the test's own counters), and name the break in the code that must make that test fail. A test that still passes with the change reverted is worthless.\n` +
    `6. Mark anything you state as fact about the code that you did not read yourself as UNVERIFIED. The coder will trust everything else.`,
    { label: `plan #${issue.n}`, phase: 'Plan', ...models.plan, schema: PLAN_SCHEMA },
  ),

  (plan, issue) => {
    if (!plan || plan.already_done) { log(`#${issue.n}: skipped (${plan ? plan.overlap_note : 'no plan'})`); return null }
    const branch = `worktree-issue-${issue.n}-${tag}-${plan.slug}`.replace(/[^A-Za-z0-9._/-]/g, '-')
    return agent(
      `Implement GitHub issue #${issue.n} ("${plan.title}") by following this plan. You are in a fresh git worktree. ${GIT_RULES}${INDEPENDENT}\n` +
      `Setup, and check each step before going on:\n` +
      `1. \`pwd\`; remember it. \`git fetch origin\`.\n` +
      `2. \`git checkout -b ${branch} ${BASE}\`. Then \`git status --porcelain\` must print nothing and \`git rev-parse HEAD\` must equal \`git rev-parse ${BASE}\`; report that sha as base.\n` +
      `3. If node_modules exists and is a symlink, remove the link. Run \`npm ci\`. The worktree must have its own install.\n` +
      `Then implement, run \`npm run typecheck\` and \`npm test\` (fix failures you caused). For each new test, break the code it guards for a moment and check that the test fails, then restore. Commit with a plain-words message ending with a blank line and:\n${TRAILER}\n\n` +
      `=== PLAN ===\n${plan.plan}`,
      { label: `code #${issue.n}`, phase: 'Code', ...models.code, isolation: 'worktree', schema: CODE_SCHEMA },
    ).then(code => (code ? { plan, code } : null))
  },

  async (prev, issue) => {
    if (!prev) return null
    const { plan, code } = prev
    const where = whereIs(code.branch, code.worktree_path)
    const forkAt = { branch: `${code.branch}-opusfix`, path: `${code.worktree_path}-opusfix` }
    let check = null
    let forked = null
    const reviewPrompt = ({ round, mode, where, history, amendments, forkTo }) =>
      `Review and test the implementation of GitHub issue #${issue.n} ("${plan.title}"). ${where}\n` +
      `This is review round ${round}. The plan and the code came from different models in an experiment that gets compared across runs, so grade each one honestly and on its own. ` +
      (mode === 'last'
        ? `This is the LAST round: no coder comes after you. Grade the plan and the code as you found them, before any fix of yours, then do step 7.\n`
        : mode === 'check'
          ? `The reviewer of round 1 fixed its own findings on this branch. Do NOT fix anything yourself: grade the branch as it stands, and grade the plan as the round-1 reviewer would have.\n`
          : `Do NOT fix anything yourself in this worktree: your findings go back to the coder.\n`) +
      `1. Read the issue (${readIssue(issue.n)}) and the diff \`git diff ${BASE}...HEAD\`.\n` +
      `2. Run \`npm run typecheck\` and \`npm test\`.\n` +
      `3. Review for correctness (does it resolve the issue, edge cases, regressions), test strength (break the guarded code: does each new test fail?), code quality (matches the surrounding idiom and comment density, no dead code) and the CLAUDE.md rules for comments.\n` +
      `4. Give each finding an origin: 'plan' when the coder faithfully followed a wrong or missing instruction, 'code' when the coder went wrong on its own. Write each summary so the coder can fix it without asking.\n` +
      (mode === 'loop'
        ? `5. If any open finding has origin 'plan', write \`plan_amendment\`: for each one, the corrected instruction that overrides the plan, read against ${BASE} (\`git show ${BASE}:<path>\`) where it matters. Otherwise leave it empty.\n`
        : `5. Leave \`plan_amendment\` empty.\n`) +
      (history.length ? `6. Earlier rounds found these. Re-check each by id: list it with fixed: true if resolved, or again with fixed: false (and a sharper summary) if not. Add new findings with new ids.\n${listFindings(history)}\n` : '') +
      (mode === 'last'
        ? `7. Fix every open finding that isn't a nit yourself (a nit too when it takes a line). Run \`npm run typecheck\` and \`npm test\`, break each test you touched for a moment to check it fails, and commit with a plain-words message ending with a blank line and:\n${TRAILER}\nReport those findings with fixed: true, their ids in \`self_fixed\`, your commit in \`final_commit\`, and \`ready_to_ship\`, typecheck and tests as they stand after your fixes.\n`
        : `Leave \`self_fixed\` empty.\n`) +
      (forkTo
        ? `8. Experiment fork, after steps 1-5 are settled: if any finding above a nit is open, fix those yourself on a COPY of the branch, so the coder's round still runs on the original. Never change ${code.worktree_path}; your findings, grades, typecheck and tests describe the original as you found it. Run \`git worktree add ${forkTo.path} -b ${forkTo.branch} HEAD\` from the original worktree, cd to ${forkTo.path}, run \`npm ci\`, then fix every open finding that isn't a nit (the plan ones by your amendment). Run \`npm run typecheck\` and \`npm test\` there, break each test you touched for a moment to check it fails, and commit with a plain-words message ending with a blank line and:\n${TRAILER}\nReport the copy's HEAD in \`fork_commit\` and the ids you fixed there in \`fork_fixed\`. With nothing above a nit open, skip this step and leave both empty.\n`
        : '') +
      `\n=== PLAN ===\n${plan.plan}${amendments ? `\n\n=== PLAN AMENDMENTS ===\n${amendments}` : ''}`
    let amendments = ''
    let history = []
    let review = null
    let head = code.commit
    let stalled = ''
    for (let round = 1; ; round++) {
      const last = round > maxRounds || !!stalled
      review = await agent(reviewPrompt({ round, mode: last ? 'last' : 'loop', where, history, amendments, forkTo: fork && round === 1 && !last ? forkAt : null }),
        { label: `review #${issue.n} r${round}`, phase: 'Review', ...models.review, schema: REVIEW_SCHEMA },
      )
      if (!review) return null
      if (wasBlocked(review.blocked)) { stalled = `review round ${round} was blocked: ${review.blocked}`; log(`#${issue.n}: STALLED, ${stalled}`); break }
      history = review.findings
      if (round === 1 && fork && review.fork_commit && !sameSha(review.fork_commit, head)) {
        forked = { branch: forkAt.branch, worktree: forkAt.path, commit: review.fork_commit, fixed: review.fork_fixed || [] }
        log(`#${issue.n}: first review fixed ${forked.fixed.length} finding(s) on ${forked.branch}; checking it while the loop goes on`)
        const forkAmendments = review.plan_amendment ? `Round 1:\n${review.plan_amendment}` : ''
        check = agent(reviewPrompt({ round: 2, mode: 'check', where: whereIs(forkAt.branch, forkAt.path), history: review.findings, amendments: forkAmendments }),
          { label: `check #${issue.n}`, phase: 'Check', ...models.review, schema: REVIEW_SCHEMA })
      }
      const todo = open(review.findings)
      const selfFixed = (review.self_fixed || []).length
      if (!todo.length) { log(`#${issue.n}: review round ${round} ${selfFixed ? `closed ${selfFixed} finding(s) itself` : 'passed'}`); break }
      if (last) { log(`#${issue.n}: last review left ${todo.length} finding(s) open`); break }
      log(`#${issue.n}: round ${round} left ${todo.length} finding(s); correcting`)

      const planFindings = todo.filter(f => f.origin === 'plan')
      if (planFindings.length && review.plan_amendment) {
        amendments += `${amendments ? '\n\n' : ''}Round ${round}:\n${review.plan_amendment}`
      }

      const fix = await agent(
        `Fix review findings on GitHub issue #${issue.n} ("${plan.title}"). ${where}\n` +
        `Fix every finding below. ${planFindings.length ? 'The ones marked plan follow the plan amendment, which overrides the plan. ' : ''}Then run \`npm run typecheck\` and \`npm test\`, break each test you touched for a moment to check it fails, and commit with a plain-words message ending with a blank line and:\n${TRAILER}\n\n` +
        `=== FINDINGS (round ${round}) ===\n${listFindings(todo)}` +
        (amendments ? `\n\n=== PLAN AMENDMENTS ===\n${amendments}` : '') + `\n\n=== ORIGINAL PLAN ===\n${plan.plan}`,
        { label: `fix #${issue.n} r${round}`, phase: 'Correct', ...models.code, schema: FIX_SCHEMA },
      )
      // A fix round that didn't move the branch hands the same commit to one
      // last review, which fixes it itself; a blocked one stops here, since the
      // reviewer would be blocked the same way.
      if (wasBlocked(fix?.blocked)) { stalled = `fix round ${round} was blocked: ${fix.blocked}`; log(`#${issue.n}: STALLED, ${stalled}`); break }
      if (!fix) stalled = `fix round ${round} returned nothing`
      else if (sameSha(fix.commit, head)) stalled = `fix round ${round} made no commit`
      if (stalled) log(`#${issue.n}: STALLED, ${stalled}; the last review fixes it`)
      else head = fix.commit
    }

    if (forked) forked.check = await check
    return { issue: issue.n, title: plan.title, branch: code.branch, worktree: code.worktree_path, base: code.base, stalled, review, fork: forked }
  },
)

return { version: WORKFLOW_VERSION, models: { plan: models.plan, code: models.code, review: models.review }, maxRounds, fork, base: pinned ? BASE : null, tag, results: results.filter(Boolean) }
