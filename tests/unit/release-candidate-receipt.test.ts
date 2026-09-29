import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APPLE_JOBS, CI_JOBS, REPOSITORY, WORKFLOWS, Blocked, evaluate, exitCode, gather, jobNames, paginate, parseArguments,
} from '../../scripts/release-candidate-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ciText = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const appleText = readFileSync(path.join(root, '.github', 'workflows', 'apple-jpeg-probe.yml'), 'utf8');

const C = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const CI_ID = 351440557;
const APPLE_ID = 352335442;
const CI_RUN = 5000;
const APPLE_RUN = 6000;

type Job = { id: number; run_id: number; run_attempt: number; name: string; head_sha: string; status: string; conclusion: string | null };
type Run = Record<string, unknown> & { id: number; run_attempt: number };
type Attempt = { run: Record<string, unknown>; jobs: Job[] };

let nextJob = 1;
const jobsFor = (key: 'ci' | 'apple', runId: number, attempt: number, change: (job: Job) => Job | Job[] | null = (job) => job) => {
  const names = key === 'ci' ? CI_JOBS : APPLE_JOBS;
  return names.flatMap((name) => {
    const job: Job = { id: nextJob++, run_id: runId, run_attempt: attempt, name, head_sha: C, status: 'completed',
      conclusion: name === 'Documentation checks' ? 'skipped' : 'success' };
    const changed = change(job);
    return changed === null ? [] : Array.isArray(changed) ? changed : [changed];
  });
};
const run = (key: 'ci' | 'apple', id: number, extra: Partial<Run> = {}): Run => ({
  id, name: key === 'ci' ? 'CI' : 'Apple JPEG diagnostic', path: WORKFLOWS[key].path, workflow_id: key === 'ci' ? CI_ID : APPLE_ID,
  head_sha: C, head_branch: 'main', head_repository: { full_name: REPOSITORY }, event: 'workflow_dispatch', status: 'completed',
  conclusion: 'success', run_attempt: 1, updated_at: '2026-10-01T10:00:00Z', html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`, ...extra,
});

interface World {
  head: string; porcelain: string; main: string; mainAgain?: string;
  definitions: { ci: string; apple: string };
  runs: { ci: Run[]; apple: Run[] };
  attempts: Map<number, Attempt[]>;
  // Returns a replacement response for a resource/page, or undefined to use the default.
  override?: (resource: string, call: number) => { status: number; body: unknown } | undefined;
  runsAgain?: { ci?: Run[]; apple?: Run[] };
  verdictAgain?: Record<number, Partial<Run>>;
}

function addRun(world: World, key: 'ci' | 'apple', value: Run, attempts?: Attempt[]) {
  world.runs[key].push(value);
  world.attempts.set(value.id, attempts ?? Array.from({ length: value.run_attempt }, (_, index) => ({
    run: { ...value, run_attempt: index + 1 }, jobs: jobsFor(key, value.id, index + 1),
  })));
}

function baseWorld(): World {
  const world: World = { head: C, porcelain: '', main: C, definitions: { ci: ciText, apple: appleText }, runs: { ci: [], apple: [] }, attempts: new Map() };
  addRun(world, 'ci', run('ci', CI_RUN));
  addRun(world, 'apple', run('apple', APPLE_RUN));
  return world;
}

const page = <T,>(items: T[], key: string, number: number, perPage: number) => ({ status: 200,
  body: { total_count: items.length, [key]: items.slice((number - 1) * perPage, number * perPage) } });

function fake(world: World) {
  const calls = new Map<string, number>();
  const api = (resource: string) => {
    const call = (calls.get(resource) ?? 0) + 1;
    calls.set(resource, call);
    const replaced = world.override?.(resource, call);
    if (replaced) return replaced;
    const [pathname, query = ''] = resource.split('?');
    const params = new URLSearchParams(query);
    const number = Number(params.get('page') ?? '1');
    const perPage = Number(params.get('per_page') ?? '100');
    const prefix = `repos/${REPOSITORY}/`;
    if (!pathname!.startsWith(prefix)) return { status: 404, body: null };
    const rest = pathname!.slice(prefix.length);
    if (rest === 'git/ref/heads/main') {
      const mainCalls = [...calls.entries()].filter(([key]) => key.endsWith('git/ref/heads/main')).reduce((sum, [, value]) => sum + value, 0);
      return { status: 200, body: { object: { sha: mainCalls > 1 && world.mainAgain ? world.mainAgain : world.main } } };
    }
    let match = /^actions\/workflows\/([a-z-]+\.yml)$/.exec(rest);
    if (match) {
      const key = match[1] === 'ci.yml' ? 'ci' : 'apple';
      return { status: 200, body: { id: key === 'ci' ? CI_ID : APPLE_ID, path: WORKFLOWS[key].path } };
    }
    match = /^actions\/workflows\/([a-z-]+\.yml)\/runs$/.exec(rest);
    if (match) {
      const key = match[1] === 'ci.yml' ? 'ci' : 'apple';
      if (params.get('head_sha') !== C) return { status: 422, body: null };
      const listCalls = calls.get(resource)!;
      const runs = listCalls > 1 && world.runsAgain?.[key] ? world.runsAgain[key]! : world.runs[key];
      return page([...runs].sort((a, b) => b.id - a.id), 'workflow_runs', number, perPage);
    }
    match = /^actions\/runs\/(\d+)$/.exec(rest);
    if (match) {
      const id = Number(match[1]);
      const found = [...world.runs.ci, ...world.runs.apple].find((value) => value.id === id);
      if (!found) return { status: 404, body: null };
      return { status: 200, body: call > 1 && world.verdictAgain?.[id] ? { ...found, ...world.verdictAgain[id] } : found };
    }
    match = /^actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(rest);
    if (match) {
      const attempt = world.attempts.get(Number(match[1]))?.[Number(match[2]) - 1];
      return attempt ? { status: 200, body: attempt.run } : { status: 404, body: null };
    }
    match = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(rest);
    if (match) {
      const attempt = world.attempts.get(Number(match[1]))?.[Number(match[2]) - 1];
      return attempt ? page(attempt.jobs, 'jobs', number, perPage) : { status: 404, body: null };
    }
    return { status: 404, body: null };
  };
  const git = (args: string[]) => {
    if (args[0] === 'rev-parse') return `${world.head}\n`;
    if (args[0] === 'status') return world.porcelain;
    if (args[0] === 'show') {
      const file = args[1]!.split(':')[1];
      if (!args[1]!.startsWith(`${C}:`)) throw new Error('not C');
      return file === WORKFLOWS.ci.path ? world.definitions.ci : world.definitions.apple;
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { api, git, calls };
}

let clock = 0;
function verify(world: World, disclosure?: string) {
  const { api, git } = fake(world);
  try {
    return evaluate(gather({ sha: C, ciRun: CI_RUN, appleRun: APPLE_RUN, disclosure }, { api, git, now: () => new Date(Date.UTC(2026, 9, 1, 10, 0, clock++)).toISOString() }));
  } catch (error) {
    if (error instanceof Blocked) return { verdict: 'BLOCKED' as const, reasons: [error.message], lines: [] };
    throw error;
  }
}
const expectVerdict = (outcome: { verdict: string; reasons: string[] }, verdict: string, reason?: RegExp) => {
  expect(outcome.verdict, outcome.reasons.join('; ')).toBe(verdict);
  if (reason) expect(outcome.reasons.join('; ')).toMatch(reason);
};
const withJobs = (world: World, id: number, change: (job: Job) => Job | Job[] | null, attempt = 1) => {
  const key = world.runs.ci.some((value) => value.id === id) ? 'ci' : 'apple';
  world.attempts.get(id)![attempt - 1]!.jobs = jobsFor(key, id, attempt, change);
};

describe('R1 release-candidate receipt: pinned inventories', () => {
  it('equal the job inventories parsed from the current ci.yml and apple-jpeg-probe.yml', () => {
    expect(jobNames(ciText)).toEqual(CI_JOBS);
    expect(jobNames(appleText)).toEqual(APPLE_JOBS);
  });

  it('keeps the Apple diagnostic dispatchable on main for R1, with its public-repository guard', () => {
    const on = appleText.replaceAll('\r\n', '\n').split('\npermissions:')[0]!;
    expect(on).toMatch(/\n {2}pull_request:\n/);
    expect(on).toMatch(/\n {2}workflow_dispatch:\n/);
    expect(appleText).toContain('if: github.event.repository.private == false');
  });
});

describe('R1 release-candidate receipt: positive cases', () => {
  it('passes a dispatch run with every pinned job, listing jobs, history, the a11y line and the R1 reminder', () => {
    const outcome = verify(baseWorld());
    expectVerdict(outcome, 'PASS');
    expect(exitCode(outcome.verdict)).toBe(0);
    const text = outcome.lines.join('\n');
    for (const name of CI_JOBS) expect(text).toContain(`JOB ${name} ${name === 'Documentation checks' ? 'skipped' : 'success'} cccccccc`);
    expect(text).toContain(`JOB ${APPLE_JOBS[0]} success cccccccc`);
    expect(text).toContain(`HISTORY CI run ${CI_RUN} workflow_dispatch attempt 1 completed/success (verdict)`);
    expect(text).toMatch(/^A11Y /m);
    expect(text).toMatch(/^NOTE R1 also needs the Pages deploy of exactly C/m);
    expect(outcome.lines.at(-1)).toBe(`R1-CI PASS ${C}`);
  });

  it('passes a push run', () => {
    const world = baseWorld();
    world.runs.ci[0]!.event = 'push';
    world.attempts.get(CI_RUN)![0]!.run.event = 'push';
    expectVerdict(verify(world), 'PASS');
  });

  it('passes a disclosed replaced history and prints the disclosure verbatim', () => {
    const world = baseWorld();
    world.runs.ci = [];
    addRun(world, 'ci', run('ci', CI_RUN - 1, { event: 'push', conclusion: 'failure' }));
    world.attempts.get(CI_RUN - 1)![0]!.run.conclusion = 'failure';
    withJobs(world, CI_RUN - 1, (job) => (job.name === 'WebKit photo contracts' ? { ...job, conclusion: 'failure' } : job));
    addRun(world, 'ci', run('ci', CI_RUN, { run_attempt: 2 }));
    world.attempts.get(CI_RUN)![0]!.run.conclusion = 'failure';
    const outcome = verify(world, 'K2 flake: WebKit restore.spec:245, see #999');
    expectVerdict(outcome, 'PASS');
    const text = outcome.lines.join('\n');
    expect(text).toContain(`REPLACED CI run ${CI_RUN} attempt 1, CI run ${CI_RUN - 1} attempt 1`);
    expect(text).toContain(`HISTORY-JOB CI run ${CI_RUN - 1} attempt 1 WebKit photo contracts completed/failure`);
    expect(text).toContain('DISCLOSURE K2 flake: WebKit restore.spec:245, see #999');
  });
});

describe('R1 release-candidate receipt: binding to C', () => {
  it('is BLOCKED on a dirty checkout, an untracked file or HEAD other than C, before any API read', () => {
    for (const change of [(world: World) => { world.porcelain = ' M src/app.tsx\n'; }, (world: World) => { world.porcelain = '?? notes.txt\n'; },
      (world: World) => { world.head = OTHER; }]) {
      const world = baseWorld();
      change(world);
      const { api, git, calls } = fake(world);
      const outcome = evaluate(gather({ sha: C, ciRun: CI_RUN, appleRun: APPLE_RUN }, { api, git }));
      expectVerdict(outcome, 'BLOCKED', /checkout/);
      expect(calls.size).toBe(0);
    }
  });

  it('fails stale definitions at C: a renamed, added or removed CI job or shard, and a renamed Apple job', () => {
    const cases: Array<[keyof World['definitions'], (text: string) => string]> = [
      ['ci', (text) => text.replace('name: Performance budgets', 'name: Performance checks')],
      ['ci', (text) => text.replace('\n  performance:\n', '\n  extra:\n    name: Extra job\n    runs-on: ubuntu-latest\n  performance:\n')],
      ['ci', (text) => text.replace('shard: [1, 2, 3]', 'shard: [1, 2]')],
      ['apple', (text) => text.replace('name: Generated JPEG on native Apple WebKit', 'name: Apple probe')],
    ];
    for (const [key, change] of cases) {
      const world = baseWorld();
      world.definitions[key] = change(world.definitions[key].replaceAll('\r\n', '\n'));
      expectVerdict(verify(world), 'FAIL', /stale definitions/);
    }
  });
});

describe('R1 release-candidate receipt: run identity', () => {
  const cases: Array<[string, Partial<Run>, RegExp]> = [
    ['workflow_id', { workflow_id: 1 }, /wrong workflow_id/],
    ['path', { path: '.github/workflows/other.yml' }, /wrong workflow path/],
    ['pull_request event', { event: 'pull_request' }, /is not push or workflow_dispatch/],
    ['branch', { head_branch: 'feature' }, /not on main/],
    ['fork', { head_repository: { full_name: 'someone/fork' } }, /not from this repository/],
  ];
  for (const [label, change, reason] of cases) {
    it(`fails a verdict run with the wrong ${label}`, () => {
      const world = baseWorld();
      Object.assign(world.runs.ci[0]!, change);
      expectVerdict(verify(world), 'FAIL', reason);
    });
  }
});

describe('R1 release-candidate receipt: pagination', () => {
  it('reads every page up to total_count and checks the page beyond it is empty', () => {
    const items = Array.from({ length: 5 }, (_, index) => index);
    const pages: number[] = [];
    expect(paginate((number) => { pages.push(number); return page(items, 'jobs', number, 2); }, 'jobs', 2)).toEqual(items);
    expect(pages).toEqual([1, 2, 3, 4]);
  });

  it('is BLOCKED on a short page, a changed total, a non-2xx page or a non-empty extra page', () => {
    const items = Array.from({ length: 5 }, (_, index) => index);
    const short = (number: number) => (number === 1 ? { status: 200, body: { total_count: 5, jobs: [0] } } : page(items, 'jobs', number, 2));
    const changed = (number: number) => (number === 2 ? { status: 200, body: { total_count: 6, jobs: [2, 3] } } : page(items, 'jobs', number, 2));
    const failing = (number: number) => (number === 2 ? { status: 502, body: null } : page(items, 'jobs', number, 2));
    const extra = (number: number) => (number === 4 ? { status: 200, body: { total_count: 5, jobs: [9] } } : page(items, 'jobs', number, 2));
    for (const get of [short, changed, failing, extra]) expect(() => paginate(get, 'jobs', 2)).toThrow(Blocked);
  });

  it('turns a truncated job list from the API into a BLOCKED receipt', () => {
    const world = baseWorld();
    world.override = (resource) => (resource.includes(`/runs/${CI_RUN}/attempts/1/jobs`) && resource.endsWith('page=1')
      ? { status: 200, body: { total_count: CI_JOBS.length, jobs: world.attempts.get(CI_RUN)![0]!.jobs.slice(0, 3) } } : undefined);
    expectVerdict(verify(world), 'BLOCKED', /short page/);
  });

  it('is BLOCKED when the run history cannot be read', () => {
    const world = baseWorld();
    world.override = (resource) => (resource.includes('/workflows/ci.yml/runs?') ? { status: 403, body: null } : undefined);
    expectVerdict(verify(world), 'BLOCKED', /HTTP 403/);
  });
});

describe('R1 release-candidate receipt: malformed, duplicate and mixed records', () => {
  const cases: Array<[string, (job: Job) => Job | Job[] | null, RegExp]> = [
    ['a missing id', (job) => (job.name === 'Changed files' ? { ...job, id: undefined as unknown as number } : job), /malformed job \(missing id\)/],
    ['a bad SHA', (job) => (job.name === 'Changed files' ? { ...job, head_sha: 'abc' } : job), /bad head_sha/],
    ['an unknown conclusion', (job) => (job.name === 'Changed files' ? { ...job, conclusion: 'great' } : job), /unknown conclusion/],
    ['an attempt mismatch', (job) => (job.name === 'Changed files' ? { ...job, run_attempt: 2 } : job), /attempt mismatch/],
    ['a duplicate job id', (job) => (job.name === 'Real local Supabase' ? [job, { ...job, name: 'Real local Supabase again' }] : job), /duplicate job id/],
    ['a duplicate required name', (job) => (job.name === 'Real local Supabase' ? [job, { ...job, id: job.id + 100_000 }] : job), /duplicate job Real local Supabase/],
    ['a mixed SHA', (job) => (job.name === 'Performance budgets' ? { ...job, head_sha: OTHER } : job), /mixed SHA in job Performance budgets/],
  ];
  for (const [label, change, reason] of cases) {
    it(`fails ${label}`, () => {
      const world = baseWorld();
      withJobs(world, CI_RUN, change);
      expectVerdict(verify(world), 'FAIL', reason);
    });
  }
});

describe('R1 release-candidate receipt: required jobs', () => {
  const cases: Array<[string, number, (job: Job) => Job | Job[] | null, RegExp]> = [
    ['a required job skipped', CI_RUN, (job) => (job.name === 'WebKit photo contracts' ? { ...job, conclusion: 'skipped' } : job), /WebKit photo contracts is completed\/skipped/],
    ['a required job cancelled', CI_RUN, (job) => (job.name === 'App browser contracts (2/3)' ? { ...job, conclusion: 'cancelled' } : job), /\(2\/3\) is completed\/cancelled/],
    ['a required job missing', CI_RUN, (job) => (job.name === 'Account deletion rehearsal' ? null : job), /required job missing: Account deletion rehearsal/],
    ['Documentation checks not skipped', CI_RUN, (job) => (job.name === 'Documentation checks' ? { ...job, conclusion: 'success' } : job), /Documentation checks is completed\/success, expected skipped/],
    ['an unexpected job', CI_RUN, (job) => (job.name === 'Changed files' ? [job, { ...job, id: job.id + 100_000, name: 'Surprise' }] : job), /unexpected job Surprise/],
    ['the Apple job skipped', APPLE_RUN, (job) => ({ ...job, conclusion: 'skipped' }), /Generated JPEG on native Apple WebKit is completed\/skipped/],
  ];
  for (const [label, id, change, reason] of cases) {
    it(`fails ${label}`, () => {
      const world = baseWorld();
      withJobs(world, id, change);
      expectVerdict(verify(world), 'FAIL', reason);
    });
  }
});

describe('R1 release-candidate receipt: history for C', () => {
  it('fails an earlier failed run without a disclosure', () => {
    const world = baseWorld();
    addRun(world, 'ci', run('ci', CI_RUN - 1, { event: 'push', conclusion: 'cancelled' }));
    world.attempts.get(CI_RUN - 1)![0]!.run.conclusion = 'cancelled';
    expectVerdict(verify(world), 'FAIL', /replaced history without --disclosure/);
  });

  it('fails an earlier attempt of the verdict run without a disclosure', () => {
    const world = baseWorld();
    world.runs.ci = [];
    addRun(world, 'ci', run('ci', CI_RUN, { run_attempt: 2 }));
    const outcome = verify(world);
    expectVerdict(outcome, 'FAIL', /replaced history without --disclosure/);
    expect(outcome.lines.join('\n')).toContain(`REPLACED CI run ${CI_RUN} attempt 1`);
  });

  it('fails another dispatch for C without a disclosure, even when it succeeded', () => {
    const world = baseWorld();
    addRun(world, 'apple', run('apple', APPLE_RUN - 1));
    expectVerdict(verify(world), 'FAIL', /replaced history without --disclosure/);
  });

  it('fails a later run that supersedes the verdict run', () => {
    const world = baseWorld();
    addRun(world, 'ci', run('ci', CI_RUN + 1));
    expectVerdict(verify(world, 'disclosed'), 'FAIL', /superseded by later run/);
  });

  it('is BLOCKED while a run for C is still in progress', () => {
    const world = baseWorld();
    world.runs.apple[0]!.status = 'in_progress';
    world.runs.apple[0]!.conclusion = null;
    world.attempts.get(APPLE_RUN)![0]!.run.status = 'in_progress';
    expectVerdict(verify(world), 'BLOCKED', /still in progress/);
  });

  it('fails when the verdict run is not in the history for C', () => {
    const world = baseWorld();
    world.override = (resource) => (resource.includes('/workflows/apple-jpeg-probe.yml/runs?') ? { status: 200, body: { total_count: 0, workflow_runs: [] } } : undefined);
    expectVerdict(verify(world), 'FAIL', /is not in the history for C/);
  });
});

describe('R1 release-candidate receipt: re-read before the verdict', () => {
  it('fails when main moved', () => {
    const world = baseWorld();
    world.mainAgain = OTHER;
    expectVerdict(verify(world), 'FAIL', /main changed during verification/);
  });

  it('fails when main is not C', () => {
    const world = baseWorld();
    world.main = OTHER;
    expectVerdict(verify(world), 'FAIL', /main is not the candidate/);
  });

  for (const [label, change] of [['attempt', { run_attempt: 2 }], ['conclusion', { conclusion: 'failure' }], ['updated_at', { updated_at: '2026-10-01T11:00:00Z' }]] as const) {
    it(`fails when the verdict run's ${label} changed`, () => {
      const world = baseWorld();
      world.verdictAgain = { [CI_RUN]: change };
      expectVerdict(verify(world), 'FAIL', /changed during verification/);
    });
  }

  it('fails when a new run for C appeared', () => {
    const world = baseWorld();
    world.runsAgain = { ci: [...world.runs.ci, run('ci', CI_RUN + 7)] };
    expectVerdict(verify(world), 'FAIL', /CI history changed during verification/);
  });
});

describe('R1 release-candidate receipt: content and arguments', () => {
  it('prints only ids, SHAs, names, conclusions, times, URLs and the disclosure', () => {
    const outcome = verify(baseWorld());
    for (const line of outcome.lines) {
      expect(line).toMatch(/^(REPOSITORY|CANDIDATE|READ|MAIN|RUN|HISTORY|HISTORY-JOB|JOB|A11Y|REPLACED|DISCLOSURE|NOTE|R1-CI) /);
      expect(line).not.toMatch(/token|password|secret|@[a-z0-9-]+\.[a-z]/i);
    }
  });

  it('refuses malformed arguments', () => {
    expect(parseArguments(['--sha', C, '--ci-run', '1', '--apple-run', '2']).options).toEqual({ sha: C, ciRun: 1, appleRun: 2 });
    for (const argv of [['--sha', C.slice(0, 39), '--ci-run', '1', '--apple-run', '2'], ['--sha', C.toUpperCase(), '--ci-run', '1', '--apple-run', '2'],
      ['--sha', C, '--ci-run', 'x', '--apple-run', '2'], ['--sha', C, '--ci-run', '1'], ['--sha', C, '--ci-run', '1', '--apple-run', '2', '--extra', 'y'],
      ['--sha', C, '--ci-run', '1', '--apple-run', '2', '--disclosure', 'two\nlines']]) {
      expect(parseArguments(argv).error, argv.join(' ')).toBeTruthy();
    }
    expect(exitCode('FAIL')).toBe(1);
    expect(exitCode('BLOCKED')).toBe(2);
  });
});
