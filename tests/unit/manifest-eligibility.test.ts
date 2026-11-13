import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  ELIGIBILITY_LABEL, ELIGIBLE_UNTIL, IMMUTABLE_SQL, MANIFEST_DATES, PROBES, SNAPSHOT_SQL, createManifestEligibility, moveSql,
  realRefusalProbes,
} from '../integration/manifest-eligibility.sessions.mjs';

// HARNESS-DATE2: the CI-only preservation rehearsal replays frozen historical function bodies that refuse after their manifest's
// review date. The rehearsal moves the dates of the explicitly named non-Azure manifests into the future only for the duration of
// a behavioural phase and restores them exactly. These checks pin the allowlist against the migrations, the inventory of date
// gates, the SQL of the move, the failure handling and the rehearsal wiring. The SQL itself is proven in CI by the rehearsal.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const AVAIL = '20261101080000_persistent_ai_availability.sql';
const read = async (name: string) => (await readFile(new URL(name, DIR), 'utf8')).replaceAll('\r\n', '\n');
const files = async () => (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
const readPath = async (path: string) => (await readFile(new URL(path, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

type Found = { file: string; key: string; body: string };
async function definitions(before: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const file of (await files()).filter((name) => name < before)) {
    const text = await read(file);
    for (const match of text.matchAll(/create (?:or replace )?function ([a-z_]+\.[a-z_0-9]+)\(/g)) {
      const start = text.indexOf('$$', match.index), end = text.indexOf('\n$$;', start + 2);
      expect(start).toBeGreaterThan(match.index!);
      found.push({ file, key: match[1]!, body: text.slice(match.index!, end + 4) });
    }
  }
  return found;
}

// Who answers for each function that reads a review date before the persistent-availability migration.
const OWNERS: Record<string, string> = {
  'public.ai_claim_analysis': 'synthetic-analysis (Azure, #198) and manifest eligibility (legacy Google)',
  'private.ai_analysis_permitted': 'synthetic-analysis (Azure, #198) and manifest eligibility (legacy Google)',
  'public.reserve_analyzed_item_save': 'synthetic-analysis (Azure, #198) and manifest eligibility (legacy Google)',
  'private.reserve_image_change': 'synthetic-analysis (Azure, #198)',
  'public.stylist_claim': 'manifest eligibility (stylist)', 'public.enhance_claim': 'manifest eligibility (enhance)',
  'private.tryon_permission': 'manifest eligibility (tryon)', 'private.tryon_probe_permission': 'manifest eligibility (tryon)',
  'public.tryon_claim': 'manifest eligibility (tryon)',
};

describe('review-date gate inventory', () => {
  it('lists every function that reads a review date before the persistent-availability migration, so a new gate fails here', async () => {
    const gated = (await definitions(AVAIL)).filter((entry) => /review_expires_at/.test(entry.body));
    expect([...new Set(gated.map((entry) => entry.key))].sort()).toEqual(Object.keys(OWNERS).sort());
  });

  it('has no review-date read after the persistent-availability migration except the retired Google term', async () => {
    for (const file of (await files()).filter((name) => name >= AVAIL)) {
      const text = await read(file);
      const code = text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
      const count = (code.match(/review_expires_at/g) ?? []).length;
      expect(count, file).toBe(file === AVAIL || file === '20261101090000_unreserved_analysis_manifest.sql' || file === '20261113090100_garment_type_manifest.sql' ? 1 : 0);
    }
  });
});

describe('manifest allowlist', () => {
  it('names exactly the non-Azure-analysis manifests that carry a not-yet-passed review date, with their migration dates', async () => {
    const all = (await Promise.all((await files()).map(read))).join('\n');
    const statements = [...all.matchAll(/insert into private\.ai_execution_manifests values \(([\s\S]*?)\n\);/g)].map((match) => match[1]!);
    for (const [id, date] of Object.entries(MANIFEST_DATES)) {
      const statement = statements.find((text) => text.trimStart().startsWith(`'${id}'`));
      expect(statement, id).toBeDefined();
      expect(statement, id).toContain(`'${date}'`);
    }
    // Every other recorded manifest is outside the allowlist; the Azure analysis ones (21 October 2026, #198) stay as they are.
    const others = statements.map((text) => /^\s*'([^']+)'/.exec(text)![1]!).filter((id) => !Object.hasOwn(MANIFEST_DATES, id));
    expect(others.some((id) => id.startsWith('azure-eu-terra-devtest'))).toBe(true);
    expect(Object.keys(MANIFEST_DATES).some((id) => id.startsWith('azure-eu-terra-devtest'))).toBe(false);
    expect(ELIGIBLE_UNTIL > '2030').toBe(true);
    for (const date of Object.values(MANIFEST_DATES)) expect(date < ELIGIBLE_UNTIL).toBe(true);
  });
});

describe('the move', () => {
  const advance = moveSql('advance'), restore = moveSql('restore');

  it('is one atomic transaction with the replica role only around the single allowlisted update, restored before commit', () => {
    for (const sql of [advance, restore]) {
      expect(sql.startsWith('begin;')).toBe(true);
      expect(sql.trimEnd().endsWith('commit;')).toBe(true);
      expect(sql.match(/update private\.ai_execution_manifests/g)).toHaveLength(1);
      expect(sql.match(/^set local session_replication_role = replica;$/gm)).toHaveLength(1);
      expect(sql.match(/^set local session_replication_role = origin;$/gm)).toHaveLength(1);
      expect(sql).not.toContain("set_config('session_replication_role'");
      expect(sql.indexOf('= replica;')).toBeLessThan(sql.indexOf('update private.ai_execution_manifests'));
      expect(sql.indexOf('update private.ai_execution_manifests')).toBeLessThan(sql.indexOf('= origin;'));
      expect(sql.indexOf('= origin;')).toBeLessThan(sql.indexOf('ELIGIBILITY_ROLE_NOT_RESTORED'));
      expect(sql.indexOf('ELIGIBILITY_ROLE_NOT_RESTORED')).toBeLessThan(sql.indexOf('commit;'));
      for (const needle of ['ELIGIBILITY_PRECONDITION', 'ELIGIBILITY_ROLE_NOT_RESTORED', 'ELIGIBILITY_ROWS_NOT_AS_EXPECTED', 'ELIGIBILITY_TRIGGER_CHANGED',
        "current_setting('session_replication_role')<>'origin'", "tgname='ai_manifest_immutable'"]) expect(sql, needle).toContain(needle);
      expect(sql).not.toMatch(/disable trigger|alter table|drop trigger|set session|set role/i);
      expect(sql).not.toMatch(/\bdelete\b|\binsert\b/i);
      for (const id of Object.keys(MANIFEST_DATES)) expect(sql, id).toContain(`'${id}'`);
      expect(sql).not.toContain('azure-eu-terra-devtest');
    }
    expect(advance).toContain(`'${ELIGIBLE_UNTIL}'::timestamptz`);
    expect(advance).not.toBe(restore);
  });

  it('moves each row only from the exact date it is expected to hold', () => {
    for (const [id, date] of Object.entries(MANIFEST_DATES)) {
      expect(advance).toContain(`('${id}','${date}'::timestamptz,'${ELIGIBLE_UNTIL}'::timestamptz)`);
      expect(restore).toContain(`('${id}','${ELIGIBLE_UNTIL}'::timestamptz,'${date}'::timestamptz)`);
    }
    expect(advance).toContain('where m.id=v.id and m.review_expires_at=v.from_at');
  });

  it('asserts the ordinary refusal on a rolled-back statement and compares complete manifest rows', () => {
    expect(IMMUTABLE_SQL.startsWith('begin;')).toBe(true);
    expect(IMMUTABLE_SQL.trimEnd().endsWith('rollback;')).toBe(true);
    expect(IMMUTABLE_SQL).toContain('update private.ai_execution_manifests');
    expect(IMMUTABLE_SQL).toContain('delete from private.ai_execution_manifests');
    expect(IMMUTABLE_SQL).not.toContain('session_replication_role');
    expect(SNAPSHOT_SQL).toContain('to_jsonb(m)');
  });
});

// A model of the database: manifest rows, the trigger, and the statements the module sends.
function fakeDatabase(options: { failRestore?: boolean; refuse?: boolean; noMove?: boolean } = {}) {
  const rows = Object.entries(MANIFEST_DATES).map(([id, date]) => ({ id, review_expires_at: date, model_id: 'm' }));
  rows.push({ id: 'azure-eu-terra-devtest-v2', review_expires_at: '2026-10-21T00:00:00Z', model_id: 'm' });
  const original = structuredClone(rows);
  const calls: string[] = [];
  let corruptRestore = false;
  const moved = () => Object.keys(MANIFEST_DATES).length;
  const sql = async (text: string) => {
    calls.push(text === moveSql('advance') ? 'advance' : text === moveSql('restore') ? 'restore' : text === IMMUTABLE_SQL ? 'refusal' : text === SNAPSHOT_SQL ? 'snapshot' : 'other');
    if (text === SNAPSHOT_SQL) return JSON.stringify(rows);
    if (text === IMMUTABLE_SQL) return `REFUSAL:${options.refuse === false ? 'NOT_REFUSED|NOT_REFUSED' : 'Not available|Not available'}`;
    if (text === moveSql('advance')) {
      if (!options.noMove) for (const row of rows) if (Object.hasOwn(MANIFEST_DATES, row.id)) row.review_expires_at = ELIGIBLE_UNTIL;
      return `MOVED:${moved()}`;
    }
    if (text === moveSql('restore')) {
      if (options.failRestore) throw new Error('database unavailable');
      for (const row of rows) if (Object.hasOwn(MANIFEST_DATES, row.id)) row.review_expires_at = MANIFEST_DATES[row.id as keyof typeof MANIFEST_DATES]!;
      if (corruptRestore) rows[0]!.model_id = 'changed';
      return `MOVED:${moved()}`;
    }
    throw new Error('unexpected statement');
  };
  return { rows, original, calls, sql, corrupt: () => { corruptRestore = true; } };
}

describe('phase runner and failure handling', () => {
  it('moves, runs the phase between the refusal checks, restores exactly and labels the phase', async () => {
    const db = fakeDatabase(), logs: string[] = [];
    const eligible = createManifestEligibility(db.sql, { log: (message: string) => logs.push(message) });
    const value = await eligible.run('PHASE-A', async () => {
      expect(db.rows.filter((row) => row.id in MANIFEST_DATES).every((row) => row.review_expires_at === ELIGIBLE_UNTIL)).toBe(true);
      expect(db.rows.find((row) => row.id === 'azure-eu-terra-devtest-v2')!.review_expires_at).toBe('2026-10-21T00:00:00Z');
      return 42;
    });
    expect(value).toBe(42);
    expect(db.rows).toEqual(db.original);
    expect(db.calls.filter((call) => call !== 'snapshot')).toEqual(['refusal', 'advance', 'refusal', 'restore', 'refusal']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('PASS: PHASE-A');
    expect(logs[0]).toContain(ELIGIBILITY_LABEL);
  });

  it('restores and rethrows the phase error when the phase fails', async () => {
    const db = fakeDatabase();
    const eligible = createManifestEligibility(db.sql, { log: () => {} });
    await expect(eligible.run('PHASE-B', async () => { throw new Error('PHASE_FAILED'); })).rejects.toThrow('PHASE_FAILED');
    expect(db.rows).toEqual(db.original);
    await expect(eligible.run('PHASE-C', async () => 1)).resolves.toBe(1);
  });

  it('aborts with a dedicated error when the restoration fails, and then starts no further phase', async () => {
    const db = fakeDatabase({ failRestore: true });
    const eligible = createManifestEligibility(db.sql, { log: () => {} });
    let ran = 0;
    await expect(eligible.run('PHASE-D', async () => { ran += 1; })).rejects.toThrow('ELIGIBILITY_RESTORE_FAILED');
    expect(ran).toBe(1);
    await expect(eligible.run('PHASE-E', async () => { ran += 1; })).rejects.toThrow();
    expect(ran).toBe(1);
    expect(db.calls.filter((call) => call === 'advance')).toHaveLength(1);
  });

  it('aborts when the restored manifest rows differ from the snapshot in any column', async () => {
    const db = fakeDatabase();
    db.corrupt();
    const eligible = createManifestEligibility(db.sql, { log: () => {} });
    await expect(eligible.run('PHASE-F', async () => 1)).rejects.toThrow('ELIGIBILITY_RESTORE_FAILED');
  });

  it('does not run the phase when the ordinary update and delete are not refused, or when the move touched nothing', async () => {
    let ran = 0;
    const unrefused = fakeDatabase({ refuse: false });
    await expect(createManifestEligibility(unrefused.sql, { log: () => {} }).run('PHASE-G', async () => { ran += 1; })).rejects.toThrow();
    expect(unrefused.calls).not.toContain('advance');
    const silent = fakeDatabase({ noMove: true });
    await expect(createManifestEligibility(silent.sql, { log: () => {} }).run('PHASE-H', async () => { ran += 1; })).rejects.toThrow();
    expect(ran).toBe(0);
    expect(silent.rows).toEqual(silent.original);
  });

  it('refuses a start when a manifest does not hold its exact original date', async () => {
    const db = fakeDatabase();
    db.rows[0]!.review_expires_at = '2026-02-02T00:00:00Z';
    await expect(createManifestEligibility(db.sql, { log: () => {} }).run('PHASE-I', async () => 1)).rejects.toThrow();
    expect(db.calls).not.toContain('advance');
  });

  it('never runs two phases at once', async () => {
    const db = fakeDatabase();
    const eligible = createManifestEligibility(db.sql, { log: () => {} });
    await expect(eligible.run('outer', () => eligible.run('inner', async () => 1))).rejects.toThrow();
  });
});

describe('real historical gate probes', () => {
  const reply = (code: string, claimed: boolean) => `R:${JSON.stringify({ code, claimed })}`;
  const sqlFor = (past: boolean, answer: string, seen: string[] = []) => async (text: string) => {
    seen.push(text);
    return text.includes('clock_timestamp()>=') ? String(past) : answer;
  };

  it('requires exactly UNCONFIGURED once the real clock is past the date, and a passed gate before it', async () => {
    await expect(realRefusalProbes(sqlFor(true, reply('UNCONFIGURED', false)), 'u', ['stylist'], { log: () => {} })).resolves.toBeDefined();
    await expect(realRefusalProbes(sqlFor(true, reply('OK', true)), 'u', ['stylist'], { log: () => {} })).rejects.toThrow();
    await expect(realRefusalProbes(sqlFor(true, reply('INACTIVE', false)), 'u', ['tryon'], { log: () => {} })).rejects.toThrow();
    await expect(realRefusalProbes(sqlFor(false, reply('OK', true)), 'u', ['stylist'], { log: () => {} })).resolves.toBeDefined();
    await expect(realRefusalProbes(sqlFor(false, reply('UNCONFIGURED', false)), 'u', ['stylist'], { log: () => {} })).rejects.toThrow();
  });

  it('runs each probe on a transaction that is rolled back, with the real function and no date change', async () => {
    const seen: string[] = [];
    await realRefusalProbes(sqlFor(false, reply('OK', true), seen), 'u', Object.keys(PROBES), { log: () => {} });
    const probes = seen.filter((text) => text.startsWith('begin;'));
    expect(probes).toHaveLength(Object.keys(PROBES).length);
    for (const text of probes) {
      expect(text.trimEnd().endsWith('rollback;')).toBe(true);
      expect(text).not.toMatch(/review_expires_at|session_replication_role|ai_execution_manifests/);
    }
    expect(Object.values(PROBES).every((probe) => Object.hasOwn(MANIFEST_DATES, probe.id))).toBe(true);
  });
});

describe('rehearsal wiring', () => {
  it('runs every date-gated historical behavioural phase inside a window and nothing else', async () => {
    const rehearsal = await readPath('../../scripts/preservation-rehearsal.mjs');
    const windows = [...rehearsal.matchAll(/eligible\.run\('([^']+)'/g)].map((match) => match[1]);
    expect(windows).toEqual(['AZ1-prior-main-capture', 'AZ1-preservation', 'FILT1-upgrade-seed', 'FILT1-upgrade-verify', 'RAIN1-seed', 'RAIN1-verify', 'ST1a-stylist-ledger', 'BG2b-enhancement-ledger',
      'AD1-admin-limits', 'VTO1-tryon-ledger', 'BUDGET1-shared-budget', 'IDEA1-seed', 'IDEA1-upgrade-verify', 'IDEA1-tryon-idea', 'PHOTO1-seed',
      'PHOTO1-upgrade-verify', 'PHOTO1-tryon-photo']);
    const lines = rehearsal.split('\n').filter((line) => line.includes('eligible.run('));
    for (const line of lines) {
      // One statement per window: no migration, history, storage guard or comparison runs inside one.
      expect(line, line).not.toMatch(/migrateTo|history\(|verifyCiStorageGuard|verifyColourStage|verifyStylistV2Stage|stylistUpgradeManifestRows|availabilityCompare|budget2Compare/);
    }
    // The manifest comparisons run with the original dates, outside every window.
    for (const text of ["await verifyStylistV2Stage(colourSnapshot, privilegedLocalSql);\n      await stylistUpgradeManifestRows(privilegedLocalSql);",
      "await availabilityCompare(availBefore, privilegedLocalSql,", "await budget2Compare(budget2Before, privilegedLocalSql,"]) expect(rehearsal, text).toContain(text);
    // From AVAIL1 on, the current schema's real functions run with no override at all.
    const tail = rehearsal.slice(rehearsal.indexOf("stage = 'AVAIL1-checkpoint'"));
    expect(tail).not.toContain('eligible.run(');
    expect(rehearsal).not.toMatch(/PRESERVATION_REVIEW_CLOCK|createReviewClock|review-clock/);
    expect(rehearsal).toContain('const eligible = createManifestEligibility(privilegedLocalSql, { mark:');
    expect(rehearsal).toContain("['stylist', 'enhance', 'tryon']);");
    expect(rehearsal).toContain("admission_no=1;')).trim(), ['google']);");
  });

  it('keeps the manifest-row comparison out of the Stylist upgrade phase', async () => {
    const ledger = await readPath('../integration/stylist-ledger.sessions.mjs');
    const start = ledger.indexOf('export async function stylistUpgradeVerify');
    expect(start).toBeGreaterThan(-1);
    expect(ledger.slice(start)).not.toContain('STYLIST_V2_MANIFEST_ROW');
    expect(ledger).toContain('export async function stylistUpgradeManifestRows(sql)');
  });

  it('keeps the immutability test of the manifests in the later current-schema rehearsal', async () => {
    const later = await readPath('../../scripts/ai-analysis-rehearsal.mjs');
    expect(later).toContain('Expected immutable manifest refusal');
  });
});
