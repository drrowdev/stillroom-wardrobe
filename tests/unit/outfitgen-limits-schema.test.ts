import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../../supabase/migrations/', import.meta.url);
const ORIGINAL = '20261106090000_outfit_generation.sql';
const FORWARD = '20261108100000_outfitgen_call_limits.sql';
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const claimBody = (sql: string) => {
  const start = sql.indexOf('function public.outfitgen_claim(');
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start), close = sql.indexOf('$$', open + 2);
  return { header: sql.slice(start, open + 2), body: sql.slice(open + 2, close) };
};

const OLD_BLOCK = `  select count(*) filter (where created_at>v_now-interval '1 hour'),count(*) filter (where created_at>v_now-interval '1 day'),
    count(*) filter (where created_at>v_now-interval '10 minutes') into v_hour,v_day,v_ten
    from private.ai_usage where owner_id=p.owner_id and purpose='outfitgen';
  if v_hour>=6 or v_day>=40 or v_ten>=4 then return jsonb_build_object('code','RATE_LIMIT','claimed',false); end if;
`;
const NEW_BLOCK = `  select count(*) filter (where u.created_at>v_now-interval '1 hour'),count(*) filter (where u.created_at>v_now-interval '1 day'),
    count(*) filter (where u.created_at>v_now-interval '10 minutes') into v_hour,v_day,v_ten
    from private.ai_usage u left join private.outfitgen_requests r on r.owner_id=u.owner_id and r.request_id=u.request_id
    where u.owner_id=p.owner_id and u.purpose='outfitgen' and u.created_at>v_now-interval '1 day'
      and coalesce(r.mode,'manual')=case when p_auto then 'auto' else 'manual' end;
  if (p_auto and (v_hour>=6 or v_day>=40 or v_ten>=4)) or (not p_auto and (v_hour>=120 or v_day>=200 or v_ten>=40))
    then return jsonb_build_object('code','RATE_LIMIT','claimed',false); end if;
`;

describe('outfit claim call limits (OUTFITGEN3-B2; source proofs, the SQL itself runs in the CI rehearsal)', () => {
  it('is the latest claim body with only the rate-limit block replaced', async () => {
    const original = claimBody(await read(ORIGINAL));
    const forward = claimBody(await read(FORWARD));
    expect(original.body).toContain(OLD_BLOCK);
    expect(forward.body.split(NEW_BLOCK)).toHaveLength(2);
    // Everything else (signature, locks, expiry, replay, consent and configuration checks, pending cap, allowance, inserts, response) is identical.
    expect(forward.body.replace(NEW_BLOCK, OLD_BLOCK)).toBe(original.body);
    expect(forward.header).toBe(original.header);
    expect(await read(FORWARD)).toContain('create or replace function public.outfitgen_claim(');
  });

  it('is the only definition after the original and changes nothing else', async () => {
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    const definers: string[] = [];
    for (const name of names) if ((await read(name)).includes('function public.outfitgen_claim(')) definers.push(name);
    expect(definers).toEqual([ORIGINAL, FORWARD, '20261109090000_outfitgen_pending_100.sql']);
    const sql = await read(FORWARD);
    const code = sql.split('\n').filter((line) => !line.startsWith('--')).join('\n');
    expect(code.trimStart().startsWith('begin;')).toBe(true);
    expect(code.trimEnd().endsWith('commit;')).toBe(true);
    expect([...code.matchAll(/^(create|alter|drop|grant|revoke|insert|update|delete)\b/gim)].map((match) => match[1]!.toLowerCase())).toEqual(['create']);
    expect(code.match(/\$\$/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\$mig\$|\$w\$|\r|cron\./);
  });

  it('counts per owner and mode against manual 40 / 120 / 200 and automatic 4 / 6 / 40, never from the allowance', () => {
    expect(NEW_BLOCK).toContain('where u.owner_id=p.owner_id');
    expect(NEW_BLOCK).toContain("coalesce(r.mode,'manual')=case when p_auto then 'auto' else 'manual' end");
    expect(NEW_BLOCK).toContain('(p_auto and (v_hour>=6 or v_day>=40 or v_ten>=4))');
    expect(NEW_BLOCK).toContain('(not p_auto and (v_hour>=120 or v_day>=200 or v_ten>=40))');
    // plpgsql ends an IF condition at its first THEN, so the condition must not contain a CASE expression.
    expect(NEW_BLOCK.slice(NEW_BLOCK.indexOf('  if (p_auto')).split(' then ')[0]).not.toMatch(/\bcase\b/);
    expect(NEW_BLOCK).not.toMatch(/allowance|budget/);
  });

  it('does not touch the original migration', async () => {
    const original = await read(ORIGINAL);
    expect(original).toContain(OLD_BLOCK);
    expect(original).not.toContain('case when p_auto then 6 else 120 end');
  });
});
