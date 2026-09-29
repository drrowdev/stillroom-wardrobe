import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLEANUP_MANIFEST_ROW, ENHANCEMENT_MANIFEST_ROW } from '../integration/azure-preservation.sessions.mjs';
import { CLEANUP_MANIFEST, CLEANUP_NOTICE_REVISION, CLEANUP_PROMPT, CLEANUP_SETTINGS, ENHANCE_MANIFEST } from '../../src/domain/enhancement';

// Source pins for BG2c-1 (plan rev4 §7). The CI integration, preservation and security jobs prove the migration applies
// and behaves; these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261002090000_photo_cleanup_manifest.sql';
const BASE = '20260929090000_photo_enhancement.sql';
const CLAIM = 'create or replace function public.enhance_claim(';
const claimBody = (sql: string) => {
  const from = sql.indexOf(CLAIM);
  expect(from).toBeGreaterThan(-1);
  const to = sql.indexOf('\n$$;\n', from);
  expect(to).toBeGreaterThan(from);
  return sql.slice(from, to + 5);
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('photo clean-up manifest migration (BG2c-1)', () => {
  it('is one LF transaction after AD1 and replaces only enhance_claim', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- BG2c-1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.at(-1)).toBe(MAIN);
    expect(names.indexOf(MAIN)).toBeGreaterThan(names.indexOf('20261001090000_admin_limits.sql'));
    expect([...sql.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((match) => match[1])).toEqual(['public.enhance_claim']);
    const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
    expect(code).not.toMatch(/\bcreate function\b|\bdrop (function|table|trigger|constraint)\b|\bdelete from\b|\btruncate\b/);
    // No data change: nothing is activated and no consent is copied forward ("for update" row locks are not writes).
    expect(code.replaceAll('for update', '')).not.toMatch(/\bupdate\b/);
    expect(code).not.toContain('enhance_consent_revision');
    expect(code).not.toMatch(/enhance_activated|dispatch_enabled\s*=/);
  });

  it('reproduces the M8 enhance_claim byte for byte except the one admitted manifest literal', async () => {
    const [sql, base] = await Promise.all([read(MAIN), read(BASE)]);
    const before = claimBody(base.replace('create function public.enhance_claim(', CLAIM));
    const after = claimBody(sql);
    expect(before.split(`'${ENHANCE_MANIFEST}'`)).toHaveLength(2);
    expect(after).toBe(before.replace(`m.id<>'${ENHANCE_MANIFEST}'`, `m.id<>'${CLEANUP_MANIFEST}'`));
    expect(after).not.toContain(ENHANCE_MANIFEST);
    // No later migration had replaced it, so M8 is the right base.
    for (const name of (await readdir(DIR)).filter((entry) => entry.endsWith('.sql') && entry > BASE && entry < MAIN)) {
      expect(await read(name), name).not.toContain('function public.enhance_claim(');
    }
  });

  it('re-issues the service-role-only ACL exactly as M8', async () => {
    const [sql, base] = await Promise.all([read(MAIN), read(BASE)]);
    const acl = [
      'revoke all on function public.enhance_claim(uuid,uuid,text,text,uuid) from public,anon,authenticated,service_role;',
      'grant execute on function public.enhance_claim(uuid,uuid,text,text,uuid) to service_role;',
    ];
    for (const line of acl) expect(sql).toContain(`\n${line}\n`);
    expect(base).toMatch(/revoke all on function[\s\S]*public\.enhance_claim\(uuid,uuid,text,text,uuid\)[\s\S]*from public,anon,authenticated,service_role;/);
    expect(base).toMatch(/grant execute on function[\s\S]*public\.enhance_claim\(uuid,uuid,text,text,uuid\)[\s\S]*to service_role;/);
  });

  it('adds the null-safe notice floor for cleanup-v1 only', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain(`alter table private.ai_controls add constraint ai_controls_cleanup_notice check (
  enhance_manifest_id is distinct from '${CLEANUP_MANIFEST}'
  or (enhance_notice_revision is not null and enhance_notice_revision >= ${CLEANUP_NOTICE_REVISION}));`);
  });

  it('adds the cleanup-v1 manifest with the source hashes and the v1 envelope, on the shared deployment key', async () => {
    const [sql, base] = await Promise.all([read(MAIN), read(BASE)]);
    const row = (text: string, id: string) => {
      const from = text.indexOf(`insert into private.ai_execution_manifests values (\n  '${id}'`);
      expect(from, id).toBeGreaterThan(-1);
      return text.slice(from, text.indexOf('\n);', from));
    };
    const fields = (text: string) => {
      const lines = text.split('\n').slice(1);
      return { head: lines[0], hashes: lines.slice(1, 4).map((line) => line.trim().replace(/[',]/g, '')), tail: lines.at(-1) };
    };
    const cleanup = fields(row(sql, CLEANUP_MANIFEST)), v1 = fields(row(base, ENHANCE_MANIFEST));
    expect(cleanup.head).toBe(`  '${CLEANUP_MANIFEST}','gpt-image-2.5-sunburst',2,`);
    expect(cleanup.hashes[0]).toBe(sha(CLEANUP_PROMPT));
    expect(cleanup.hashes[1]).toBe(v1.hashes[1]);
    expect(cleanup.hashes[2]).toBe(sha(JSON.stringify(CLEANUP_SETTINGS)));
    expect(cleanup.hashes[2]).not.toBe(v1.hashes[2]);
    expect(cleanup.tail).toBe(v1.tail);
    const key = /insert into private\.provider_deployments values\('azure-global-image25-sunburst-enhance-v1',\s*'([^']+)'\)/.exec(base)?.[1];
    expect(key).toBeTruthy();
    expect(sql).toContain(`insert into private.provider_deployments values('${CLEANUP_MANIFEST}',\n  '${key}');`);
    expect(sql).not.toContain('insert into private.provider_capacity');
    // The preservation job's expected row matches this SQL, not a copy that could drift.
    const description = /\n {2}'(INACTIVE photo clean-up[^']*)',\n/.exec(sql)?.[1];
    expect(CLEANUP_MANIFEST_ROW).toMatchObject({ id: CLEANUP_MANIFEST, prompt_version: 2, prompt_sha256: cleanup.hashes[0],
      schema_sha256: cleanup.hashes[1], settings_sha256: cleanup.hashes[2], tariff_description: description });
    expect(ENHANCEMENT_MANIFEST_ROW.settings_sha256).toBe(v1.hashes[2]);
  });
});
