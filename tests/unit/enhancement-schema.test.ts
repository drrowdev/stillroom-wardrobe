import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source pins for BG2b-1 (plan rev3 with R1-R4 and Q6 binding). The CI database, integration and security jobs prove
// the migration applies and behaves; these checks keep the reviewed contract from drifting.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20260929090000_photo_enhancement.sql';
const between = (sql: string, start: string, end: string) => {
  const from = sql.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  const to = sql.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return sql.slice(from, to);
};

describe('photo enhancement migration (BG2b-1)', () => {
  it('stays one transaction and redefines no existing writer, tagging or stylist function', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- BG2b-1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const replaced = [...sql.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((match) => match[1]);
    expect(replaced).toEqual(['private.deletion_owner_rows_absent']);
    for (const name of ['reserve_restored_item_save(', 'reserve_image_change(', 'reserve_image_recovery(', 'reserve_item_save(',
      'stylist_claim(', 'stylist_finish(', 'stylist_expire(', 'stylist_direct_allocation(', 'ai_finish_analysis(', 'ai_claim_analysis(']) {
      expect(sql, name).not.toMatch(new RegExp(`create (or replace )?function [a-z]+\\.${name.replace('(', '\\(')}`));
    }
    expect(sql).not.toMatch(/\bdrop (function|table|trigger)\b/);
    expect(sql).not.toMatch(/alter table private\.ai_usage_evidence drop constraint/);
  });

  it('R1: gives enhancement its own settlement storage and leaves the stylist pairing untouched', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain("check (purpose in ('analysis','stylist','enhancement'))");
    expect(sql).toContain('ai_usage_evidence_enhance_pair check ((enhance_code is null) = (enhance_settlement_origin is null))');
    expect(sql).toContain('ai_usage_evidence_one_outcome check (stylist_code is null or (enhance_code is null and enhance_input_sha256 is null))');
    expect(sql).not.toMatch(/(?<![a-z_])(stylist_code|settlement_origin)\s*=/);
    const finish = between(sql, 'create function public.enhance_finish(', '\n$$;');
    expect(finish).not.toMatch(/stylist/);
    expect(finish).toContain("enhance_settlement_origin='observed'");
    expect(finish).toContain("enhance_settlement_origin='terminal_anomaly'");
    expect(finish).toContain("enhance_settlement_origin='unmetered'");
    const expire = between(sql, 'create function private.enhance_expire(', '\n$$;');
    expect(expire).toContain("purpose='enhancement'");
    expect(expire).toContain("enhance_settlement_origin='provisional_expiry'");
    const claim = between(sql, 'create function public.enhance_claim(', '\n$$;');
    expect(claim).toContain('s.total_hour>=c.max_requests_per_hour');
    expect(claim).toContain('s.enhance_hour>=c.enhance_max_requests_per_hour');
    expect(claim).toContain('s.total_micro+c.enhance_max_request_micro>c.monthly_allowance_micro');
    expect(claim).toContain('s.enhance_micro+c.enhance_max_request_micro>c.enhance_monthly_allowance_micro');
    expect(claim).toContain('private.enhance_probe_permission(p,c,a,v_now)');
  });

  it('R1: clamps the enhancement sub-limit in a non-recursive BEFORE UPDATE', async () => {
    const sql = await read(MAIN);
    const clamp = between(sql, 'create function private.enhance_allowance_clamp()', '\n$$;');
    expect(clamp).not.toMatch(/\bupdate\b/i);
    expect(clamp).toContain('new.enhance_monthly_allowance_micro := new.monthly_allowance_micro;');
    expect(sql).toContain('create trigger ai_controls_enhance_clamp before update of monthly_allowance_micro on private.ai_controls');
  });

  it('M2/N5: keys capacity by deployment and starts with dispatch off; slots carry no owner', async () => {
    const sql = await read(MAIN);
    const slots = between(sql, 'create table private.provider_slots (', ');');
    expect(slots).not.toMatch(/owner|request/);
    expect(sql).toContain("values('stillroom-ai-eval/eval-image25-sunburst-20260908/2026-09-08',60,2,false,'INITIAL',clock_timestamp());");
    const finish = between(sql, 'create function public.enhance_finish(', '\n$$;');
    expect(finish).toContain("update private.provider_capacity set dispatch_enabled=false,disabled_reason='USAGE_ANOMALY'");
    expect(finish).toMatch(/update private\.ai_controls set enhance_activated=false,updated_at=v_now where owner_id=p_owner_id/);
    expect(finish).not.toMatch(/update private\.ai_controls set[^;]*where (?!owner_id=p_owner_id)/);
    const absent = between(sql, 'create or replace function private.deletion_owner_rows_absent(', '\n$$;');
    expect(absent).not.toMatch(/provider_slots|provider_capacity/);
  });

  it('R2: snapshots the complete provenance payload into the binding at reservation', async () => {
    const sql = await read(MAIN);
    const admission = between(sql, 'create function private.enhancement_admission()', '\n$$;');
    expect(admission).toContain("values(new.owner_id,new.id,'copy',s.image_id,s.origin,s.request_id,s.import_id,s.model_id,s.manifest_id,");
    expect(admission).toContain('e.usable_until>clock_timestamp()');
    expect(admission).toContain("raise exception using errcode='22023',message='Enhancement expired'");
    expect(admission.indexOf("'copy'")).toBeLessThan(admission.indexOf("'evidence'"));
    expect(admission).not.toMatch(/update public\.|new\.[a-z_]+\s*:=/);
    const attach = between(sql, 'create function private.enhancement_attach()', '\n$$;');
    expect(attach).not.toMatch(/image_enhancements|public\.item_images x where x\.id=b\.source_image_id/);
  });

  it('R3/Q6: marks restored images with an immutable mode and requires byte-preserved imported provenance', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain("mode text not null check (mode in ('legacy','v4','unlabelled'))");
    expect(sql).toContain('create trigger restore_image_markers_immutable before update on private.restore_image_markers');
    expect(sql).toContain('constraint image_provenance_byte_preserved check (backup_sha256 is null or backup_sha256=stored_sha256)');
    const marker = between(sql, 'create function private.restore_marker(', '\n$$;');
    expect(marker).toContain("im.state<>'pending'");
    expect(marker).toContain('delete from private.image_enhancement_bindings where owner_id=p_owner and image_id=p_image;');
    const provenance = between(sql, 'create function public.restore_image_provenance(', '\n$$;');
    expect(provenance).toContain("p_entry->>'backup_sha256'<>k.restored_sha256");
    expect(provenance).toContain("mode='v4'");
    expect(provenance).toContain("im.state<>'ready'");
    expect(sql).not.toMatch(/re-?encod[a-z]*[^\n]*provenance[^\n]*=|source_sha256/);
  });

  it('R4: attaches only on the pending -> ready publication and never reads the attempt row', async () => {
    const sql = await read(MAIN);
    expect(sql).toContain("create trigger item_images_enhancement_attach after update of state on public.item_images\n"
      + "for each row when (old.state='pending' and new.state='ready') execute function private.enhancement_attach();");
    const attach = between(sql, 'create function private.enhancement_attach()', '\n$$;');
    expect(attach).not.toMatch(/attempts|completed/);
    expect(attach).not.toMatch(/update public\.item_images|insert into public\.item_images/);
    expect(sql.match(/create trigger [a-z_]+ [^\n]* on public\.item_images/g)).toHaveLength(2);
  });

  it('N1: adds versioned restore-only writers around the unchanged v1 writers', async () => {
    const sql = await read(MAIN);
    const save = between(sql, 'create function public.reserve_restored_item_save_v2(', '\n$$;');
    expect(save.indexOf('private.restore_marker(')).toBeLessThan(save.indexOf('public.reserve_restored_item_save(p_item,p_image)'));
    const change = between(sql, 'create function public.reserve_restored_image_change(', '\n$$;');
    expect(change).toContain("p_intent->'claim' is distinct from 'null'::jsonb or p_intent->'sourceImageId' is distinct from 'null'::jsonb");
    expect(change.indexOf('private.restore_marker(')).toBeLessThan(change.indexOf('public.reserve_image_change(p_intent)'));
    for (const body of [save, change]) {
      expect(body).toContain("set search_path = '' set lock_timeout = '2s'");
      expect(body.indexOf('private.image_change_lock(u)')).toBeLessThan(body.indexOf('private.restore_marker('));
    }
  });

  it('pins the ACLs: owner RPCs to authenticated, three to service_role, control and expiry to nobody', async () => {
    const sql = await read(MAIN);
    const grants = [...sql.matchAll(/grant execute on function ([^;]+) to ([a-z_]+);/g)]
      .map((match) => [match[2], match[1]!.replace(/\s+/g, '')]);
    expect(grants).toEqual([
      ['authenticated', 'public.reserve_restored_item_save_v2(jsonb,jsonb,uuid,text),public.reserve_restored_image_change(jsonb,uuid,text),'
        + 'public.restore_image_provenance(uuid,uuid,uuid,jsonb),public.image_provenance_v1(),public.image_provenance_digest_v1(),'
        + 'public.enhance_status(),public.enhance_set_consent(boolean,integer)'],
      ['service_role', 'public.enhance_claim(uuid,uuid,text,text,uuid),public.enhance_finish(uuid,uuid,text,jsonb,text,integer),'
        + 'public.enhance_probe_authorise(uuid,uuid,text,integer,bigint,text,timestamptz)'],
    ]);
    expect(sql).not.toMatch(/grant execute[^;]*(enhance_provider_control|enhance_expire_due)/);
    expect(sql).not.toMatch(/grant[^;]* on (table )?private\./);
    for (const table of ['provider_capacity', 'provider_deployments', 'provider_slots', 'image_enhancements', 'enhancement_outputs',
      'image_provenance', 'image_enhancement_bindings', 'restore_image_markers', 'enhancement_probe_authorisations']) {
      expect(sql).toContain(`alter table private.${table} enable row level security;`);
    }
    for (const match of sql.matchAll(/create (?:or replace )?function [^$]+?\$\$/g)) {
      expect(match[0], match[0].slice(0, 80)).toContain("set search_path = ''");
    }
  });

  it('lists every new owner table in the deletion absence check', async () => {
    const sql = await read(MAIN);
    const absent = between(sql, 'create or replace function private.deletion_owner_rows_absent(', '\n$$;');
    for (const match of sql.matchAll(/create table (private\.[a-z_]+) \(\n {2}owner_id uuid/g)) {
      expect(absent, match[1]).toContain(`from ${match[1]} where owner_id=p_owner`);
    }
  });
});

describe('enhancement expiry schedule migration (BG2b-1)', () => {
  const JOB = "cron.schedule('stillroom-enhance-expire', '*/5 * * * *', 'select public.enhance_expire_due(500)')";
  it('schedules exactly one fixed, bounded, inactive job after its guards', async () => {
    const sql = await read('20260929090100_enhance_expire_schedule.sql');
    expect(sql.match(/cron\.schedule\('/g)).toHaveLength(1);
    expect(sql).toContain(`perform cron.alter_job(\n    ${JOB},\n    active := false);`);
    expect(sql).not.toMatch(/active\s*:=\s*true|cron\.(unschedule|schedule_in_database)\b|\bgrant\b|\brevoke\b|create extension/);
    const schedule = sql.indexOf('perform cron.alter_job(');
    for (const guard of ["if current_user <> 'postgres' or current_database() <> 'postgres' then",
      "has_schema_privilege('anon', 'cron', 'USAGE')",
      "if exists (select 1 from cron.job where jobname = 'stillroom-enhance-expire') then"]) {
      expect(sql.indexOf(guard), guard).toBeGreaterThan(-1);
      expect(sql.indexOf(guard), guard).toBeLessThan(schedule);
    }
  });

  it('keeps the scheduled expiry bounded', async () => {
    const body = between(await read(MAIN), 'create function public.enhance_expire_due(', '\n$$;');
    expect(body).toMatch(/p_limit is null or p_limit<1 or p_limit>1000/);
  });
});
