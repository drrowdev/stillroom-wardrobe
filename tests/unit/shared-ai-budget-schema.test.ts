import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// BUDGET1 source checks on 20261010090000: same-signature replacement and the header-selected contract. These read SQL text;
// the behaviour is proven by the CI-only shared-budget integration suite, not here.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const NEW = '20261010090000_shared_ai_budget.sql';
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const PUBLIC_NAMES = ['ai_status', 'ai_set_consent', 'stylist_status', 'enhance_status', 'tryon_status', 'stylist_set_consent', 'enhance_set_consent',
  'tryon_set_consent', 'stylist_claim', 'enhance_claim', 'tryon_claim', 'enhance_probe_authorise', 'tryon_probe_authorise',
  'tryon_bootstrap', 'stylist_direct_allocation', 'admin_ai_spending', 'admin_set_ai_limits', 'admin_ai_spending_v2',
  'admin_set_ai_limits_v2'];

// "(args) returns type" of the last definition of public.<name> in the given source.
function signature(sql: string, name: string): string | null {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\(([^)]*)\\)\\s*returns\\s+(\\w+)`, 'gi');
  let found: string | null = null;
  for (const match of sql.matchAll(pattern)) found = `${(match[1] ?? '').replace(/\s+/g, ' ').trim().toLowerCase()} -> ${(match[2] ?? '').toLowerCase()}`;
  return found;
}
const body = (sql: string, name: string) => {
  const start = sql.indexOf(`function public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return sql.slice(start, sql.indexOf('\n$$;', start));
};

describe('BUDGET1 migration source', () => {
  it('replaces the existing public functions with identical arguments and returns, and adds none', async () => {
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    expect(names.at(-1)).toBe(NEW);
    const sql = await read(NEW);
    expect(sql).not.toMatch(/create function public\./i);
    const prior = (await Promise.all(names.slice(0, -1).map(read))).join('\n');
    for (const name of PUBLIC_NAMES) {
      const before = signature(prior, name);
      expect(before, name).not.toBeNull();
      expect(signature(sql, name), name).toBe(before);
    }
    const defined = [...sql.matchAll(/create or replace function public\.(\w+)\(/gi)].map((match) => match[1]).sort();
    expect(defined).toEqual([...PUBLIC_NAMES].sort());
  });

  it('selects the contract by the exact request header and keeps one transaction', async () => {
    const sql = await read(NEW);
    expect(sql).toContain(`->>'x-stillroom-ai-budget-contract','')='2'`);
    expect(sql.match(/^begin;$/gm)).toHaveLength(1);
    expect(sql.match(/^commit;$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/'RATE_LIMIT'/);
    for (const name of ['stylist_status', 'enhance_status', 'tryon_status']) {
      expect(body(sql, name), name).toContain(`if not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;`);
    }
    expect(body(sql, 'ai_status')).toContain('if not private.ai_budget_contract() then');
  });

  it('refuses enabling before any change without the header, and never gates withdrawal', async () => {
    const sql = await read(NEW);
    for (const name of ['stylist_set_consent', 'enhance_set_consent', 'tryon_set_consent']) {
      const text = body(sql, name);
      const gate = text.indexOf('if p_enabled and not private.ai_budget_contract() then return jsonb_build_object(\'code\',\'UNAVAILABLE\'); end if;');
      expect(gate, name).toBeGreaterThanOrEqual(0);
      expect(gate, name).toBeLessThan(text.indexOf('update private.ai_controls'));
      expect(text.match(/ai_budget_contract/g), name).toHaveLength(1);
    }
  });

  it('gates analysis consent the same way: enabling needs the header before any change, withdrawal does not', async () => {
    const text = body(await read(NEW), 'ai_set_consent');
    const gate = text.indexOf('if p_enabled is true and not private.ai_budget_contract() then return jsonb_build_object(\'code\',\'UNAVAILABLE\'); end if;');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(text.indexOf('update public.profiles'));
    expect(text.match(/ai_budget_contract/g)).toHaveLength(1);
  });

  it('keeps the try-on withdrawal chain cancellation exactly as before', async () => {
    const sql = await read(NEW), old = await read('20261003090000_try_on.sql');
    const loop = (text: string) => text.slice(text.indexOf('for v_chain in select chain_id from private.tryon_chains'),
      text.indexOf('end loop;', text.indexOf('for v_chain in select chain_id from private.tryon_chains')) + 'end loop;'.length);
    expect(loop(body(sql, 'tryon_set_consent')).replace(/\s+/g, ' ')).toBe(loop(body(old, 'tryon_set_consent')).replace(/\s+/g, ' '));
  });

  it('enforces the one shared sum in every claim, with no hourly or feature-money term', async () => {
    const sql = await read(NEW);
    for (const name of ['stylist_claim', 'enhance_claim', 'tryon_claim']) {
      const text = body(sql, name);
      expect(text, name).toContain('private.ai_budget_used(');
      expect(text, name).toContain('monthly_allowance_micro');
      expect(text, name).not.toMatch(/max_requests_per_hour|interval '1 hour'|stylist_monthly_allowance|enhance_monthly_allowance|tryon_monthly_allowance|enhance_usage\(|tryon_usage\(|stylist_usage\(/);
    }
    expect(body(sql, 'tryon_claim')).toContain('BUSY');
    expect(body(sql, 'enhance_claim')).toContain(`return jsonb_build_object('code','BUSY','claimed',false)`);
  });

  it('on-ledger probe authorisations fit the budget without subtracting an allocation again', async () => {
    const sql = await read(NEW);
    for (const name of ['enhance_probe_authorise', 'tryon_probe_authorise']) {
      const text = body(sql, name);
      expect(text, name).toContain('v_used+p_allocation_micro>c.monthly_allowance_micro');
      expect(text, name).not.toMatch(/allocation_micro\)\s*from private\.(enhancement|tryon)_probe_authorisations/i);
      expect(text, name).not.toMatch(/monthly_allowance_micro\s*=/);
    }
    // The operator's direct-call allocation is the one separate subtraction, and it reads no stylist sub-limit.
    const allocation = body(sql, 'stylist_direct_allocation');
    expect(allocation).toContain('v_new := c.monthly_allowance_micro-p_allocation_micro;');
    expect(allocation).not.toContain('stylist_monthly_allowance_micro');
  });

  it('keeps money rules: positive amounts, USD 50 ceiling, below-usage accepted, no money table or carry-forward', async () => {
    const sql = await read(NEW);
    expect(sql).toContain('if v_new<=0 then');
    expect(sql).toContain('if v_new>50000000 then');
    expect(sql).toContain(`'belowUse',v_used>c.monthly_allowance_micro::numeric`);
    expect(sql).not.toMatch(/create table/i);
    expect(sql).toContain(`period=to_char(p_now at time zone 'UTC','YYYY-MM')`);
    expect(sql).toContain(`charge_state in ('reserved','held')`);
  });

  it('keeps the v1 admin pair fail-closed and the v2 pair header-gated', async () => {
    const sql = await read(NEW);
    for (const name of ['admin_ai_spending', 'admin_set_ai_limits']) {
      expect(body(sql, name)).toContain(`return jsonb_build_object('code','UNAVAILABLE');`);
    }
    expect(body(sql, 'admin_ai_spending_v2')).toContain('not private.ai_budget_contract()');
    expect(sql).toContain(`if v_actor is null or not private.ai_budget_contract() then return jsonb_build_object('code','UNAVAILABLE'); end if;`);
  });

  it('revokes every new private helper from the API roles', async () => {
    const sql = await read(NEW);
    for (const helper of ['ai_budget_contract()', 'ai_budget_used(uuid,timestamptz)', 'ai_budget_json(bigint,numeric)',
      'admin_account_v3(private.approved_accounts,timestamptz,text[])', 'admin_budget_shape(jsonb)',
      'admin_set_budget(smallint,text,jsonb,jsonb,text)']) {
      expect(sql, helper).toContain(`private.${helper}`);
    }
    expect(sql.match(/from public,anon,authenticated,service_role;/g)).toHaveLength(2);
  });
});
