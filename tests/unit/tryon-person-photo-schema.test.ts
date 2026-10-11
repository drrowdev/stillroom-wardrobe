import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source pins for TRYON-PHOTO1 (20261011100000). The preservation, deletion and security jobs prove the behaviour against the
// real schema; these checks keep the reviewed contract from drifting: what is stored and who can reach it, the consent
// invariants, and that each replaced function is the 20261004090000 body plus exactly one delta.
const DIR = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string) => readFile(new URL(name, DIR), 'utf8');
const MAIN = '20261011100000_tryon_person_photo.sql';
const STOP = '20261004090000_tryon_stop_before_claim.sql';
const body = (sql: string, head: string) => {
  const from = sql.indexOf(head);
  expect(from, head).toBeGreaterThan(-1);
  expect(sql.indexOf(head, from + 1), head).toBe(-1);
  const to = sql.indexOf('\n$$;', from);
  expect(to, head).toBeGreaterThan(from);
  return sql.slice(from, to + 4);
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');
const PUBLIC_FUNCTIONS = ['tryon_person_photo_status_v1()', 'tryon_person_photo_get_v1()', 'tryon_person_photo_put_v1(text,text)',
  'tryon_person_photo_delete_v1()'];

describe('saved reference photo migration (TRYON-PHOTO1)', () => {
  it('is one LF transaction, directly after the try-on idea migration, with no drop', async () => {
    const sql = await read(MAIN);
    expect(sql.startsWith('-- TRYON-PHOTO1')).toBe(true);
    expect(sql).toContain('\nbegin;\n');
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toContain('\r');
    const names = (await readdir(DIR)).filter((name) => name.endsWith('.sql')).sort();
    const at = names.indexOf(MAIN);
    expect(at).toBeGreaterThan(0);
    expect(names[at - 1]).toBe('20261011090000_tryon_idea.sql');
    expect(sql).not.toMatch(/\bdrop\b/i);
  });

  it('adds one private table: one row per owner, RLS, no grant, no Realtime, cascade with the profile', async () => {
    const sql = await read(MAIN);
    expect([...sql.matchAll(/create table ([a-z_.]+)/g)].map((match) => match[1])).toEqual(['private.tryon_person_photos']);
    expect(sql).toContain(`create table private.tryon_person_photos (
  owner_id uuid primary key references public.profiles(owner_id) on delete cascade,
  jpeg bytea not null check (octet_length(jpeg) between 1 and 512000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  saved_at timestamptz not null,
  check (sha256 = encode(pg_catalog.sha256(jpeg),'hex'))
);`);
    expect(sql).toContain('alter table private.tryon_person_photos enable row level security;');
    expect(sql).toContain('revoke all on private.tryon_person_photos from public,anon,authenticated,service_role;');
    expect(code(sql)).not.toMatch(/\bgrant\b[^;]*tryon_person_photos/i);
    expect(code(sql)).not.toMatch(/publication|create policy/i);
    // It never touches the wardrobe tables, Storage or the garment image rows.
    expect(code(sql.slice(0, sql.indexOf('-- Platform-restore step')))).not.toMatch(/storage\.|public\.item_images|public\.items\b/);
  });

  it('exposes exactly four owner-callable definer functions with an empty search path', async () => {
    const sql = await read(MAIN);
    expect([...sql.matchAll(/create function public\.([a-z_0-9]+)\(/g)].map((match) => match[1]))
      .toEqual(['tryon_person_photo_status_v1', 'tryon_person_photo_get_v1', 'tryon_person_photo_put_v1', 'tryon_person_photo_delete_v1']);
    for (const name of ['status_v1', 'get_v1', 'put_v1', 'delete_v1']) {
      const head = sql.indexOf(`create function public.tryon_person_photo_${name}(`);
      const declaration = sql.slice(head, sql.indexOf('as $$', head));
      expect(declaration, name).toContain('security definer set search_path = \'\'');
    }
    expect(sql).toContain(`revoke all on function public.tryon_person_photo_status_v1(),public.tryon_person_photo_get_v1(),
  public.tryon_person_photo_put_v1(text,text),public.tryon_person_photo_delete_v1()
  from public,anon,authenticated,service_role;`);
    expect(sql).toContain(`grant execute on function public.tryon_person_photo_status_v1(),public.tryon_person_photo_get_v1(),
  public.tryon_person_photo_put_v1(text,text),public.tryon_person_photo_delete_v1() to authenticated;`);
    expect(sql).toContain('revoke all on function private.tryon_person_photo_admit(bytea),private.tryon_person_photo_guard()\n  from public,anon,authenticated,service_role;');
    expect(PUBLIC_FUNCTIONS).toHaveLength(4);
  });

  it('derives ownership from auth.uid() only: no function takes an owner or a photo reference', async () => {
    const sql = await read(MAIN);
    for (const name of ['status_v1', 'get_v1', 'delete_v1']) expect(sql).toContain(`create function public.tryon_person_photo_${name}() returns jsonb`);
    expect(sql).toContain('create function public.tryon_person_photo_put_v1(p_jpeg_base64 text,p_sha256 text) returns jsonb');
    for (const name of ['status_v1', 'get_v1', 'put_v1', 'delete_v1']) {
      const text = body(sql, `create function public.tryon_person_photo_${name}(`);
      expect(text, name).toContain('auth.uid()');
      expect(text, name).not.toMatch(/p_owner|owner_id=p_/);
    }
  });

  it('lets put through only on the locked controls row at notice AND consent revision 2, in the consent lock order', async () => {
    const put = body(await read(MAIN), 'create function public.tryon_person_photo_put_v1(');
    const steps = ['from private.approved_accounts where user_id=auth.uid() for share', 'from public.profiles where owner_id=auth.uid() for update',
      'from private.ai_controls where owner_id=p.owner_id for update', 'v_code := private.tryon_permission(p,c,v_now)',
      "if v_code<>'OK' then return jsonb_build_object('code',v_code)", 'c.tryon_notice_revision is distinct from 2 or c.tryon_consent_revision is distinct from 2',
      "'CONSENT_REQUIRED'", 'length(p_jpeg_base64) not between 8 and 682668', 'decode(p_jpeg_base64,\'base64\')',
      "encode(pg_catalog.sha256(v_bytes),'hex')<>p_sha256", 'private.tryon_person_photo_admit(v_bytes)', 'insert into private.tryon_person_photos'];
    let offset = 0;
    for (const step of steps) {
      const next = put.indexOf(step, offset);
      expect(next, step).toBeGreaterThan(-1);
      offset = next + step.length;
    }
    // Refusals are fixed codes: no input is echoed and no SQL error text leaves the function.
    expect(put).not.toMatch(/raise\s|sqlerrm|format\(/i);
    expect(put).toContain("exception when others then\n    return jsonb_build_object('code','INVALID_INPUT');");
  });

  it('reads and removes for any approved owner, whatever the try-on state', async () => {
    const sql = await read(MAIN);
    for (const name of ['status_v1', 'get_v1']) {
      const text = body(sql, `create function public.tryon_person_photo_${name}(`);
      expect(text, name).toContain('private.is_approved()');
      expect(text, name).not.toMatch(/tryon_permission|tryon_activated|tryon_consent_revision|provider/);
    }
    const remove = body(sql, 'create function public.tryon_person_photo_delete_v1(');
    expect(remove).toContain('private.ai_owner_approved(p.owner_id)');
    expect(remove).not.toMatch(/tryon_permission|tryon_activated|tryon_consent_revision|provider/);
    expect(remove).toContain('delete from private.tryon_person_photos where owner_id=p.owner_id;');
  });

  it('removes the photo in the same statement unless consent and notice are both set and equal', async () => {
    const sql = await read(MAIN);
    const guard = body(sql, 'create function private.tryon_person_photo_guard()');
    expect(guard).toContain('language plpgsql security definer set search_path = \'\'');
    expect(guard).toContain(`if new.tryon_consent_revision is null or new.tryon_notice_revision is null
    or new.tryon_consent_revision<>new.tryon_notice_revision then`);
    expect(guard).toContain('delete from private.tryon_person_photos where owner_id=new.owner_id;');
    expect(sql).toContain(`create trigger ai_controls_tryon_person_photo_guard after update of tryon_consent_revision,tryon_notice_revision
  on private.ai_controls for each row execute function private.tryon_person_photo_guard();`);
  });

  it('moves only the configured notice to revision 2 and never writes consent', async () => {
    const sql = await read(MAIN);
    const updates = [...sql.matchAll(/^update private\.ai_controls[^;]*;/gm)].map((match) => match[0]);
    expect(updates).toEqual(['update private.ai_controls set tryon_notice_revision=2,updated_at=clock_timestamp() where tryon_notice_revision=1;']);
    expect(code(sql)).not.toMatch(/update private\.ai_controls set[^;]*(tryon_consent_revision|tryon_consented_at|tryon_activated)|insert into private\.ai_controls/i);
    // The manifest, its notice-independent hashes and the provider path are untouched.
    expect(code(sql)).not.toMatch(/ai_execution_manifests|provider_deployments|provider_capacity/);
  });

  it('admits only the app\'s own JPEG shape, in one bounded pass with no metadata allowed', async () => {
    const admit = body(await read(MAIN), 'create function private.tryon_person_photo_admit(');
    expect(admit).toContain('language plpgsql immutable set search_path = \'\'');
    for (const text of ['n<4 or n>512000', 'get_byte(p,n-2)<>255 or get_byte(p,n-1)<>217', 'segs>64',
      // One exact JFIF APP0 first; every other APPn and COM segment (EXIF, GPS, thumbnails, comments) is refused.
      'if m=224 then', 'segs<>1 or len<>16', 'else\n      return false;',
      // Exactly one baseline 8-bit 3-component 1024x1280 frame and one 3-component scan.
      'sof or scans>0 or len<>17 or get_byte(p,s)<>8 or get_byte(p,s+5)<>3',
      'get_byte(p,s+1)*256+get_byte(p,s+2)<>1280 or get_byte(p,s+3)*256+get_byte(p,s+4)<>1024',
      'len<>12 or get_byte(p,s)<>3', 'return sof and scans=1 and i+2=n',
      // After SOS only stuffed FF00 and in-order RST markers, and only when a restart interval was declared.
      'if not dri or b<>208+(expected%8) then return false', 'if j<>n-2 then return false',
      // Tables are required and validated: 8-bit non-zero quantisers, Huffman tables 0 and 1 with a legal code space and
      // symbol range, and the frame/scan component ids, selectors and baseline parameters must agree with them.
      '(b>>4)<>0 or (b&15)>3 or j+65>e', 'if get_byte(p,j+k)=0 then return false', 'k>1 or t>1 or j+17>e', 'if code>=(1<<c) then return false',
      'total<1 or total>256 or j+17+total>e', '(k=0 and b>11) or (k=1 and (b&15)>10)', 'cid[c+1] = any(cid[1:c])', 'sampling>10',
      'get_byte(p,e-3)<>0 or get_byte(p,e-2)<>63 or get_byte(p,e-1)<>0', 'get_byte(p,s+1+c*2)<>cid[c+1]',
      '(dcmask&(1<<(tables>>4)))=0 or (acmask&(1<<(tables&15)))=0 or (qmask&(1<<ctq[c+1]))=0']) {
      expect(admit, text).toContain(text);
    }
    expect(admit).not.toMatch(/[ \t]m=(225|226|254)|between 225|between 224/);
  });

  it('replaces exactly two functions, each the 20261004090000 body plus only the named insertion', async () => {
    const sql = await read(MAIN);
    const stop = await read(STOP);
    expect([...sql.matchAll(/create or replace function ([a-z_.]+)\(/g)].map((match) => match[1]))
      .toEqual(['public.tryon_discard_transient', 'private.deletion_owner_rows_absent']);
    const once = (text: string, from: string, to: string) => {
      expect(text.split(from).length - 1, from).toBe(1);
      return text.replace(from, to);
    };
    let discard = body(sql, 'create or replace function public.tryon_discard_transient(');
    discard = once(discard, 'v_c integer; v_s integer; v_p integer; n integer := 0;', 'v_c integer; v_s integer; n integer := 0;');
    discard = once(discard, '  delete from private.tryon_person_photos;\n  get diagnostics v_p = row_count;\n', '');
    discard = once(discard, "'stopsDeleted',v_s,'photosDeleted',v_p,'expired',n);", "'stopsDeleted',v_s,'expired',n);");
    expect(discard).toBe(body(stop, 'create or replace function public.tryon_discard_transient('));
    const absent = once(body(sql, 'create or replace function private.deletion_owner_rows_absent('),
      '\n    or exists(select 1 from private.tryon_person_photos where owner_id=p_owner));', ');');
    expect(absent).toBe(body(stop, 'create or replace function private.deletion_owner_rows_absent('));
    // Nothing else of the try-on chain machinery is redefined here.
    expect(sql).not.toMatch(/create (or replace )?function public\.tryon_(claim|dispatch|finish|status|set_consent|bootstrap|cancel)/);
  });

  it('proves its own postconditions before the commit', async () => {
    const sql = await read(MAIN);
    const post = sql.slice(sql.lastIndexOf('do $$'));
    for (const text of ['the photo table is not private', 'is callable by an API role', 'a configured account is still at notice revision 1']) {
      expect(post, text).toContain(text);
    }
  });
});
