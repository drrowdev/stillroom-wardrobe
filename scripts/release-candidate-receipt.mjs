#!/usr/bin/env node
// R1 release-candidate CI receipt (plan R-6 rev3). Read-only: it runs `gh api` GETs and `git` reads, writes nothing to
// GitHub or to disk, and prints a plain-text receipt. It must run from a clean checkout of the candidate C, so the code
// and the workflow definitions it checks are C's own.
//
//   node scripts/release-candidate-receipt.mjs --sha <C> --ci-run <id> --apple-run <id> [--disclosure "<text>"]
//
// Exit codes: 0 = R1-CI PASS, 1 = R1-CI FAIL, 2 = R1-CI BLOCKED (including usage errors).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'drrowdev/stillroom-wardrobe';
export const WORKFLOWS = {
  ci: { file: 'ci.yml', path: '.github/workflows/ci.yml' },
  apple: { file: 'apple-jpeg-probe.yml', path: '.github/workflows/apple-jpeg-probe.yml' },
};
// Pinned job inventories, in workflow-file order. A workflow edit that changes these must update the verifier too.
export const CI_JOBS = ['Changed files', 'Documentation checks', 'App static checks', 'App browser contracts (1/3)', 'App browser contracts (2/3)',
  'App browser contracts (3/3)', 'App and browser contracts', 'PWA production contracts', 'WebKit photo contracts', 'Real local Supabase',
  'Account deletion rehearsal', 'Performance budgets'];
export const APPLE_JOBS = ['Generated JPEG on native Apple WebKit'];
export const EXPECTED_SKIPPED = { ci: ['Documentation checks'], apple: [] };
export const PINNED = { ci: CI_JOBS, apple: APPLE_JOBS };

const SHA = /^[0-9a-f]{40}$/;
const STATUSES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending']);
const CONCLUSIONS = new Set([null, 'success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale']);
const EVENTS = new Set(['push', 'workflow_dispatch']);
const PER_PAGE = 100;
const MAX_PAGES = 100;
export const A11Y_LINE = 'A11Y test:a11y is the `--grep accessibility` subset of the browser specs run by App browser contracts (1/3)-(3/3) '
  + 'and WebKit photo contracts; it has no separate job.';
export const R1_REMINDER = 'NOTE R1 also needs the Pages deploy of exactly C, its read-back D row, the Edge-source comparison and owner approval.';

export class Blocked extends Error {}

/** Parses job display names from a workflow file, expanding `${{ matrix.<key> }}` from an inline `<key>: [a, b]` list. */
export function jobNames(text) {
  const normalised = text.replaceAll('\r\n', '\n');
  const start = normalised.indexOf('\njobs:\n');
  if (start === -1) throw new Error('no jobs block');
  const blocks = normalised.slice(start + '\njobs:\n'.length).split(/\n(?= {2}[A-Za-z0-9_-]+:\n)/);
  const names = [];
  for (const block of blocks) {
    if (!/^ {2}[A-Za-z0-9_-]+:\n/.test(block)) throw new Error('unparsed job block');
    const name = /\n {4}name: (.+)\n/.exec(`${block}\n`)?.[1]?.trim();
    if (!name) throw new Error('job without a name');
    const placeholder = /\$\{\{ matrix\.([A-Za-z0-9_]+) \}\}/.exec(name);
    if (!placeholder) { names.push(name); continue; }
    const values = new RegExp(`\\n {8}${placeholder[1]}: \\[([^\\]]+)\\]\\n`).exec(block)?.[1];
    if (!values) throw new Error(`matrix ${placeholder[1]} not found`);
    for (const value of values.split(',').map((part) => part.trim())) names.push(name.replace(placeholder[0], value));
  }
  return names;
}

/** Reads every page of a list endpoint. `get(page)` returns `{ status, body }`. Anything incomplete is Blocked. */
export function paginate(get, key, perPage = PER_PAGE) {
  const items = [];
  let total;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = get(page);
    if (!response || !(response.status >= 200 && response.status < 300)) throw new Blocked(`incomplete response: HTTP ${response?.status ?? 'none'} on page ${page}`);
    const body = response.body;
    if (!body || !Number.isSafeInteger(body.total_count) || !Array.isArray(body[key])) throw new Blocked(`incomplete response: malformed page ${page}`);
    if (total === undefined) total = body.total_count;
    else if (body.total_count !== total) throw new Blocked(`incomplete response: total_count changed on page ${page}`);
    if (items.length === total) {
      if (body[key].length !== 0) throw new Blocked(`incomplete response: non-empty page ${page} beyond total_count`);
      return items;
    }
    items.push(...body[key]);
    if (items.length > total) throw new Blocked(`incomplete response: more than total_count on page ${page}`);
    if (items.length < total && body[key].length < perPage) throw new Blocked(`incomplete response: short page ${page} before total_count`);
  }
  throw new Blocked('incomplete response: too many pages');
}

const runSummary = (run) => ({ head_sha: run?.head_sha, run_attempt: run?.run_attempt, status: run?.status, conclusion: run?.conclusion,
  updated_at: run?.updated_at });
const fingerprint = (run) => ({ id: run?.id, run_attempt: run?.run_attempt, status: run?.status, conclusion: run?.conclusion, updated_at: run?.updated_at });

/**
 * Binds the executing verifier to C. `git(args, raw)` must run in the repository that contains `scriptPath`; with `raw`
 * it returns a Buffer. Returns a refusal reason, or null when HEAD is C, the checkout is clean (including untracked files),
 * and the script is tracked and byte-equal to C's copy.
 */
export function checkBinding({ sha, git, scriptPath, readScript }) {
  try {
    const top = git(['rev-parse', '--show-toplevel']).trim();
    const relative = path.relative(path.resolve(top), path.resolve(scriptPath));
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return 'the verifier is outside the checkout';
    const tracked = relative.split(path.sep).join('/');
    if (git(['rev-parse', 'HEAD']).trim() !== sha) return 'HEAD is not the candidate';
    if (git(['status', '--porcelain', '--untracked-files=all']).trim() !== '') return 'not clean';
    try { git(['ls-files', '--error-unmatch', '--', tracked]); } catch { return 'the verifier is not tracked'; }
    let blob;
    try { blob = git(['show', `${sha}:${tracked}`], true); } catch { return 'the verifier is not in C'; }
    if (!Buffer.from(blob).equals(Buffer.from(readScript()))) return 'the verifier differs from C';
    return null;
  } catch {
    return 'cannot read the verifier\'s git checkout';
  }
}

/** Collects everything the verdict needs. `api(path)` returns `{ status, body }`; `git(args)` returns stdout. */
export function gather({ sha, ciRun, appleRun, disclosure }, { api, git, scriptPath, readScript, now = () => new Date().toISOString() }) {
  const snapshot = { repository: REPOSITORY, sha, disclosure, verdictRunIds: { ci: ciRun, apple: appleRun } };
  snapshot.checkout = { refusal: checkBinding({ sha, git, scriptPath, readScript }) };
  if (snapshot.checkout.refusal !== null) return snapshot;
  const one = (resource) => {
    const response = api(resource);
    if (!response || !(response.status >= 200 && response.status < 300) || !response.body) throw new Blocked(`incomplete response: HTTP ${response?.status ?? 'none'} for ${resource.split('?')[0]}`);
    return response.body;
  };
  const readMain = () => one(`repos/${REPOSITORY}/git/ref/heads/main`)?.object?.sha;
  const listRuns = (key) => paginate((page) => api(`repos/${REPOSITORY}/actions/workflows/${WORKFLOWS[key].file}/runs?head_sha=${sha}&per_page=${PER_PAGE}&page=${page}`), 'workflow_runs');

  snapshot.definitions = {};
  snapshot.workflows = {};
  snapshot.verdictRuns = {};
  snapshot.history = {};
  snapshot.firstRead = now();
  snapshot.mainHead = readMain();
  for (const key of Object.keys(WORKFLOWS)) {
    snapshot.definitions[key] = git(['show', `${sha}:${WORKFLOWS[key].path}`]);
    const workflow = one(`repos/${REPOSITORY}/actions/workflows/${WORKFLOWS[key].file}`);
    snapshot.workflows[key] = { id: workflow.id, path: workflow.path };
    snapshot.verdictRuns[key] = one(`repos/${REPOSITORY}/actions/runs/${snapshot.verdictRunIds[key]}`);
    snapshot.history[key] = listRuns(key).map((run) => {
      const attempts = [];
      const count = Number.isSafeInteger(run?.run_attempt) && run.run_attempt >= 1 ? run.run_attempt : 0;
      if (count === 0) throw new Blocked(`incomplete response: run ${run?.id} has no attempt count`);
      for (let attempt = 1; attempt <= count; attempt += 1) {
        const attemptRun = one(`repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${attempt}`);
        const jobs = paginate((page) => api(`repos/${REPOSITORY}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=${PER_PAGE}&page=${page}`), 'jobs');
        attempts.push({ attempt, run: attemptRun, jobs });
      }
      return { run, attempts };
    });
  }
  // Re-read just before the verdict: both verdict runs, both histories (id, attempt, state, updated_at) and, last of all,
  // main must be unchanged.
  snapshot.reread = { at: now(), verdictRuns: {}, history: {} };
  for (const key of Object.keys(WORKFLOWS)) {
    snapshot.reread.verdictRuns[key] = runSummary(one(`repos/${REPOSITORY}/actions/runs/${snapshot.verdictRunIds[key]}`));
    snapshot.reread.history[key] = listRuns(key).map(fingerprint);
  }
  snapshot.reread.mainHead = readMain();
  return snapshot;
}

function validateJob(job, run, attempt) {
  if (!job || typeof job !== 'object') return 'not an object';
  if (!Number.isSafeInteger(job.id)) return 'missing id';
  if (typeof job.name !== 'string' || job.name === '') return `job ${job.id}: missing name`;
  if (typeof job.head_sha !== 'string' || !SHA.test(job.head_sha)) return `job ${job.id}: bad head_sha`;
  if (job.run_id !== run.id) return `job ${job.id}: run_id mismatch`;
  if (job.run_attempt !== attempt) return `job ${job.id}: attempt mismatch`;
  if (!STATUSES.has(job.status)) return `job ${job.id}: unknown status`;
  if (!CONCLUSIONS.has(job.conclusion)) return `job ${job.id}: unknown conclusion`;
  return null;
}

/** Pure verdict over a gathered snapshot. Returns `{ verdict, reasons, lines }`. */
export function evaluate(snapshot) {
  const fail = [];
  const blocked = [];
  const lines = [];
  const { sha } = snapshot;
  const result = (verdict, reasons) => {
    const head = verdict === 'PASS' ? `R1-CI PASS ${sha}` : `R1-CI ${verdict} ${reasons.join('; ')}`;
    return { verdict, reasons, lines: [...lines, R1_REMINDER, head] };
  };
  if (typeof sha !== 'string' || !SHA.test(sha)) return result('BLOCKED', ['usage: --sha must be a full 40-character lowercase SHA']);
  lines.push(`REPOSITORY ${snapshot.repository}`, `CANDIDATE ${sha}`);
  if (!snapshot.checkout || snapshot.checkout.refusal !== null) return result('BLOCKED', [`checkout: ${snapshot.checkout?.refusal ?? 'not checked'}`]);

  lines.push(`READ ${snapshot.firstRead} and ${snapshot.reread?.at}`, `MAIN ${snapshot.mainHead}`);
  if (snapshot.mainHead !== sha) fail.push('main is not the candidate');

  const disclosureNeeded = [];
  for (const key of Object.keys(WORKFLOWS)) {
    const label = key === 'ci' ? 'CI' : 'APPLE';
    let names;
    try { names = jobNames(snapshot.definitions?.[key] ?? ''); } catch (error) { fail.push(`${label} definition at C unreadable: ${error.message}`); continue; }
    if (JSON.stringify(names) !== JSON.stringify(PINNED[key])) fail.push(`${label} definition at C differs from the pinned inventory (stale definitions)`);

    const workflow = snapshot.workflows?.[key];
    if (!workflow || workflow.path !== WORKFLOWS[key].path || !Number.isSafeInteger(workflow.id)) fail.push(`${label} workflow record malformed`);
    const verdict = snapshot.verdictRuns?.[key];
    const id = snapshot.verdictRunIds?.[key];
    if (!verdict || verdict.id !== id) { fail.push(`${label} run ${id} not found`); continue; }
    if (verdict.path !== WORKFLOWS[key].path) fail.push(`${label} run ${id}: wrong workflow path`);
    if (verdict.workflow_id !== workflow?.id) fail.push(`${label} run ${id}: wrong workflow_id`);
    if (verdict.head_sha !== sha) fail.push(`${label} run ${id}: head_sha is not the candidate`);
    if (verdict.head_branch !== 'main') fail.push(`${label} run ${id}: not on main`);
    if (verdict.head_repository?.full_name !== snapshot.repository) fail.push(`${label} run ${id}: not from this repository`);
    if (!EVENTS.has(verdict.event)) fail.push(`${label} run ${id}: event ${verdict.event} is not push or workflow_dispatch`);
    lines.push(`RUN ${label} ${id} ${verdict.event} attempt ${verdict.run_attempt} ${verdict.status}/${verdict.conclusion} ${verdict.html_url ?? ''}`.trimEnd());
    if (verdict.status !== 'completed') blocked.push(`${label} run ${id} still in progress`);
    else if (verdict.conclusion !== 'success') fail.push(`${label} run ${id} concluded ${verdict.conclusion}`);

    // History: every run and attempt for C in this workflow, all events.
    const history = snapshot.history?.[key] ?? [];
    const ids = new Set();
    for (const entry of history) {
      const run = entry?.run;
      if (!run || !Number.isSafeInteger(run.id)) { fail.push(`${label} history: malformed run record`); continue; }
      if (ids.has(run.id)) fail.push(`${label} history: duplicate run ${run.id}`);
      ids.add(run.id);
      if (run.head_sha !== sha) fail.push(`${label} history: run ${run.id} has a mixed SHA`);
      if (run.workflow_id !== workflow?.id || run.path !== WORKFLOWS[key].path) fail.push(`${label} history: run ${run.id} is from another workflow`);
      if ((entry.attempts?.length ?? 0) !== run.run_attempt) fail.push(`${label} history: run ${run.id} attempts incomplete`);
      if (run.status !== 'completed') blocked.push(`${label} run ${run.id} still in progress`);
      if (run.id > id) fail.push(`${label} run ${id} superseded by later run ${run.id}`);
      if (run.id === id && JSON.stringify(fingerprint(run)) !== JSON.stringify(fingerprint(verdict))) fail.push(`${label} run ${id} changed during verification`);
      for (const { attempt, run: attemptRun, jobs } of entry.attempts ?? []) {
        const final = run.id === id && attempt === run.run_attempt;
        lines.push(`HISTORY ${label} run ${run.id} ${run.event} attempt ${attempt} ${attemptRun?.status}/${attemptRun?.conclusion}${final ? ' (verdict)' : ''}`);
        // Each attempt must carry its run's full identity; the latest attempt must also carry the run's state.
        const identity = ['id', 'head_sha', 'workflow_id', 'path', 'event', 'head_branch'];
        if (!attemptRun || attemptRun.run_attempt !== attempt || identity.some((field) => attemptRun[field] !== run[field])
          || JSON.stringify(attemptRun.head_repository?.full_name) !== JSON.stringify(run.head_repository?.full_name)
          || !STATUSES.has(attemptRun.status) || !CONCLUSIONS.has(attemptRun.conclusion)) {
          fail.push(`${label} run ${run.id} attempt ${attempt}: attempt record does not match its run`);
        } else if (attempt === run.run_attempt && (attemptRun.status !== run.status || attemptRun.conclusion !== run.conclusion)) {
          fail.push(`${label} run ${run.id} attempt ${attempt}: attempt state does not match its run`);
        } else if (attemptRun.status !== 'completed') {
          blocked.push(`${label} run ${run.id} attempt ${attempt} still in progress`);
        }
        if (final && attemptRun?.status === 'completed' && attemptRun?.conclusion !== 'success') fail.push(`${label} run ${id} final attempt is ${attemptRun?.status}/${attemptRun?.conclusion}`);
        const jobIds = new Set();
        const required = new Map();
        for (const job of jobs ?? []) {
          const problem = validateJob(job, run, attempt);
          if (problem) { fail.push(`${label} run ${run.id} attempt ${attempt}: malformed job (${problem})`); continue; }
          if (jobIds.has(job.id)) fail.push(`${label} run ${run.id} attempt ${attempt}: duplicate job id ${job.id}`);
          jobIds.add(job.id);
          if (PINNED[key].includes(job.name)) {
            if (required.has(job.name)) fail.push(`${label} run ${run.id} attempt ${attempt}: duplicate job ${job.name}`);
            required.set(job.name, job);
          }
          if (job.head_sha !== sha) fail.push(`${label} run ${run.id} attempt ${attempt}: mixed SHA in job ${job.name}`);
          const expectedSkip = EXPECTED_SKIPPED[key].includes(job.name);
          if (!final && job.conclusion !== 'success' && !(expectedSkip && job.conclusion === 'skipped')) {
            lines.push(`HISTORY-JOB ${label} run ${run.id} attempt ${attempt} ${job.name} ${job.status}/${job.conclusion}`);
          }
        }
        if (final) {
          for (const name of PINNED[key]) {
            const job = required.get(name);
            if (!job) { fail.push(`${label}: required job missing: ${name}`); continue; }
            lines.push(`JOB ${name} ${job.conclusion} ${job.head_sha.slice(0, 8)}`);
            const want = EXPECTED_SKIPPED[key].includes(name) ? 'skipped' : 'success';
            if (job.status !== 'completed' || job.conclusion !== want) fail.push(`${label}: ${name} is ${job.status}/${job.conclusion}, expected ${want}`);
          }
          for (const job of jobs ?? []) if (job && typeof job.name === 'string' && !PINNED[key].includes(job.name)) fail.push(`${label}: unexpected job ${job.name}`);
        } else {
          const replaced = run.id === id || run.event === 'workflow_dispatch' || attemptRun?.status !== 'completed' || attemptRun?.conclusion !== 'success';
          if (replaced) disclosureNeeded.push(`${label} run ${run.id} attempt ${attempt}`);
        }
      }
    }
    if (!ids.has(id)) fail.push(`${label} run ${id} is not in the history for C`);

    // Re-read before the verdict.
    const again = snapshot.reread?.verdictRuns?.[key];
    if (JSON.stringify(again) !== JSON.stringify(runSummary(verdict))) fail.push(`${label} run ${id} changed during verification`);
    const againHistory = snapshot.reread?.history?.[key];
    if (JSON.stringify(againHistory) !== JSON.stringify(history.map((entry) => fingerprint(entry?.run)))) fail.push(`${label} history changed during verification`);
  }
  if (snapshot.reread?.mainHead !== snapshot.mainHead) fail.push('main changed during verification');
  lines.push(A11Y_LINE);

  if (disclosureNeeded.length > 0) {
    lines.push(`REPLACED ${disclosureNeeded.join(', ')}`);
    if (!snapshot.disclosure) fail.push('replaced history without --disclosure');
  }
  if (snapshot.disclosure) lines.push(`DISCLOSURE ${snapshot.disclosure}`);

  const reasons = [...new Set(fail.length > 0 ? fail : blocked)];
  if (fail.length > 0) return result('FAIL', reasons);
  if (blocked.length > 0) return result('BLOCKED', reasons);
  return result('PASS', []);
}

export const exitCode = (verdict) => ({ PASS: 0, FAIL: 1 })[verdict] ?? 2;

/** Parses CLI arguments; returns `{ options }` or `{ error }`. */
export function parseArguments(argv) {
  const options = {};
  const flags = { '--sha': 'sha', '--ci-run': 'ciRun', '--apple-run': 'appleRun', '--disclosure': 'disclosure' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags[argv[index]];
    const value = argv[index + 1];
    if (!key || value === undefined || options[key] !== undefined) return { error: `unexpected argument ${argv[index]}` };
    options[key] = value;
  }
  if (!SHA.test(options.sha ?? '')) return { error: '--sha must be a full 40-character lowercase SHA' };
  for (const key of ['ciRun', 'appleRun']) {
    if (!/^[1-9][0-9]{0,15}$/.test(options[key] ?? '')) return { error: `--${key === 'ciRun' ? 'ci-run' : 'apple-run'} must be a run id` };
    options[key] = Number(options[key]);
  }
  if (options.disclosure !== undefined && (options.disclosure.trim() === '' || options.disclosure.length > 500 || [...options.disclosure].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    return { error: '--disclosure must be one line of at most 500 characters' };
  }
  return { options };
}

function ghApi(resource) {
  try {
    const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', resource], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 200, body: JSON.parse(out) };
  } catch (error) {
    const status = /HTTP (\d{3})/.exec(String(error?.stderr ?? ''))?.[1];
    return { status: status ? Number(status) : 0, body: null };
  }
}

// Git always runs in the repository that contains this script, never in the caller's working directory.
const scriptPath = fileURLToPath(import.meta.url);
export const gitIn = (directory) => (args, raw = false) => execFileSync('git', ['-C', directory, ...args],
  { encoding: raw ? 'buffer' : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.error) {
    console.log(`R1-CI BLOCKED usage: ${parsed.error}`);
    process.exit(2);
  }
  let outcome;
  try {
    outcome = evaluate(gather(parsed.options, { api: ghApi, git: gitIn(path.dirname(scriptPath)), scriptPath, readScript: () => readFileSync(scriptPath) }));
  } catch (error) {
    const reason = error instanceof Blocked ? error.message : 'unexpected error while reading';
    outcome = { verdict: 'BLOCKED', lines: [R1_REMINDER, `R1-CI BLOCKED ${reason}`] };
  }
  for (const line of outcome.lines) console.log(line);
  process.exit(exitCode(outcome.verdict));
}
