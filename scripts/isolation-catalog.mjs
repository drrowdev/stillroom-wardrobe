// I17 owner-isolation catalogue: expected inventory, pure validators and a closed privileged CLI.
// The CLI accepts only `catalog`, `freeze A|B` and `restore A|B`; it never accepts SQL or identities.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  ROOT, DB_CONTAINER, PROJECT_ID, TEST_EMAILS, assertLocalApi, assertNoServiceSecrets,
  commandEnvironment, requireDocker, runCommand, fail, reportError,
} from './backend/local.mjs';
import { isMain } from './quality/files.mjs';

const fn = (name, args, params) => Object.freeze({ name, args, params: Object.freeze(params) });

// Authenticated PostgREST RPCs in the exposed `public` schema (types as rendered by oidvectortypes).
export const EXPOSED_RPCS = Object.freeze([
  fn('commit_image', 'uuid', ['p_image_id']),
  fn('retire_image', 'uuid', ['p_image_id']),
  fn('forget_image', 'uuid', ['p_image_id']),
  fn('save_outfit', 'uuid, text, text, text, boolean, uuid[], bigint',
    ['p_id', 'p_title', 'p_occasion', 'p_notes', 'p_favourite', 'p_item_ids', 'p_expected_version']),
  fn('save_wear_event', 'uuid, date, text, text, text, uuid, uuid[], bigint',
    ['p_id', 'p_local_date', 'p_timezone', 'p_state', 'p_label', 'p_outfit_id', 'p_item_ids', 'p_expected_version']),
  fn('export_manifest', 'uuid', ['p_export_id']),
  fn('restore_history_entry', 'uuid, uuid, uuid, text, text, uuid',
    ['p_id', 'p_event_id', 'p_item_id', 'p_title', 'p_category', 'p_import_id']),
  fn('update_image_description', 'uuid, bigint, text', ['p_image_id', 'p_expected_description_version', 'p_alt_text']),
  fn('ai_status', '', []),
  fn('ai_set_consent', 'boolean, integer, bigint', ['p_enabled', 'p_notice_revision', 'p_expected_version']),
  fn('ai_begin_request', 'uuid, uuid, integer, text', ['p_request_id', 'p_draft_id', 'p_generation', 'p_image_sha256']),
  fn('ai_request_control', 'uuid, text', ['p_request_id', 'p_action']),
  fn('ai_analysis_status', 'uuid', ['p_request_id']),
  fn('reserve_item_save', 'jsonb, jsonb', ['p_item', 'p_image']),
  fn('finalize_item_save', 'uuid, uuid, text', ['p_item_id', 'p_image_id', 'p_fingerprint']),
  fn('reserve_analyzed_item_save', 'jsonb, jsonb, jsonb', ['p_item', 'p_image', 'p_claim']),
  fn('analyzed_item_save_preflight', 'uuid, uuid, text', ['p_item_id', 'p_image_id', 'p_fingerprint']),
  fn('cancel_analyzed_item_save', 'uuid, uuid, text', ['p_item_id', 'p_image_id', 'p_fingerprint']),
  fn('item_attribution_history', 'uuid', ['p_item_id']),
  fn('set_item_trashed', 'uuid, bigint, boolean', ['p_item_id', 'p_expected_version', 'p_trashed']),
  fn('item_deletion_status', 'uuid[]', ['p_item_ids']),
  fn('begin_item_deletion', 'uuid, bigint, uuid, text', ['p_item_id', 'p_expected_version', 'p_request_id', 'p_image_manifest_sha256']),
  fn('finish_item_deletion', 'uuid, uuid', ['p_item_id', 'p_request_id']),
  fn('reserve_image_change', 'jsonb', ['p_intent']),
  fn('image_change_status', 'uuid, uuid', ['p_item_id', 'p_request_id']),
  fn('image_change_requests', 'uuid', ['p_item_id']),
  fn('image_recovery_versions', 'uuid, uuid', ['p_item_id', 'p_after']),
  fn('image_recovery_preflight', 'jsonb', ['p_intent']),
  fn('image_change_preflight', 'jsonb', ['p_intent']),
  fn('cancel_image_change', 'uuid, uuid', ['p_item_id', 'p_request_id']),
  fn('item_deletion_operation_status', 'uuid, uuid', ['p_item_id', 'p_request_id']),
  fn('item_deletion_operations', 'uuid[]', ['p_item_ids']),
  fn('prepare_item_deletion', 'uuid, uuid, bigint, text', ['p_item_id', 'p_request_id', 'p_expected_version', 'p_image_manifest_sha256']),
  fn('inventory_item_deletion', 'uuid, uuid', ['p_item_id', 'p_request_id']),
  fn('cancel_item_deletion_preparation', 'uuid, uuid', ['p_item_id', 'p_request_id']),
  fn('authorize_item_deletion', 'uuid, uuid, text', ['p_item_id', 'p_request_id', 'p_inventory_hash']),
  fn('item_deletion_next_target', 'uuid, uuid', ['p_item_id', 'p_request_id']),
  fn('reconcile_item_deletion_target', 'uuid, uuid, bigint', ['p_item_id', 'p_request_id', 'p_ordinal']),
  fn('begin_prepared_item_deletion', 'uuid, uuid', ['p_item_id', 'p_request_id']),
]);

// Public functions reachable only with service credentials (Edge/operator); normal sessions must be denied.
export const SERVICE_ONLY_RPCS = Object.freeze([
  fn('deletion_control', 'uuid, text, text', ['p_owner_id', 'p_action', 'p_code']),
  fn('ai_mark_dispatched', 'uuid, uuid', ['p_owner_id', 'p_request_id']),
  fn('ai_settle_request', 'uuid, uuid, jsonb, bigint, text', ['p_owner_id', 'p_request_id', 'p_facts', 'p_billed_micro', 'p_code']),
  fn('ai_purge_expired', 'integer', ['p_limit']),
  fn('ai_claim_analysis', 'uuid, uuid, uuid, integer, text, integer, integer, integer, text',
    ['p_owner_id', 'p_request_id', 'p_draft_id', 'p_generation', 'p_image_sha256', 'p_byte_count', 'p_width', 'p_height', 'p_manifest_id']),
  fn('ai_finish_analysis', 'uuid, uuid, text, jsonb, jsonb, text',
    ['p_owner_id', 'p_request_id', 'p_manifest_id', 'p_facts', 'p_usage', 'p_code']),
  fn('complete_analyzed_item_save', 'uuid, uuid, uuid, text, jsonb', ['p_owner_id', 'p_item_id', 'p_image_id', 'p_fingerprint', 'p_objects']),
  fn('reserve_image_recovery', 'uuid, jsonb, jsonb', ['p_owner_id', 'p_intent', 'p_objects']),
  fn('complete_image_change', 'uuid, jsonb, jsonb', ['p_owner_id', 'p_intent', 'p_objects']),
]);

// Private helpers that RLS/Storage policies evaluate as `authenticated`; their bodies are pinned to migrations.
export const POLICY_HELPERS = Object.freeze([
  { name: 'is_approved', args: '' },
  { name: 'owns_storage_path', args: 'text, boolean' },
  { name: 'may_delete_storage', args: 'text' },
  { name: 'may_create_item_object', args: 'text' },
]);

export const PRIVATE_INTERNAL = Object.freeze([
  'check_admission()', 'finish_admission()', 'check_email_change()', 'feedback_signature()', 'remove_item_feedback()',
  'wear_snapshot()', 'touch_record()', 'valid_timezone()', 'item_field_provenance()',
  'ai_owner_approved(uuid)', 'ai_permission(public.profiles, private.ai_controls)', 'ai_valid_facts(jsonb)',
  'ai_result(private.ai_requests, jsonb)', 'ai_close(uuid, uuid, text, timestamp with time zone)',
  'ai_expire(uuid, timestamp with time zone, integer)', 'ai_manifest_immutable()',
  'ai_begin_owner(uuid, uuid, uuid, integer, text)',
  'ai_analysis_permitted(public.profiles, private.ai_controls, private.ai_requests, timestamp with time zone)',
  'ai_accounting(private.ai_usage)', 'ai_settle_core(uuid, uuid, jsonb, bigint, text)', 'ai_normal_usage(jsonb)',
  'ai_finish_google_legacy(uuid, uuid, text, jsonb, jsonb, text)',
  'item_save_fingerprint(public.items, public.item_images)', 'item_save_owner()',
  'item_save_current(uuid, uuid, uuid, text)', 'commit_item_save_image(uuid)', 'item_save_value_hash(public.items)',
  'reserve_item_save(jsonb, jsonb, text[])', 'finalize_manual_item_save(uuid, uuid, text)',
  'analyzed_item_save_current(uuid, uuid, uuid, text)', 'reserve_analyzed_item_save_v10(jsonb, jsonb, jsonb)',
  'record_item_image_identity()', 'item_lifecycle_manifest(jsonb)', 'item_lifecycle_owner()', 'guard_item_deletion()',
  'guard_item_image_deletion()', 'guard_item_object_publication()', 'finish_item_deletion_v9(uuid, uuid)',
  'image_change_hash(jsonb)', 'image_change_lock(uuid, boolean, boolean)', 'image_change_fenced(uuid, uuid)',
  'consume_image_change_context(uuid, uuid, uuid, text, bigint, jsonb, jsonb)', 'guard_image_change_item()',
  'guard_image_change_image()', 'image_change_intent(uuid, jsonb)', 'image_change_objects(uuid, public.item_images)',
  'image_change_receipt(private.image_change_attempts)', 'reserve_image_change(uuid, jsonb, jsonb)',
  'item_deletion_target_supported(uuid, uuid, text)', 'item_deletion_receipt(private.item_deletion_operations)',
  'item_deletion_inventory_valid(private.item_deletion_operations)',
]);

// Supabase-provided GraphQL entrypoint; its privileges are provider-managed and recorded, not asserted.
export const PROVIDER_FUNCTIONS = Object.freeze(['graphql_public.graphql(text, text, jsonb, jsonb)']);

const SIUD = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
export const PUBLIC_TABLES = Object.freeze({
  profiles: { table: ['SELECT'], columns: { UPDATE: ['owner_id', 'display_name', 'ui_language', 'timezone', 'currency',
    'weather_enabled', 'weather_city', 'latitude', 'longitude', 'created_at', 'updated_at', 'version'] } },
  style_preferences: { table: SIUD, columns: {} },
  items: { table: SIUD, columns: {} },
  item_images: { table: ['SELECT'], columns: { INSERT: ['id', 'owner_id', 'item_id', 'main_bytes', 'thumb_bytes',
    'main_sha256', 'thumb_sha256', 'width', 'height', 'alt_text'] } },
  outfits: { table: SIUD, columns: {} },
  outfit_items: { table: SIUD, columns: {} },
  wear_events: { table: SIUD, columns: {} },
  wear_event_items: { table: ['DELETE', 'SELECT'], columns: { INSERT: ['id', 'owner_id', 'event_id', 'item_id',
    'title_snapshot', 'category_snapshot'] } },
  combination_rules: { table: SIUD, columns: {} },
  suggestion_feedback: { table: SIUD, columns: {} },
});
export const PRIVATE_TABLES = Object.freeze([
  'approved_accounts', 'deletion_jobs', 'ai_controls', 'ai_usage', 'ai_requests', 'item_save_used_ids',
  'item_save_attempts', 'ai_execution_manifests', 'ai_usage_evidence', 'ai_analysis_attestations',
  'ai_save_used_receipts', 'ai_item_save_attempts', 'ai_item_save_context', 'item_attribution_history',
  'item_image_used_ids', 'item_deletion_claims', 'image_change_attempts', 'image_change_context',
  'image_change_history', 'item_deletion_operations', 'item_deletion_targets',
]);
const OWNER_EXPRESSION = '(private.is_approved() AND (owner_id = ( SELECT auth.uid() AS uid)))';
export const OWNER_POLICIES = Object.freeze([
  { name: 'owner_create', cmd: 'INSERT', qual: null, check: OWNER_EXPRESSION },
  { name: 'owner_delete', cmd: 'DELETE', qual: OWNER_EXPRESSION, check: null },
  { name: 'owner_read', cmd: 'SELECT', qual: OWNER_EXPRESSION, check: null },
  { name: 'owner_update', cmd: 'UPDATE', qual: OWNER_EXPRESSION, check: OWNER_EXPRESSION },
]);
export const STORAGE_POLICIES = Object.freeze([
  { name: 'wardrobe_create', cmd: 'INSERT', qual: null,
    check: "((bucket_id = 'wardrobe'::text) AND private.may_create_item_object(name))" },
  { name: 'wardrobe_delete', cmd: 'DELETE', check: null,
    qual: "((bucket_id = 'wardrobe'::text) AND private.may_delete_storage(name) AND storage.allow_only_operation('storage.object.delete'::text))" },
  { name: 'wardrobe_read', cmd: 'SELECT', check: null,
    qual: "((bucket_id = 'wardrobe'::text) AND (private.owns_storage_path(name, false) OR (private.may_delete_storage(name) AND storage.allow_only_operation('storage.object.delete'::text))))" },
]);
// Account-relationship vocabulary. GraphQL Connection/Edge pagination types are not relationships.
export const RELATIONSHIP_NAMES = /recipient|household|partner|share|friend|follow|member|peer|invite|contact|guest|directory/i;
const ROLES = ['public', 'anon', 'authenticated'];

export const signature = (schema, name, args) => `${schema}.${name}(${args})`;
export function expectedFunctions() {
  const result = new Map();
  for (const f of EXPOSED_RPCS) result.set(signature('public', f.name, f.args), { kind: 'exposed', public: false, anon: false, authenticated: true });
  for (const f of SERVICE_ONLY_RPCS) result.set(signature('public', f.name, f.args), { kind: 'service', public: false, anon: false, authenticated: false });
  for (const f of POLICY_HELPERS) result.set(signature('private', f.name, f.args), { kind: 'helper', public: false, anon: false, authenticated: true });
  for (const entry of PRIVATE_INTERNAL) result.set(`private.${entry}`, { kind: 'internal', public: false, anon: false, authenticated: false });
  for (const entry of PROVIDER_FUNCTIONS) result.set(entry, { kind: 'provider' });
  return result;
}

const compact = (value) => (value === null || value === undefined ? null : String(value).replace(/\s+/g, ''));
const clip = (value) => String(value).slice(0, 240);
const sorted = (values) => [...values].sort();

/** Validates a read-only catalogue snapshot. Returns a list of problems; empty means verified. */
export function validateCatalog(snapshot, helperMd5 = {}) {
  const problems = [];
  const need = (condition, message) => { if (!condition) problems.push(clip(message)); };
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return ['snapshot is not an object'];
  for (const key of ['functions', 'relations', 'policies', 'schemas', 'buckets', 'storage', 'foreignKeys', 'publications']) {
    if (!Object.hasOwn(snapshot, key)) problems.push(`snapshot lacks ${key}`);
  }
  if (problems.length) return problems;

  const expected = expectedFunctions(), seen = new Set();
  for (const f of snapshot.functions) {
    const key = signature(f.schema, f.name, f.args);
    need(!seen.has(key), `duplicate function ${key}`); seen.add(key);
    const want = expected.get(key);
    if (!want) { problems.push(clip(`unexpected function ${key}`)); continue; }
    need(f.kind === 'f', `${key} is not a plain function`);
    need(f.extension === false, `${key} is extension-owned`);
    if (want.kind !== 'provider') {
      for (const role of ROLES) need(f[role] === want[role], `${key} EXECUTE for ${role} is ${f[role]}, expected ${want[role]}`);
    }
    if (want.kind === 'helper') {
      const name = key.slice('private.'.length, key.indexOf('('));
      need(typeof helperMd5[name] === 'string' && f.md5 === helperMd5[name], `${key} body differs from its latest migration`);
    }
  }
  for (const key of expected.keys()) need(seen.has(key), `missing function ${key}`);

  const tables = new Map([...Object.keys(PUBLIC_TABLES).map((t) => [`public.${t}`, PUBLIC_TABLES[t]]),
    ...PRIVATE_TABLES.map((t) => [`private.${t}`, { table: [], columns: {} }])]);
  const relationSeen = new Set();
  for (const r of snapshot.relations) {
    const key = `${r.schema}.${r.name}`;
    relationSeen.add(key);
    need(!RELATIONSHIP_NAMES.test(r.name), `relationship-like relation ${key}`);
    for (const column of r.columns ?? []) need(!RELATIONSHIP_NAMES.test(column), `relationship-like column ${key}.${column}`);
    const want = tables.get(key);
    if (!want) { problems.push(clip(`unexpected relation ${key} (kind ${r.kind})`)); continue; }
    need(r.kind === 'r', `${key} is not an ordinary table`);
    need(r.rls === true, `${key} has RLS disabled`);
    for (const role of ROLES) {
      const grant = r.grants?.[role] ?? { table: null, columns: null };
      const table = role === 'authenticated' ? want.table : [];
      const columns = role === 'authenticated' ? want.columns : {};
      need(isDeepStrictEqual(sorted(grant.table ?? []), sorted(table)) && Array.isArray(grant.table),
        `${key} ${role} table privileges ${JSON.stringify(grant.table)}`);
      const observed = Object.fromEntries(Object.entries(grant.columns ?? {}).map(([p, c]) => [p, sorted(c)]));
      const wanted = Object.fromEntries(Object.entries(columns).map(([p, c]) => [p, sorted(c)]));
      need(isDeepStrictEqual(observed, wanted), `${key} ${role} column privileges ${JSON.stringify(grant.columns)}`);
    }
  }
  for (const key of tables.keys()) need(relationSeen.has(key), `missing table ${key}`);

  const policies = new Map();
  for (const p of snapshot.policies) {
    const key = `${p.schema}.${p.table}`;
    if (!policies.has(key)) policies.set(key, []);
    policies.get(key).push(p);
  }
  const comparePolicies = (key, wanted) => {
    const observed = [...(policies.get(key) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    need(isDeepStrictEqual(observed.map((p) => p.name), wanted.map((p) => p.name)), `${key} policies ${observed.map((p) => p.name).join(',')}`);
    for (const want of wanted) {
      const p = observed.find((x) => x.name === want.name);
      if (!p) continue;
      need(p.cmd === want.cmd && p.permissive === 'PERMISSIVE' && isDeepStrictEqual(p.roles, ['authenticated']),
        `${key}.${want.name} command/roles/mode differ`);
      need(compact(p.qual) === compact(want.qual), `${key}.${want.name} USING ${p.qual}`);
      need(compact(p.check) === compact(want.check), `${key}.${want.name} WITH CHECK ${p.check}`);
    }
    policies.delete(key);
  };
  for (const table of Object.keys(PUBLIC_TABLES)) comparePolicies(`public.${table}`, OWNER_POLICIES);
  comparePolicies('storage.objects', STORAGE_POLICIES);
  for (const key of policies.keys()) problems.push(clip(`unexpected policies on ${key}`));

  const schemas = snapshot.schemas;
  for (const role of ROLES) {
    need(schemas?.[role]?.private?.USAGE === (role === 'authenticated'), `private USAGE for ${role}`);
    for (const schema of ['public', 'private']) need(schemas?.[role]?.[schema]?.CREATE === false, `${schema} CREATE for ${role}`);
  }
  need(isDeepStrictEqual(snapshot.buckets, [{ id: 'wardrobe', public: false }]), `buckets ${JSON.stringify(snapshot.buckets)}`);
  need(snapshot.storage?.objectsRls === true, 'storage.objects RLS disabled');
  need(isDeepStrictEqual(snapshot.publications, []), `published tables ${JSON.stringify(snapshot.publications)}`);
  for (const fk of snapshot.foreignKeys) need(ownerScopedForeignKey(fk.def), `${fk.table}.${fk.name} is not owner-scoped: ${fk.def}`);
  return problems;
}

export function ownerScopedForeignKey(def) {
  const match = /^FOREIGN KEY \(([^)]*)\) REFERENCES ([\w.]+)\(([^)]*)\)/.exec(String(def));
  if (!match) return false;
  const [, local, target, remote] = match;
  const left = local.split(',').map((x) => x.trim()), right = remote.split(',').map((x) => x.trim());
  if (left.length === 1 && left[0] === 'owner_id') {
    return ['private.approved_accounts(user_id)', 'public.profiles(owner_id)', 'auth.users(id)'].includes(`${target}(${right[0]})`);
  }
  const index = left.indexOf('owner_id');
  return index >= 0 && right[index] === 'owner_id' && left.length === right.length;
}

/** Latest `create [or replace] function schema.name(` body in migration order. */
export function extractFunctionBody(sources, qualifiedName) {
  const pattern = new RegExp(`create (?:or replace )?function ${qualifiedName.replace('.', '\\.')}\\(`, 'g');
  let found = null;
  for (const source of sources) {
    const text = source.replace(/\r\n/g, '\n');
    for (const match of text.matchAll(pattern)) {
      const open = /\bas (\$[A-Za-z_]*\$)/.exec(text.slice(match.index));
      if (!open) continue;
      const start = match.index + open.index + open[0].length;
      const end = text.indexOf(open[1], start);
      if (end > start) found = text.slice(start, end);
    }
  }
  return found;
}
export async function helperBodyMd5(root = ROOT) {
  const directory = path.join(root, 'supabase', 'migrations');
  const files = (await readdir(directory)).filter((name) => /^\d{14}_[\w-]+\.sql$/.test(name)).sort();
  const sources = await Promise.all(files.map((name) => readFile(path.join(directory, name), 'utf8')));
  const result = {};
  for (const helper of POLICY_HELPERS) {
    const body = extractFunctionBody(sources, `private.${helper.name}`);
    if (body !== null) result[helper.name] = createHash('md5').update(body).digest('hex');
  }
  return result;
}

// --- Response matching used by the normal-session audit ---------------------------------------
export function outcomeOf(result) {
  if (result.ok) return { status: result.status, data: result.data };
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
  return { status: result.status, code: data.code ?? null, message: data.message ?? null };
}
/** Exact comparison with an expected response shape (`data` for success, `code`/`message` for errors). */
export function matchOutcome(expected, result) {
  const actual = outcomeOf(result);
  if (actual.status !== expected.status) return false;
  if (Object.hasOwn(expected, 'data')) return Object.hasOwn(actual, 'data') && isDeepStrictEqual(actual.data, expected.data);
  if (Object.hasOwn(actual, 'data')) return false;
  return actual.code === expected.code && (expected.message === undefined || actual.message === expected.message);
}
const placeholders = (value, ids) => {
  let text = JSON.stringify(value) ?? 'undefined';
  for (const id of ids) text = text.split(String(id).toLowerCase()).join('<ID>').split(String(id).toUpperCase()).join('<ID>');
  return text;
};
/** A foreign reference must be indistinguishable from a nonexistent one once each substituted ID is masked. */
export function sameOutcome(foreign, missing, foreignIds, missingIds) {
  return placeholders(outcomeOf(foreign), foreignIds) === placeholders(outcomeOf(missing), missingIds);
}
/**
 * The complete response (status plus every body field) with only the caller-substituted IDs masked. Missing and null
 * fields stay distinct, and constraint names, details and hints are never masked.
 */
export function fullOutcome(result, ids = []) {
  const value = result.ok ? { status: result.status, data: result.data ?? null } : { status: result.status, body: result.data ?? null };
  return JSON.parse(placeholders(value, ids));
}
/** Returns forbidden tokens found in a response body, exempting values the caller itself sent (reflected inputs). */
export function scanLeaks(body, forbidden, reflected = []) {
  const text = (typeof body === 'string' ? body : JSON.stringify(body) ?? '').toLowerCase();
  const exempt = new Set(reflected.map((value) => String(value).toLowerCase()));
  return forbidden.filter((token) => {
    const needle = String(token).toLowerCase();
    return needle.length >= 8 && !exempt.has(needle) && text.includes(needle);
  });
}
/** Application errors arrive as HTTP 200 JSON envelopes; returns their `code`, or null for other responses. */
export function applicationCode(result) {
  const data = result?.data;
  return result?.status === 200 && data !== null && typeof data === 'object' && !Array.isArray(data)
    && typeof data.code === 'string' ? data.code : null;
}
// Owner-local refusals decided before any lookup of the supplied reference; never ownership evidence.
export const INCONCLUSIVE_CODES = Object.freeze(['ALLOWANCE', 'RATE_LIMIT', 'UNCONFIGURED', 'INACTIVE', 'CONSENT_REQUIRED',
  'ACTIVE_DRAFT', 'INVALID_INPUT', 'UNAVAILABLE']);
export const isInconclusive = (result) => INCONCLUSIVE_CODES.includes(applicationCode(result));

const UNREACHABLE_ANALYZED = 'an analyzed Save needs a completed provider analysis claim, which normal sessions cannot create in this job';
const req = (refs, extra = {}) => Object.freeze({ refs: Object.freeze(refs), ...extra });
/**
 * Per-signature requirements. `refs` are fixture references that must each be substituted on their own (the
 * rest stay the attacker's), `mixed` needs an own+peer array, `collision` a create-ID probe, `ownerOnly` an own
 * call with no reference, `runtime` allows an explicit UNVERIFIED tag when owner-local state blocks the probe,
 * and `unverified` names a state normal sessions cannot reach. Every verified entry needs a successful owned control.
 * With several refs, `tuple` marks references used together (the complete valid peer tuple must also be probed,
 * because a mixed pair names no existing row); `alternatives` marks references that are each a separate argument.
 */
export const COVERAGE_REQUIREMENTS = Object.freeze({
  commit_image: req(['pendingImage', 'image'], { alternatives: true }),
  retire_image: req(['pendingImage', 'image'], { alternatives: true }),
  forget_image: req(['retired']),
  save_outfit: req(['item', 'outfit'], { alternatives: true, mixed: true, collision: true }),
  save_wear_event: req(['item', 'event', 'outfit'], { alternatives: true, mixed: true, collision: true }),
  export_manifest: req([], { ownerOnly: true }),
  restore_history_entry: req(['event', 'item'], { alternatives: true, collision: true }),
  update_image_description: req(['image']),
  ai_status: req([], { ownerOnly: true }),
  ai_set_consent: req([], { ownerOnly: true }),
  ai_begin_request: req([], { collision: true, runtime: true }),
  ai_request_control: req(['aiRequest'], { runtime: true }),
  ai_analysis_status: req(['aiRequest'], { runtime: true }),
  reserve_item_save: req([], { collision: true }),
  finalize_item_save: req(['saveItem', 'saveImage', 'saveFingerprint'], { tuple: true }),
  reserve_analyzed_item_save: req([], { unverified: UNREACHABLE_ANALYZED }),
  analyzed_item_save_preflight: req([], { unverified: UNREACHABLE_ANALYZED }),
  cancel_analyzed_item_save: req([], { unverified: UNREACHABLE_ANALYZED }),
  item_attribution_history: req(['item', 'changeItem'], { alternatives: true }),
  set_item_trashed: req(['item']),
  item_deletion_status: req(['item'], { mixed: true }),
  begin_item_deletion: req(['trashItem']),
  finish_item_deletion: req(['removeItem', 'removeRequest'], { tuple: true }),
  reserve_image_change: req(['freeItem', 'freeCurrent'], { tuple: true }),
  image_change_status: req(['changeItem', 'changeRequest'], { tuple: true }),
  image_change_requests: req(['changeItem']),
  image_recovery_versions: req(['recItem']),
  image_recovery_preflight: req(['recItem', 'recCurrent', 'recSource'], { tuple: true }),
  image_change_preflight: req(['changeRequest', 'changeItem', 'changeImage'], { tuple: true }),
  cancel_image_change: req(['changeItem', 'changeRequest'], { tuple: true }),
  item_deletion_operation_status: req(['prepItem', 'prepRequest'], { tuple: true }),
  item_deletion_operations: req(['prepItem'], { mixed: true }),
  prepare_item_deletion: req(['trashItem']),
  inventory_item_deletion: req(['prepItem', 'prepRequest'], { tuple: true }),
  cancel_item_deletion_preparation: req(['prepItem', 'prepRequest'], { tuple: true }),
  authorize_item_deletion: req(['readyItem', 'readyRequest', 'readyHash'], { tuple: true }),
  item_deletion_next_target: req(['removeItem', 'removeRequest'], { tuple: true }),
  reconcile_item_deletion_target: req(['removeItem', 'removeRequest'], { tuple: true }),
  begin_prepared_item_deletion: req(['removeItem', 'removeRequest'], { tuple: true }),
});
const DIRECTIONS = [['A', 'B'], ['B', 'A']];
const TAG = /^(?:anon|normal-[AB]|[AB]:control|[AB]>[AB]:(?:owner-only|mixed|collision|unverified|tuple|ref:[A-Za-z]+))$/;
/**
 * Coverage credit per direction: the attacker's owned control, every single-reference substitution, mixed arrays,
 * collision probes and anonymous denial. Unreachable states must carry no credit; runtime blocks carry an explicit
 * UNVERIFIED tag instead of credit. Service-only RPCs need normal-A, normal-B and anonymous denial.
 */
export function validateCoverage(covered, requirements = COVERAGE_REQUIREMENTS) {
  const problems = [];
  const names = EXPOSED_RPCS.map((f) => f.name);
  if (!isDeepStrictEqual(Object.keys(requirements).sort(), [...names].sort())) problems.push('coverage requirements differ from the exposed RPCs');
  for (const name of names) {
    const r = requirements[name], tags = covered.get(name) ?? new Set();
    if (!r) continue;
    if (r.refs.length > 1 ? r.tuple === r.alternatives : r.tuple || r.alternatives) {
      problems.push(`${name} must declare its references as exactly one of tuple or alternatives`);
    }
    if (!tags.has('anon')) problems.push(`${name} lacks anon coverage`);
    for (const [attacker, victim] of DIRECTIONS) {
      const d = `${attacker}>${victim}`;
      const credit = [...tags].filter((t) => t.startsWith(`${d}:`) && t !== `${d}:unverified`);
      if (r.unverified) {
        if (credit.length || tags.has(`${d}:unverified`)) problems.push(`${name} ${d} claims coverage for an unreachable state`);
        continue;
      }
      if (tags.has(`${d}:unverified`)) {
        if (!r.runtime) problems.push(`${name} ${d} is UNVERIFIED but has no runtime allowance`);
        else if (credit.length) problems.push(`${name} ${d} mixes UNVERIFIED with coverage credit`);
        continue;
      }
      if (!tags.has(`${attacker}:control`)) problems.push(`${name} ${d} lacks a successful owned control`);
      const needed = [...r.refs.map((ref) => `${d}:ref:${ref}`), ...(r.tuple ? [`${d}:tuple`] : []), ...(r.mixed ? [`${d}:mixed`] : []),
        ...(r.collision ? [`${d}:collision`] : []), ...(r.ownerOnly ? [`${d}:owner-only`] : [])];
      for (const tag of needed) if (!tags.has(tag)) problems.push(`${name} lacks ${tag} coverage`);
      for (const tag of credit) if (!needed.includes(tag)) problems.push(`${name} has unexpected ${tag} credit`);
    }
  }
  for (const f of SERVICE_ONLY_RPCS) {
    const tags = covered.get(f.name) ?? new Set();
    for (const tag of ['normal-A', 'normal-B', 'anon']) if (!tags.has(tag)) problems.push(`${f.name} lacks ${tag} denial`);
  }
  const known = new Set([...names, ...SERVICE_ONLY_RPCS.map((f) => f.name)]);
  for (const [name, tags] of covered) {
    if (!known.has(name)) problems.push(`coverage for unknown RPC ${name}`);
    for (const tag of tags) if (!TAG.test(tag)) problems.push(`${name} has malformed tag ${tag}`);
  }
  return problems;
}

const identifierLeaves = (value, out = new Set()) => {
  if (typeof value === 'string') { if (/^[0-9a-f]{64}$/.test(value) || /^[0-9a-f-]{36}$/i.test(value)) out.add(value); }
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) identifierLeaves(entry, out);
  return out;
};

/**
 * A complete-tuple probe must be the victim's own valid payload: no identifier or hash that only the attacker's
 * fixture holds, and (for intent RPCs) exactly the intent the victim's control accepted. Otherwise a rejection
 * could come from a fingerprint mismatch rather than the owner predicate.
 */
export function tupleConstructionProblems(name, payload, attacker, victim, intentKey) {
  const problems = [], victimIds = identifierLeaves(victim);
  const attackerOnly = [...identifierLeaves(attacker)].filter((id) => !victimIds.has(id));
  const leaked = [...identifierLeaves(payload)].filter((id) => attackerOnly.includes(id));
  if (leaked.length) problems.push(`${name} tuple carries ${leaked.length} attacker-only value(s)`);
  if (intentKey && !isDeepStrictEqual(payload?.p_intent, victim?.[intentKey])) {
    problems.push(`${name} tuple intent differs from the victim's accepted ${intentKey}`);
  }
  return problems;
}

/**
 * Accepted-risk inventory of existence oracles (foreign reference vs. nonexistent/new reference); they reveal
 * existence, never content. Each pins the exact response pair. Any other differing surface, or an accepted surface
 * whose pair changes, fails the audit; an accepted entry that stops reproducing is reported for removal.
 *
 * Create-ID residuals: IDs are client-chosen and globally unique, so a create with an ID another account already
 * holds is refused while a fresh ID succeeds. Conflict-response normalization makes that refusal identical to the
 * caller's own conflicting create (see TAKEN_ID_SURFACES), but the caller still learns that a candidate UUID it
 * already knows is taken. Removing this needs server-generated IDs plus owner-scoped idempotency keys (not built).
 * REST inserts on combination_rules, suggestion_feedback and item_images share the same primary-key residual and
 * are not probed individually.
 */
const pinned = (foreign, missing, summary, reason) => Object.freeze({ foreign: Object.freeze(foreign), missing: Object.freeze(missing),
  summary: `${summary} (${reason})` });
const RESIDUAL = "create-ID residual: needs a candidate UUID; same response as the caller's own conflicting create";
const residual = (foreign, missing, summary) => pinned(foreign, missing, summary, RESIDUAL);
const duplicate = (constraint) => ({ status: 409, code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` });
const CONFLICT_P0001 = { status: 400, code: 'P0001', message: 'Request conflict' };
export const ACCEPTED_ORACLES = Object.freeze({
  'save_outfit p_id': residual(CONFLICT_P0001, { status: 200 }, 'peer-owned outfit ID returns 400/P0001; a new ID saves (200)'),
  'save_wear_event p_id': residual(CONFLICT_P0001, { status: 200 }, 'peer-owned wear-event ID returns 400/P0001; a new ID saves (200)'),
  'REST items id': residual(duplicate('items_pkey'), { status: 201 }, 'peer-owned item ID returns 409/23505 on REST insert; a new ID inserts (201)'),
  'REST outfits id': residual(duplicate('outfits_pkey'), { status: 201 }, 'peer-owned outfit ID returns 409/23505 on REST insert; a new ID inserts (201)'),
  'REST wear_events id': residual(duplicate('wear_events_pkey'), { status: 201 },
    'peer-owned wear-event ID returns 409/23505 on REST insert; a new ID inserts (201)'),
  'REST wear_event_items id': residual(duplicate('wear_event_items_pkey'), { status: 201 },
    'peer-owned wear-event-item ID returns 409/23505 on REST insert; a new ID inserts (201)'),
  'restore_history_entry p_id': residual(CONFLICT_P0001, { status: 204 },
    'peer-owned wear-event-item ID returns 400/P0001; a new ID restores (204)'),
  'reserve_item_save p_item.id': residual({ status: 400, code: '22023', message: 'Request conflict' }, { status: 200 },
    'peer-owned item ID returns 400/22023; a new ID reserves (200)'),
  'Storage DELETE object': pinned({ status: 400, code: 'AccessDenied', message: 'Access denied' },
    { status: 400, code: 'NoSuchKey', message: 'Object not found' },
    'peer-owned object path returns 400/AccessDenied; a nonexistent path returns 400/NoSuchKey',
    "Storage checks existence before RLS; no policy-only fix for that execution path; needs the peer's full object path"),
});

/**
 * Taken-ID surfaces: an otherwise-valid create whose ID the caller already holds (own conflict) and one whose ID
 * another account holds (foreign) must both return exactly `conflict` (full body, only the substituted ID masked),
 * and a fresh ID must return `fresh`. Pins are absolute, so two identical but wrong responses still fail.
 */
const conflictOf = (code) => ({ status: 400, body: { code, details: null, hint: null, message: 'Request conflict' } });
const duplicateOf = (constraint) => ({ status: 409, body: { code: '23505', details: 'Key (id)=(<ID>) already exists.', hint: null,
  message: `duplicate key value violates unique constraint "${constraint}"` } });
const takenSurface = (oracle, conflict, fresh) => Object.freeze({ oracle, conflict: Object.freeze(conflict), fresh: Object.freeze(fresh) });
export const TAKEN_ID_SURFACES = Object.freeze({
  'save_outfit p_id': takenSurface('save_outfit p_id', conflictOf('P0001'), { status: 200, data: 1 }),
  'save_wear_event p_id': takenSurface('save_wear_event p_id', conflictOf('P0001'), { status: 200, data: 1 }),
  'restore_history_entry p_id': takenSurface('restore_history_entry p_id', conflictOf('P0001'), { status: 204, data: null }),
  'reserve_item_save p_item.id (save attempt)': takenSurface('reserve_item_save p_item.id', conflictOf('22023'), { status: 200 }),
  'reserve_item_save p_item.id (plain item)': takenSurface('reserve_item_save p_item.id', conflictOf('22023'), { status: 200 }),
  'REST items id': takenSurface('REST items id', duplicateOf('items_pkey'), { status: 201, data: null }),
  'REST outfits id': takenSurface('REST outfits id', duplicateOf('outfits_pkey'), { status: 201, data: null }),
  'REST wear_events id': takenSurface('REST wear_events id', duplicateOf('wear_events_pkey'), { status: 201, data: null }),
  'REST wear_event_items id': takenSurface('REST wear_event_items id', duplicateOf('wear_event_items_pkey'), { status: 201, data: null }),
});
const freshMatches = (pin, outcome) => outcome.status === pin.status && Object.hasOwn(outcome, 'data')
  && (!Object.hasOwn(pin, 'data') || isDeepStrictEqual(outcome.data, pin.data));
/**
 * `records[`${surface} ${direction}`]` holds `{ foreign, own, fresh }` fullOutcome shapes (plus `persisted`, the
 * read-back of the fresh create). Every surface needs all three controls in both directions; anything missing,
 * unknown or different from its pin is a problem.
 */
export function takenIdProblems(records, surfaces = TAKEN_ID_SURFACES) {
  const problems = [], expected = new Set();
  for (const [surface, pin] of Object.entries(surfaces)) {
    for (const [attacker, victim] of DIRECTIONS) {
      const key = `${surface} ${attacker}>${victim}`, r = records[key];
      expected.add(key);
      if (!r) { problems.push(`${key}: no taken-ID probes`); continue; }
      for (const part of ['foreign', 'own', 'fresh']) if (!r[part]) problems.push(`${key}: missing ${part} control`);
      if (!r.foreign || !r.own || !r.fresh) continue;
      if (!isDeepStrictEqual(r.own, pin.conflict)) problems.push(`${key}: own conflicting create ${JSON.stringify(r.own)} differs from the pinned ${JSON.stringify(pin.conflict)}`);
      if (!isDeepStrictEqual(r.foreign, pin.conflict)) problems.push(`${key}: foreign ID ${JSON.stringify(r.foreign)} differs from the pinned ${JSON.stringify(pin.conflict)}`);
      if (!isDeepStrictEqual(r.foreign, r.own)) problems.push(`${key}: foreign ID response differs from the own conflicting create`);
      if (!freshMatches(pin.fresh, r.fresh)) problems.push(`${key}: fresh ID ${JSON.stringify(r.fresh)} is not the pinned ${JSON.stringify(pin.fresh)}`);
      else if (r.persisted !== true) problems.push(`${key}: fresh create was not read back`);
    }
  }
  for (const key of Object.keys(records)) if (!expected.has(key)) problems.push(`${key}: unknown taken-ID surface`);
  return problems;
}
const matchesPin = (pin, outcome) => outcome.status === pin.status
  && (pin.code === undefined ? Object.hasOwn(outcome, 'data') : outcome.code === pin.code && outcome.message === pin.message);
/**
 * Verdict for one probe pair (`outcomeOf` shapes): 'equivalent', 'accepted', 'accepted-not-reproduced', 'changed'
 * (an accepted surface with a different pair: fails) or 'fail' (not allowlisted).
 */
export function classifyOracle(surface, differs, foreign, missing) {
  const pin = Object.hasOwn(ACCEPTED_ORACLES, surface) ? ACCEPTED_ORACLES[surface] : null;
  if (!differs) return pin ? 'accepted-not-reproduced' : 'equivalent';
  if (!pin) return 'fail';
  return foreign && missing && matchesPin(pin.foreign, foreign) && matchesPin(pin.missing, missing) ? 'accepted' : 'changed';
}
const SEVERITY = ['equivalent', 'accepted-not-reproduced', 'accepted', 'changed', 'fail'];
/** Worst verdict over several probe pairs for one surface (e.g. every object path). */
export function worstOracle(verdicts) {
  return verdicts.reduce((worst, v) => (SEVERITY.indexOf(v) > SEVERITY.indexOf(worst) ? v : worst), 'equivalent');
}
/** Controller bookkeeping: a freeze request marks the owner before any SQL; only a successful restore clears it. */
export function trackPhase(touched, phase, owner, stage, code = null) {
  if (phase === 'freeze' && stage === 'before') touched.add(owner);
  if (phase === 'restore' && stage === 'after' && code === 0) touched.delete(owner);
  return touched;
}
/**
 * Cleanup runs only after a confirmed restore barrier whenever any freeze was requested, including a freeze whose
 * acknowledgement failed or timed out. An unconfirmed barrier withholds cleanup and reports both failures.
 */
export async function restoreThenCleanup(freezeRequested, barrier, cleanup) {
  const errors = [];
  if (freezeRequested) {
    const confirmed = await Promise.resolve().then(barrier).then((value) => value === true, () => false);
    if (!confirmed) { errors.push('restore-barrier-unconfirmed'); return { cleaned: false, errors }; }
  }
  try { await cleanup(); } catch { errors.push('cleanup'); }
  return { cleaned: true, errors };
}

// --- Closed privileged access (CI database job only) -------------------------------------------
const NOT_RUN = 'NOT RUN: I17 privileged catalogue/freeze control requires the approved disposable CI database job.';
const REFUSED = 'REFUSED: I17 privileged control target is not the verified local disposable database.';
export const GUARD_FLAGS = Object.freeze(['ALLOW_SECURITY_TESTS', 'ALLOW_CI_DATABASE_MUTATION', 'CI', 'GITHUB_ACTIONS',
  'GITHUB_REPOSITORY', 'GITHUB_JOB']);
const IMAGES = ['public.ecr.aws/supabase/postgres:17.6.1.165', 'ghcr.io/supabase/postgres:17.6.1.165', 'supabase/postgres:17.6.1.165'];

/** Environment for the privileged child: command basics plus guard flags; never credentials. */
export function privilegedEnvironment(source) {
  assertNoServiceSecrets(source);
  const result = commandEnvironment(source);
  for (const name of GUARD_FLAGS) if (source[name] !== undefined) result[name] = source[name];
  return result;
}

/** Every check runs before any SQL. `run` and `readConfig` are injectable for tests. */
export async function guardPrivileged({ env, run = runCommand, readConfig }) {
  assertNoServiceSecrets(env);
  if (env.ALLOW_SECURITY_TESTS !== '1' || env.ALLOW_CI_DATABASE_MUTATION !== '1' || env.CI !== 'true'
    || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'drrowdev/stillroom-wardrobe'
    || env.GITHUB_JOB !== 'database') fail(NOT_RUN);
  for (const name of Object.keys(env)) {
    if (/^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|PG[A-Z_]*)$/i.test(name)) {
      fail('REFUSED: Docker/PostgreSQL endpoint overrides are not permitted for I17 privileged control.');
    }
  }
  if (env.SUPABASE_URL) assertLocalApi(env.SUPABASE_URL);
  const config = await readConfig();
  if (typeof config !== 'string' || !/^project_id\s*=\s*"stillroom-wardrobe"\s*$/m.test(config)
    || !/^schemas\s*=\s*\["public", "graphql_public"\]\s*$/m.test(config)) fail(REFUSED);
  await requireDocker(run);
  const template = '{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"image":{{json .Config.Image}},"running":{{json .State.Running}}}';
  const result = await run('docker', ['container', 'inspect', '--format', template, DB_CONTAINER], {
    env: commandEnvironment(env), timeout: 30_000, maxOutputBytes: 4096,
  });
  let value = null;
  try { value = JSON.parse(result.stdout); } catch { /* refused below */ }
  if (result.code !== 0 || result.stderr !== '' || !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'image,name,project,running'
    || value.name !== `/${DB_CONTAINER}` || value.project !== PROJECT_ID
    || value.running !== true || !IMAGES.includes(value.image)) fail(REFUSED);
}

const DEADLINES = `set local search_path = pg_catalog;
set local statement_timeout = '10s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '10s';`;

export const CATALOG_SQL = `begin read only;
${DEADLINES}
select jsonb_build_object(
  'functions',(select coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,
      'args',oidvectortypes(p.proargtypes),'kind',p.prokind,'definer',p.prosecdef,
      'public',has_function_privilege('public',p.oid,'EXECUTE'),
      'anon',has_function_privilege('anon',p.oid,'EXECUTE'),
      'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),
      'extension',exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e'),
      'md5',case when n.nspname='private' and p.proname in ('is_approved','owns_storage_path','may_delete_storage','may_create_item_object')
        then md5(p.prosrc) end) order by n.nspname,p.proname,oidvectortypes(p.proargtypes)),'[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private','graphql_public')),
  'relations',(select coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
      'rls',c.relrowsecurity,
      'columns',(select coalesce(jsonb_agg(a.attname order by a.attnum),'[]'::jsonb) from pg_attribute a
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      'grants',case when c.relkind in ('r','p','v','m','f') then (select jsonb_object_agg(r.role,jsonb_build_object(
        'table',(select coalesce(jsonb_agg(pr order by pr),'[]'::jsonb)
          from unnest(array['DELETE','INSERT','MAINTAIN','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) pr
          where has_table_privilege(r.role,c.oid,pr)),
        'columns',(select coalesce(jsonb_object_agg(x.pr,x.cols),'{}'::jsonb) from (
          select pr,jsonb_agg(a.attname order by a.attnum) cols
          from unnest(array['INSERT','REFERENCES','SELECT','UPDATE']) pr cross join pg_attribute a
          where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
            and not has_table_privilege(r.role,c.oid,pr) and has_column_privilege(r.role,c.oid,a.attnum,pr)
          group by pr) x)))
        from unnest(array['public','anon','authenticated']) r(role))
      else (select jsonb_object_agg(r.role,jsonb_build_object('table',(select coalesce(jsonb_agg(pr order by pr),'[]'::jsonb)
          from unnest(array['SELECT','UPDATE','USAGE']) pr where has_sequence_privilege(r.role,c.oid,pr)),'columns','{}'::jsonb))
        from unnest(array['public','anon','authenticated']) r(role)) end)
      order by n.nspname,c.relname),'[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','graphql_public') and c.relkind in ('r','p','v','m','f','S')),
  'policies',(select coalesce(jsonb_agg(jsonb_build_object('schema',schemaname,'table',tablename,'name',policyname,
      'cmd',cmd,'roles',to_jsonb(roles),'permissive',permissive,'qual',qual,'check',with_check)
      order by schemaname,tablename,policyname),'[]'::jsonb)
    from pg_policies where schemaname in ('public','private','graphql_public','storage')),
  'schemas',(select jsonb_object_agg(r.role,(select jsonb_object_agg(s.name,jsonb_build_object(
      'USAGE',has_schema_privilege(r.role,s.name,'USAGE'),'CREATE',has_schema_privilege(r.role,s.name,'CREATE')))
      from unnest(array['public','private']) s(name)))
    from unnest(array['public','anon','authenticated']) r(role)),
  'buckets',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'public',public) order by id),'[]'::jsonb) from storage.buckets),
  'storage',jsonb_build_object('objectsRls',(select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='storage' and c.relname='objects')),
  'publications',(select coalesce(jsonb_agg(schemaname||'.'||tablename order by schemaname,tablename),'[]'::jsonb)
    from pg_publication_tables where schemaname in ('public','private')),
  'foreignKeys',(select coalesce(jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,
      'def',pg_get_constraintdef(oid)) order by conrelid::regclass::text,conname),'[]'::jsonb)
    from pg_constraint where contype='f' and connamespace='public'::regnamespace)
)::text;
commit;`;

const emailOf = (label) => {
  if (label !== 'A' && label !== 'B') fail('REFUSED: choose the fixed fictional owner A or B.');
  return TEST_EMAILS[label === 'A' ? 0 : 1];
};
export function freezeSql(label) {
  const email = emailOf(label), other = emailOf(label === 'A' ? 'B' : 'A');
  return `begin;
${DEADLINES}
do $freeze$
declare n integer;
begin
  update private.approved_accounts set enabled=false where email='${email}' and enabled and user_id is not null;
  get diagnostics n = row_count;
  if n<>1 or (select count(*) from private.approved_accounts where email='${other}' and enabled and user_id is not null)<>1 then
    raise exception 'I17_FREEZE_INVALID';
  end if;
end;
$freeze$;
commit;
select 'I17_FREEZE_OK';`;
}
export function restoreSql(label) {
  const email = emailOf(label);
  return `begin;
${DEADLINES}
do $restore$
declare n integer;
begin
  update private.approved_accounts set enabled=true where email='${email}' and user_id is not null;
  get diagnostics n = row_count;
  if n<>1 then raise exception 'I17_RESTORE_INVALID'; end if;
end;
$restore$;
commit;
select 'I17_RESTORE_OK';`;
}

async function psql(sql, env, run, maxOutputBytes) {
  const result = await run('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-X', '--no-password', '-h', '127.0.0.1',
    '-p', '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'],
  { input: sql, env: commandEnvironment(env), timeout: 30_000, maxOutputBytes });
  if (result.code !== 0 || result.stderr !== '' || typeof result.stdout !== 'string') {
    fail('FAIL: I17 privileged statement failed; output suppressed.', 1);
  }
  return result.stdout.trim();
}

/** Closed operation dispatcher; the only SQL is the fixed text above. */
export async function privilegedOperation(args, { env = process.env, run = runCommand,
  readConfig = () => readFile(path.join(ROOT, 'supabase', 'config.toml'), 'utf8') } = {}) {
  const [operation, label, ...extra] = args;
  const valid = extra.length === 0 && ((operation === 'catalog' && label === undefined)
    || (['freeze', 'restore'].includes(operation) && ['A', 'B'].includes(label)));
  if (!valid) fail('REFUSED: choose catalog, freeze A|B or restore A|B with no other arguments.');
  await guardPrivileged({ env, run, readConfig });
  if (operation === 'catalog') {
    const output = await psql(CATALOG_SQL, env, run, 512 * 1024);
    let snapshot;
    try { snapshot = JSON.parse(output); } catch { fail('FAIL: I17 catalogue output was not JSON.', 1); }
    return { operation, problems: validateCatalog(snapshot, await helperBodyMd5()) };
  }
  const expected = operation === 'freeze' ? 'I17_FREEZE_OK' : 'I17_RESTORE_OK';
  const output = await psql(operation === 'freeze' ? freezeSql(label) : restoreSql(label), env, run, 1024);
  if (output !== expected) fail(`FAIL: I17 ${operation} was not confirmed.`, 1);
  return { operation, label, problems: [] };
}

async function main() {
  const result = await privilegedOperation(process.argv.slice(2));
  if (result.operation === 'catalog') {
    if (result.problems.length) {
      for (const problem of result.problems.slice(0, 60)) console.error(`CATALOGUE: ${problem}`);
      if (result.problems.length > 60) console.error(`CATALOGUE: ${result.problems.length - 60} more problems withheld`);
      fail('FAIL: I17 exposed-surface catalogue differs from the reviewed inventory.', 1);
    }
    console.log(`PASS: I17 catalogue; ${EXPOSED_RPCS.length} exposed RPCs, ${SERVICE_ONLY_RPCS.length} service-only, `
      + `${POLICY_HELPERS.length} pinned policy helpers, ${Object.keys(PUBLIC_TABLES).length} public and ${PRIVATE_TABLES.length} private tables, 3 Storage policies`);
  } else console.log(`I17_${result.operation.toUpperCase()}_${result.label}_OK`);
}
if (isMain(import.meta.url)) main().catch(reportError);
