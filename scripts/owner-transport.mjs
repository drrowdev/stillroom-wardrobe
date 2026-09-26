// The one network gate for the owner CLIs (export-own, restore-own). Every request the SDK or a downloader makes passes
// here: one origin, the project's publishable key, no credentials in the URL, no redirects, cookies or caching, and a
// deadline. What may be requested is a separate, hand-written policy chosen by the caller. Policies are reviewed by
// hand; tests only check that the requests the tools really make are inside them, never generate them.
export const REQUEST_TIMEOUT_MS = 30_000;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidList = new RegExp(`^in\\.\\(${uuid}(?:,${uuid}){0,99}\\)$`);
const uuidEquals = new RegExp(`^eq\\.${uuid}$`);
// PostgREST column names as the app writes them; digits are allowed after the first letter (main_sha256).
const columnList = /^[a-z_][a-z0-9_]{0,63}(?:,[a-z_][a-z0-9_]{0,63}){0,63}$/;

const authRequest = ({ method, path, search }) => method === 'POST'
  && ((path === '/auth/v1/token' && ['?grant_type=password', '?grant_type=refresh_token'].includes(search))
    || (path === '/auth/v1/logout' && search === '?scope=local'));

// A query with exactly these parameters, each given once and each accepted by its check.
function queryIs(query, checks) {
  const names = [...query.keys()];
  if (names.length !== Object.keys(checks).length || new Set(names).size !== names.length) return false;
  return Object.entries(checks).every(([name, check]) => query.has(name) && check(query.get(name)));
}
function jsonBody(body) {
  if (typeof body !== 'string' || body.length > 1_000_000) return null;
  try { return JSON.parse(body); } catch { return null; }
}
const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);

const storagePath = (prefix) => new RegExp(`^${prefix}(${uuid})/${uuid}/${uuid}/(?:main|thumb)\\.jpg$`);
const exportStorage = storagePath('/storage/v1/object/authenticated/wardrobe/');
const restoreStorage = storagePath('/storage/v1/object/wardrobe/');

/** export-own: sign-in, the two export RPCs and authenticated downloads of the owner's own photos. */
export function exportPolicy(request, state) {
  const { method, path, search } = request;
  const storage = exportStorage.exec(path);
  return authRequest(request)
    || (method === 'POST' && ['/rest/v1/rpc/export_manifest', '/rest/v1/rpc/item_attribution_history'].includes(path) && !search)
    || (method === 'GET' && storage !== null && storage[1] === state.owner && !search);
}

// Every RPC the shared restore engine calls (src/data/restore.ts, src/images/upload.ts and src/images/replace.ts).
// cancel_image_change, image_change_requests and image_recovery_versions are never used by a restore and are refused.
export const RESTORE_RPCS = Object.freeze(['reserve_restored_item_save', 'finalize_item_save', 'restore_item_save_status',
  'restore_image_change_status', 'reserve_image_change', 'image_change_status', 'save_outfit', 'restore_history_entry']);
// Every method and non-Storage route the restore may use, written out. The policy below refuses anything else before its
// own checks; Storage photo paths are the owner-scoped shape `restoreStorage` instead.
export const RESTORE_ROUTES = Object.freeze(['POST /auth/v1/token', 'POST /auth/v1/logout',
  ...RESTORE_RPCS.map(rpc => `POST /rest/v1/rpc/${rpc}`),
  'GET /rest/v1/items', 'GET /rest/v1/item_images', 'GET /rest/v1/wear_events', 'POST /rest/v1/wear_events',
  'POST /rest/v1/combination_rules', 'POST /rest/v1/suggestion_feedback', 'POST /functions/v1/finalize-image-change']);
const HISTORY_COLUMNS = 'id,owner_id,outfit_id,local_date,timezone,state,label,deleted_at';

function canonicalPath(rawPath, path) {
  if (typeof rawPath !== 'string' || rawPath !== path || rawPath.includes('\\') || /%2e|%5c|%2f/i.test(rawPath)) return false;
  return rawPath.split('/').every(segment => segment !== '.' && segment !== '..');
}

/** restore-own: sign-in, the checked restore RPCs, owner-scoped reads, the owner's photo files and the replacement finalizer. */
export function restorePolicy(request, state) {
  const { method, path, search, query, headers, body } = request;
  // The address is sent as given, so it must already be the path the checks below see: no dot segments (literal or
  // percent-encoded), no backslashes and nothing the URL parser would rewrite.
  if (!canonicalPath(request.rawPath, path)) return false;
  if (!restoreStorage.test(path) && !RESTORE_ROUTES.includes(`${method} ${path}`)) return false;
  if (authRequest(request)) return true;
  if (!state.owner) return false;
  const owner = `eq.${state.owner}`;
  const ownRow = () => { const value = jsonBody(body); return record(value) && value.owner_id === state.owner; };
  if (method === 'POST' && path.startsWith('/rest/v1/rpc/')) return !search && RESTORE_RPCS.includes(path.slice('/rest/v1/rpc/'.length));
  if (method === 'GET' && path === '/rest/v1/items') {
    return queryIs(query, { select: value => columnList.test(value), owner_id: value => value === owner, id: value => uuidList.test(value) });
  }
  if (method === 'GET' && path === '/rest/v1/item_images') {
    return queryIs(query, { select: value => columnList.test(value), owner_id: value => value === owner, item_id: value => uuidList.test(value) });
  }
  if (method === 'GET' && path === '/rest/v1/wear_events') {
    return queryIs(query, { select: value => value === HISTORY_COLUMNS, owner_id: value => value === owner, id: value => uuidEquals.test(value) });
  }
  if (method === 'POST' && path === '/rest/v1/wear_events') return !search && ownRow();
  if (method === 'POST' && path === '/rest/v1/combination_rules') {
    return queryIs(query, { on_conflict: value => value === 'owner_id,item_low,item_high' }) && ownRow();
  }
  if (method === 'POST' && path === '/rest/v1/suggestion_feedback') {
    return queryIs(query, { on_conflict: value => value === 'owner_id,signature' }) && ownRow();
  }
  const storage = restoreStorage.exec(path);
  if (storage !== null) {
    if (storage[1] !== state.owner || search) return false;
    // New files only: an upload that could replace a stored file is refused.
    return method === 'GET' || (method === 'POST' && headers.get('x-upsert') === 'false');
  }
  if (method === 'POST' && path === '/functions/v1/finalize-image-change' && !search) {
    // Only completing a replacement this restore reserved: no recovery, no analysis claim.
    const value = jsonBody(body);
    return record(value) && Object.keys(value).length === 2 && value.action === 'complete' && record(value.intent)
      && value.intent.sourceImageId === null && value.intent.claim === null
      && headers.get('authorization')?.startsWith('Bearer ') === true;
  }
  return false;
}

/**
 * Wraps `fetchImpl`. `state` holds `owner` (set after sign-in), `signal` (cancels every request) and `refused`, which is
 * set when a request is refused so the caller can report it even if the SDK swallows the error. `refusal()` makes the
 * error thrown for a refused request. `observe`, for tests only, sees each allowed request.
 */
export function ownerTransport({ origin, key, fetchImpl, state, policy, refusal, observe }) {
  if (typeof policy !== 'function' || typeof refusal !== 'function') throw new TypeError('A policy and a refusal are required.');
  const refuse = () => { state.refused = true; throw refusal(); };
  return async (input, init = {}) => {
    if (typeof input !== 'string' && !(input instanceof URL)) refuse();
    const address = String(input);
    let url;
    try { url = new URL(address); } catch { refuse(); }
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    // The path exactly as written, before the URL parser resolves dot segments or backslashes.
    const rawPath = address.startsWith(`${origin}/`) ? address.slice(origin.length).split(/[?#]/, 1)[0] : '';
    const request = { method, path: url.pathname, rawPath, search: url.search, query: url.searchParams, headers, body: init.body };
    const allowed = url.origin === origin && !url.username && !url.password && !url.hash && address.startsWith(`${origin}/`)
      && headers.get('apikey') === key && policy(request, state);
    if (!allowed) refuse();
    observe?.({ method, path: url.pathname, search: url.search });
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init.signal ? [init.signal] : []), ...(state.signal ? [state.signal] : [])];
    return fetchImpl(address, { ...init, method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.any(signals) });
  };
}
