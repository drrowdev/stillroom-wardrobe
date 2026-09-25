// CI-only PR-3b provider double. Runs on the internal fixture network as `provider-double:8080`; the fixture
// runtime's injected azureTransport forwards only the exact pinned Azure request here. No real provider is reached.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const DUMMY_API_KEY = 'local-dummy-not-a-credential';
export const DEPLOYMENT = 'eval-terra-20260709';
export const RETURNED_MODEL = 'gpt-5.6-terra-2026-07-09';
const nulls = { subcategory: null, pattern: null, sleeve_length: null, garment_length: null, brand: null, size_label: null,
  upper_coverage: null, lower_coverage: null, material: null };
export const READY_FACTS = Object.freeze({ outcome: 'ready', fields: { category: 'top', ...nulls, colours: ['green'],
  seasons: [], formality: 0, style_tags: [] } });
export const UNCLEAR_FACTS = Object.freeze({ outcome: 'unclear', fields: { category: null, ...nulls, colours: [],
  seasons: [], formality: null, style_tags: [] } });
export const USAGE = Object.freeze({ prompt_tokens: 100, completion_tokens: 30, total_tokens: 130,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } });
/** The fixture image width selects the double's behaviour. */
export const MODES = Object.freeze({ 121: 'unclear', 122: 'malformed', 123: 'server-error' });

/** Frame width from the first SOF marker of a JPEG, or null. */
export function jpegWidth(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1], length = bytes[offset + 2] * 256 + bytes[offset + 3];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return bytes[offset + 7] * 256 + bytes[offset + 8];
    if (marker === 0xda || length < 2) return null;
    offset += 2 + length;
  }
  return null;
}
/** Validates the forwarded Azure request body; returns the mode or null for a request the double refuses. */
export function requestMode(headers, text) {
  return requestVerdict(headers, text).mode ?? null;
}
/** The mode, or a content-free refusal reason for diagnostics. */
export function requestVerdict(headers, text) {
  if (headers['api-key'] !== DUMMY_API_KEY) return { reason: 'api-key' };
  if (headers['content-type'] !== 'application/json') return { reason: 'content-type' };
  let body;
  try { body = JSON.parse(text); } catch { return { reason: text.length === 0 ? 'empty-body' : 'json' }; }
  const url = body?.messages?.[1]?.content?.[0]?.image_url?.url;
  if (body?.model !== DEPLOYMENT || body.stream !== false || body.n !== 1 || body.store !== false) return { reason: 'parameters' };
  if (typeof url !== 'string' || !url.startsWith('data:image/jpeg;base64,')) return { reason: 'image-url' };
  const width = jpegWidth(Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64'));
  return width === null ? { reason: 'jpeg' } : { mode: MODES[width] ?? 'ready' };
}
export function completion(mode) {
  const content = mode === 'malformed' ? '{"outcome":"ready","fields":' : JSON.stringify(mode === 'unclear' ? UNCLEAR_FACTS : READY_FACTS);
  return { model: RETURNED_MODEL, usage: USAGE, choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', refusal: null, content } }] };
}

function main() {
  const counts = { served: 0, rejected: 0, refused: 0, modes: {}, refusals: [] };
  createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= 2 * 1024 * 1024) chunks.push(chunk); });
    req.on('end', () => {
      const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
      if (req.method === 'GET' && req.url === '/__count' && local) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(counts)); return;
      }
      if (req.method === 'POST' && req.url === '/rejected') {
        counts.rejected += 1; res.writeHead(204); res.end(); return;
      }
      const verdict = req.method !== 'POST' || req.url !== '/chat/completions' ? { reason: 'route' }
        : size > 2 * 1024 * 1024 ? { reason: 'size' } : requestVerdict(req.headers, Buffer.concat(chunks).toString('utf8'));
      const mode = verdict.mode ?? null;
      if (mode === null) {
        counts.refused += 1;
        if (counts.refusals.length < 10) counts.refusals.push({ reason: verdict.reason, method: String(req.method).slice(0, 8),
          path: String(req.url).split('?')[0].slice(0, 32), bytes: size });
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{}'); return;
      }
      counts.served += 1;
      counts.modes[mode] = (counts.modes[mode] ?? 0) + 1;
      if (mode === 'server-error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'InternalServerError', message: 'synthetic' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion(mode)));
    });
  }).listen(8080, '0.0.0.0');
  console.log('EDGE-DOUBLE listening');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
