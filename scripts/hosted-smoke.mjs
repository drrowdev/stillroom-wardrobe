import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const HOSTED_URL = 'https://xwrdrugastphdiihzuia.supabase.co';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const inputs = [
  'ALLOW_HOSTED_SMOKE', 'HOSTED_SUPABASE_URL', 'HOSTED_SUPABASE_PUBLISHABLE_KEY',
  ...['A', 'B'].flatMap((label) =>
    ['USER_ID', 'ACCESS_TOKEN', 'ITEM_ID', 'IMAGE_ID'].map((field) => `HOSTED_${label}_${field}`)),
];
const allowedEnvironment = new Set([
  ...inputs, 'PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE',
  'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP',
]);
const outcomes = {
  PASS: { status: 'PASS', exitCode: 0 },
  FAIL: { status: 'FAIL', exitCode: 1 },
  BLOCKED: { status: 'BLOCKED', exitCode: 2 },
};

class SmokeError extends Error {
  constructor(status) {
    super(status);
    this.status = status;
  }
}
function requireEvidence(condition) {
  if (!condition) throw new SmokeError('BLOCKED');
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function tokenClaims(token) {
  requireEvidence(typeof token === 'string' && token.length <= 16_384
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
  try {
    const [header, payload] = token.split('.');
    const algorithm = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    requireEvidence(record(algorithm) && ['HS256', 'ES256', 'RS256'].includes(algorithm.alg)
      && record(claims));
    return claims;
  } catch {
    throw new SmokeError('BLOCKED');
  }
}

export function validateHostedEnvironment(env) {
  requireEvidence(record(env)
    && Object.keys(env).every((name) => allowedEnvironment.has(name))
    && inputs.every((name) => typeof env[name] === 'string' && env[name].length > 0)
    && env.ALLOW_HOSTED_SMOKE === '1'
    && env.HOSTED_SUPABASE_URL === HOSTED_URL
    && /^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(env.HOSTED_SUPABASE_PUBLISHABLE_KEY));
  const owners = ['A', 'B'].map((label) => {
    const owner = {
      uid: env[`HOSTED_${label}_USER_ID`], token: env[`HOSTED_${label}_ACCESS_TOKEN`],
      item: env[`HOSTED_${label}_ITEM_ID`], image: env[`HOSTED_${label}_IMAGE_ID`],
    };
    requireEvidence([owner.uid, owner.item, owner.image].every((value) => uuid.test(value)));
    // Claims only reject unsafe input. GET /auth/v1/user establishes the identity.
    const claims = tokenClaims(owner.token);
    requireEvidence(claims.role === 'authenticated' && claims.aud === 'authenticated'
      && claims.sub === owner.uid && claims.iss === `${HOSTED_URL}/auth/v1`
      && Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000
      && claims.is_anonymous === false);
    return owner;
  });
  requireEvidence(owners[0].uid !== owners[1].uid && owners[0].token !== owners[1].token
    && owners[0].item !== owners[1].item && owners[0].image !== owners[1].image);
  return { key: env.HOSTED_SUPABASE_PUBLISHABLE_KEY, owners };
}

async function readBounded(response, maximum) {
  requireEvidence(response.body);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      requireEvidence(length <= maximum);
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    // Cancellation must not replace a primary missing/oversized/failed response.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function json(response) {
  requireEvidence(response.type.split(';')[0].trim().toLowerCase() === 'application/json');
  try { return JSON.parse(response.bytes.toString('utf8')); }
  catch { throw new SmokeError('BLOCKED'); }
}

export async function runHostedSmoke(env, fetcher = fetch) {
  try {
    const { key, owners } = validateHostedEnvironment(env);
    async function get(owner, route, media = false, foreign = false) {
      const response = await fetcher(`${HOSTED_URL}${route}`, {
        method: 'GET', headers: { apikey: key, Authorization: 'Bearer ' + owner.token },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      requireEvidence(!response.redirected && (response.status < 300 || response.status >= 400));
      if (media && foreign && response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new SmokeError('FAIL');
      }
      requireEvidence(response.status < 500 && response.status !== 429 && response.status !== 401);
      return {
        status: response.status, type: response.headers.get('content-type') ?? '',
        bytes: await readBounded(response, media && !foreign ? 512_000 : 65_536),
      };
    }
    async function verify(owner) {
      const response = await get(owner, '/auth/v1/user');
      requireEvidence(response.status === 200);
      const user = json(response);
      requireEvidence(record(user) && user.id === owner.uid && user.role === 'authenticated'
        && user.aud === 'authenticated' && user.is_anonymous === false);
    }
    function queries(owner) {
      return [
        `/rest/v1/profiles?owner_id=eq.${owner.uid}&select=owner_id&limit=2`,
        `/rest/v1/items?id=eq.${owner.item}&select=id,owner_id,deleted_at&limit=2`,
        `/rest/v1/item_images?id=eq.${owner.image}&select=id,owner_id,item_id,state,main_path,thumb_path,main_bytes,thumb_bytes,main_sha256,thumb_sha256&limit=2`,
      ];
    }
    async function own(owner) {
      await verify(owner);
      const rows = [];
      for (const route of queries(owner)) {
        const response = await get(owner, route);
        requireEvidence(response.status === 200);
        const data = json(response);
        requireEvidence(Array.isArray(data) && data.length === 1 && record(data[0])
          && data[0].owner_id === owner.uid);
        rows.push(data[0]);
      }
      const [, item, image] = rows;
      requireEvidence(item.id === owner.item && item.deleted_at === null
        && image.id === owner.image && image.item_id === owner.item && image.state === 'ready');
      for (const variant of ['main', 'thumb']) {
        const path = `${owner.uid}/${owner.item}/${owner.image}/${variant}.jpg`;
        const size = image[`${variant}_bytes`];
        requireEvidence(image[`${variant}_path`] === path && Number.isInteger(size)
          && size > 0 && size <= (variant === 'main' ? 512_000 : 61_440)
          && /^[0-9a-f]{64}$/.test(image[`${variant}_sha256`]));
        const response = await get(owner, `/storage/v1/object/authenticated/wardrobe/${path}`, true);
        requireEvidence(response.status === 200 && response.type.split(';')[0].trim().toLowerCase() === 'image/jpeg'
          && response.bytes.length === size
          && createHash('sha256').update(response.bytes).digest('hex') === image[`${variant}_sha256`]);
      }
      return JSON.stringify(rows);
    }
    const before = [];
    // Establish both positive fixtures before attempting either negative direction.
    for (const owner of owners) before.push(await own(owner));
    for (const [index, owner] of owners.entries()) {
      const other = owners[1 - index];
      for (const route of queries(other)) {
        const response = await get(owner, route);
        requireEvidence(response.status === 200);
        const data = json(response);
        requireEvidence(Array.isArray(data));
        if (data.length) throw new SmokeError('FAIL');
      }
      for (const variant of ['main', 'thumb']) {
        const path = `${other.uid}/${other.item}/${other.image}/${variant}.jpg`;
        const response = await get(owner, `/storage/v1/object/authenticated/wardrobe/${path}`, true, true);
        const error = json(response);
        // Storage deliberately reports a hidden existing object as not found.
        requireEvidence([400, 404].includes(response.status) && record(error)
          && String(error.statusCode) === '404'
          && (error.error === 'not_found' || error.code === 'NoSuchKey'));
      }
    }
    for (const [index, owner] of owners.entries()) requireEvidence(await own(owner) === before[index]);
    return { ...outcomes.PASS };
  } catch (error) {
    return { ...outcomes[error instanceof SmokeError ? error.status : 'BLOCKED'] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = process.argv.length === 2
    ? await runHostedSmoke(process.env) : { ...outcomes.BLOCKED };
  console.log(`Hosted read-only smoke: ${result.status}; no private details logged.`);
  process.exitCode = result.exitCode;
}
