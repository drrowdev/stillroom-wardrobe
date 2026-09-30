// CI-only PR-3b provider double. Runs on the internal fixture network as `provider-double:8080`; the fixture
// runtime's injected azureTransport forwards only the exact pinned Azure request here. No real provider is reached.
import { createHash } from 'node:crypto';
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
/** The exact final user message selects the stylist double's behaviour (text only, never an image). */
export const STYLIST_MODES = Object.freeze({ 'Stylist fixture refusal': 'stylist-refusal', 'Stylist fixture tool': 'stylist-tool',
  'Stylist fixture unknown ref': 'stylist-unknown-ref', 'Stylist fixture overrun': 'stylist-overrun',
  'Stylist fixture tool text': 'stylist-tool-text' });
export const STYLIST_FORBIDDEN_KEYS = Object.freeze(['title', 'brand', 'material', 'subcategory', 'style_tags', 'tags', 'notes',
  'size_label', 'image_url', 'owner_id', 'id']);
/**
 * Bounded inspection of one stylist request: the exact controls, a system prompt, at most nine text messages within
 * 20,000 serialized bytes, the minimised context and no image or free-text item fields. Returns the mode or a reason.
 */
export function stylistVerdict(body) {
  const messages = body?.messages;
  const controls = body?.model === DEPLOYMENT && body.stream === false && body.n === 1 && body.store === false
    && body.reasoning_effort === 'low' && body.max_completion_tokens === 1200
    && JSON.stringify(body.prompt_cache_options) === '{"mode":"explicit"}' && body.response_format?.json_schema?.strict === true;
  if (!controls) return { reason: 'stylist-parameters' };
  if (!Array.isArray(messages) || messages.length < 3 || messages.length > 9 || messages[0]?.role !== 'system'
    || messages.some((m) => typeof m?.content !== 'string' || !['system', 'user', 'assistant'].includes(m.role))
    || Buffer.byteLength(JSON.stringify(messages)) > 20000) return { reason: 'stylist-messages' };
  let context;
  try { context = JSON.parse(messages[1].content); } catch { return { reason: 'stylist-context' }; }
  const clothes = context?.clothes;
  if (!Array.isArray(clothes) || clothes.some((c) => typeof c?.ref !== 'string'
    || STYLIST_FORBIDDEN_KEYS.some((key) => Object.hasOwn(c, key)))) return { reason: 'stylist-context' };
  const last = messages.at(-1);
  if (last.role !== 'user') return { reason: 'stylist-messages' };
  return { mode: STYLIST_MODES[last.content] ?? 'stylist-ready', refs: clothes.slice(0, 2).map((c) => c.ref), clothes: clothes.length };
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
  if (body?.response_format?.json_schema?.name === 'stylist_reply') return stylistVerdict(body);
  const url = body?.messages?.[1]?.content?.[0]?.image_url?.url;
  if (body?.model !== DEPLOYMENT || body.stream !== false || body.n !== 1 || body.store !== false) return { reason: 'parameters' };
  if (typeof url !== 'string' || !url.startsWith('data:image/jpeg;base64,')) return { reason: 'image-url' };
  const width = jpegWidth(Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64'));
  return width === null ? { reason: 'jpeg' } : { mode: MODES[width] ?? 'ready' };
}
export function stylistCompletion(mode, refs = []) {
  // Above both envelopes and the reservation: ceil((30000*220 + 5000*1320)/100) = 132000 > 129360 micro-USD.
  const usage = mode === 'stylist-overrun' ? { ...USAGE, prompt_tokens: 30000, completion_tokens: 5000, total_tokens: 35000 } : USAGE;
  const reply = mode === 'stylist-tool-text' ? '{"tool_calls":[{"function":{"name":"save_outfit","arguments":"{}"}}]}'
    : 'Try these together.';
  const content = JSON.stringify({ reply, outfits: mode === 'stylist-unknown-ref' ? [{ refs: ['i999'], note: '' }]
    : refs.length ? [{ refs, note: 'Everyday' }] : [] });
  const message = mode === 'stylist-refusal' ? { role: 'assistant', refusal: 'I cannot help with that.', content: null }
    : mode === 'stylist-tool' ? { role: 'assistant', refusal: null, content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'save_outfit', arguments: '{}' } }] }
      : { role: 'assistant', refusal: null, content };
  return { model: RETURNED_MODEL, usage, choices: [{ index: 0, finish_reason: mode === 'stylist-tool' ? 'tool_calls' : 'stop', message }] };
}
// BG2b-1: the images edit double. The exact frozen multipart (L1) is required; the input width selects the mode.
export const ENHANCE_DEPLOYMENT = 'eval-image25-sunburst-20260908';
export const ENHANCE_FIELDS = Object.freeze([['model', ENHANCE_DEPLOYMENT], ['n', '1'], ['size', '1024x1280'], ['quality', 'medium'],
  ['output_format', 'jpeg'], ['output_compression', '85'], ['background', 'opaque']]);
/**
 * sha256 of the prompt the Edge function sends: CLEANUP_PROMPT since BG2c-1 (the cleanup-v1 manifest's prompt_sha256).
 * The v1 prompt is refused like any other change.
 */
export const ENHANCE_PROMPT_SHA256 = '2c909f6b4c7446df89d45400aff2cffab01f384c4e4eca6e6b60ecea9453bd86';
export const ENHANCE_MODES = Object.freeze({ 800: 'enhance-ok', 801: 'enhance-metadata', 802: 'enhance-trailing',
  803: 'enhance-second-frame', 804: 'enhance-filtered', 805: 'enhance-rate-limited', 806: 'enhance-no-usage' });
export const ENHANCE_USAGE = Object.freeze({ input_tokens: 1400, output_tokens: 2000, total_tokens: 3400,
  input_tokens_details: { text_tokens: 150, image_tokens: 1250 } });

const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
  Buffer.from(payload)]);
/**
 * A decodable flat-colour baseline JPEG, byte-identical to tests/fixtures/restore-jpeg-fixtures.ts flatJpeg in its
 * default baseline form (canonical JFIF, all quantizers 8, 4:2:0, one DC value per component and no AC detail).
 */
export function flatBaselineJpeg(width, height, colour = [180, 110, 150]) {
  const bytes = [];
  let buffer = 0, count = 0;
  const write = (value, length) => {
    for (let bit = length - 1; bit >= 0; bit--) {
      buffer = (buffer << 1) | ((value >> bit) & 1);
      if (++count === 8) { bytes.push(buffer); if (buffer === 0xff) bytes.push(0); buffer = 0; count = 0; }
    }
  };
  const writeDc = (diff) => {
    let size = 0;
    for (let magnitude = Math.abs(diff); magnitude; magnitude >>= 1) size++;
    write(size, 4);
    if (size) write(diff >= 0 ? diff : diff + (1 << size) - 1, size);
  };
  const sampling = [[2, 2], [1, 1], [1, 1]];
  const dc = colour.map((value) => Math.round(value) - 128), predictors = [0, 0, 0];
  const mcus = Math.ceil(width / 16) * Math.ceil(height / 16);
  for (let mcu = 0; mcu < mcus; mcu++) {
    for (let index = 0; index < 3; index++) {
      for (let block = 0; block < sampling[index][0] * sampling[index][1]; block++) {
        writeDc(dc[index] - predictors[index]);
        predictors[index] = dc[index];
        write(0, 2);
      }
    }
  }
  while (count) write(1, 1);
  const dht = (tc, counts, values) => segment(0xc4, [tc << 4, ...counts, ...values]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    segment(0xdb, [0, ...new Array(64).fill(8)]),
    segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]),
    dht(0, [0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
    dht(1, [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0x00, 0xf0]),
    segment(0xda, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]), Buffer.from(bytes), Buffer.from([0xff, 0xd9])]);
}
/** The generated output for a mode: the admitted 1024x1280 photo, or a hostile variant the admission profile refuses. */
export function enhanceOutput(mode) {
  const good = flatBaselineJpeg(1024, 1280, [200, 120, 140]);
  const jfifEnd = 2 + 18;
  if (mode === 'enhance-metadata') {
    return Buffer.concat([good.subarray(0, jfifEnd), segment(0xe1, [...Buffer.from('Exif\0\0'), 0x4d, 0x4d, 0, 42]),
      segment(0xfe, [...Buffer.from('provider comment')]), good.subarray(jfifEnd)]);
  }
  if (mode === 'enhance-trailing') return Buffer.concat([good, Buffer.from([0, 1, 2, 3])]);
  if (mode === 'enhance-second-frame') {
    return Buffer.concat([good.subarray(0, good.length - 2),
      segment(0xc0, [8, 0xff, 0xff, 0xff, 0xff, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]), Buffer.from([0xff, 0xd9])]);
  }
  return good;
}
/** Bounded inspection of one images edit request. Returns the mode or a content-free reason. */
export async function enhanceVerdict(headers, body) {
  if (headers['api-key'] !== DUMMY_API_KEY) return { reason: 'api-key' };
  const type = headers['content-type'];
  if (typeof type !== 'string' || !/^multipart\/form-data; ?boundary=/.test(type)) return { reason: 'content-type' };
  let form;
  try { form = await new Response(body, { headers: { 'content-type': type } }).formData(); } catch { return { reason: 'multipart' }; }
  const entries = [...form.entries()];
  const keys = entries.map(([key]) => key);
  if (keys.join(',') !== [...ENHANCE_FIELDS.map(([key]) => key), 'prompt', 'image'].join(',')) return { reason: 'enhance-keys' };
  if (!ENHANCE_FIELDS.every(([key, value]) => form.get(key) === value)) return { reason: 'enhance-parameters' };
  const prompt = form.get('prompt');
  if (typeof prompt !== 'string' || createHash('sha256').update(prompt).digest('hex') !== ENHANCE_PROMPT_SHA256) return { reason: 'enhance-prompt' };
  const image = form.get('image');
  if (typeof image === 'string' || image.type !== 'image/jpeg') return { reason: 'enhance-image' };
  const width = jpegWidth(new Uint8Array(await image.arrayBuffer()));
  return width === null ? { reason: 'jpeg' } : { mode: ENHANCE_MODES[width] ?? 'enhance-ok' };
}
/** The status and JSON body the double returns for an enhancement mode. */
export function enhanceResponse(mode) {
  if (mode === 'enhance-filtered') return { status: 400, body: { error: { code: 'content_policy_violation', message: 'synthetic' } } };
  if (mode === 'enhance-rate-limited') return { status: 429, body: { error: { code: '429', message: 'synthetic' } } };
  const data = [{ b64_json: enhanceOutput(mode).toString('base64') }];
  return { status: 200, body: mode === 'enhance-no-usage' ? { created: 1, data } : { created: 1, data, usage: ENHANCE_USAGE } };
}
// VTO-1b: the try-on images edit double. The same frozen parameters as enhancement, then the fixed prompt for the
// step's slot and image[] = [person, garment]. The person's pixels select the mode; the output is one fixed photo.
/** sha256 of each slot's fixed try-on prompt (src/domain/tryon.ts TRYON_PROMPTS). */
export const TRYON_PROMPT_SHA256 = Object.freeze({
  one_piece: '165e9af0fc725de675db7c6a276c16a59b6ed0c5e34f68780f7fbb3210136784',
  top: '54dcbf9096530fd423eb1190845b3723adeb40aa762f3d673bae62bf840f46a2',
  bottom: 'e81cc7a7e85f3307d5d3826657bf04d587be932dddbce3e7afc60eda8a4c1a22',
  footwear: '4e2439bf92f0c3c4b3eff6e0520e7cfc020e14dd69c12c3cdab5a58393c68ff3',
});
/** A body photo in this colour is refused by the double's content filter. */
export const TRYON_FILTERED_COLOUR = Object.freeze([20, 20, 20]);
export const tryonOutput = () => flatBaselineJpeg(1024, 1280, [90, 140, 200]);
const filteredPerson = createHash('sha256').update(flatBaselineJpeg(1024, 1280, TRYON_FILTERED_COLOUR)).digest('hex');
/** True when the raw multipart carries the try-on image[] array (enhancement sends a single image). */
export const isTryOnBody = (body) => body.includes('name="image[]"');
/** Bounded inspection of one try-on request. Returns the mode and slot, or a content-free reason. */
export async function tryonVerdict(headers, body) {
  if (headers['api-key'] !== DUMMY_API_KEY) return { reason: 'api-key' };
  const type = headers['content-type'];
  if (typeof type !== 'string' || !/^multipart\/form-data; ?boundary=/.test(type)) return { reason: 'content-type' };
  let form;
  try { form = await new Response(body, { headers: { 'content-type': type } }).formData(); } catch { return { reason: 'multipart' }; }
  const keys = [...form.keys()];
  if (keys.join(',') !== [...ENHANCE_FIELDS.map(([key]) => key), 'prompt', 'image[]', 'image[]'].join(',')) return { reason: 'tryon-keys' };
  if (!ENHANCE_FIELDS.every(([key, value]) => form.get(key) === value)) return { reason: 'tryon-parameters' };
  const prompt = form.get('prompt');
  const promptSha = typeof prompt === 'string' ? createHash('sha256').update(prompt).digest('hex') : null;
  const slot = Object.keys(TRYON_PROMPT_SHA256).find((key) => TRYON_PROMPT_SHA256[key] === promptSha);
  if (slot === undefined) return { reason: 'tryon-prompt' };
  const [person, garment] = form.getAll('image[]');
  if (typeof person === 'string' || typeof garment === 'string' || person.type !== 'image/jpeg' || garment.type !== 'image/jpeg'
    || garment.size < 1) return { reason: 'tryon-image' };
  const personBytes = new Uint8Array(await person.arrayBuffer());
  if (jpegWidth(personBytes) !== 1024) return { reason: 'jpeg' };
  return { mode: createHash('sha256').update(personBytes).digest('hex') === filteredPerson ? 'tryon-filtered' : 'tryon-ok', slot };
}
/** The status and JSON body the double returns for a try-on mode. */
export function tryonResponse(mode) {
  // FILT1: Microsoft's documented images-API output refusal (code contentFilter, the fixed message), with no usage.
  if (mode === 'tryon-filtered') {
    return { status: 400, body: { error: { code: 'contentFilter',
      message: 'Generated image was filtered as a result of our safety system.' } } };
  }
  return { status: 200, body: { created: 1, data: [{ b64_json: tryonOutput().toString('base64') }], usage: ENHANCE_USAGE } };
}
export function completion(mode) {
  const content = mode === 'malformed' ? '{"outcome":"ready","fields":' : JSON.stringify(mode === 'unclear' ? UNCLEAR_FACTS : READY_FACTS);
  return { model: RETURNED_MODEL, usage: USAGE, choices: [{ index: 0, finish_reason: 'stop',
    message: { role: 'assistant', refusal: null, content } }] };
}

function main() {
  const counts = { served: 0, rejected: 0, refused: 0, modes: {}, refusals: [], stylistClothes: null };
  createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= 2 * 1024 * 1024) chunks.push(chunk); });
    req.on('end', async () => {
      const local = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1';
      if (req.method === 'GET' && req.url === '/__count' && local) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(counts)); return;
      }
      if (req.method === 'POST' && req.url === '/rejected') {
        counts.rejected += 1; res.writeHead(204); res.end(); return;
      }
      const enhance = req.method === 'POST' && req.url === '/images/edits';
      const raw = Buffer.concat(chunks);
      const verdict = req.method !== 'POST' || (req.url !== '/chat/completions' && !enhance) ? { reason: 'route' }
        : size > 2 * 1024 * 1024 ? { reason: 'size' }
          : enhance ? await (isTryOnBody(raw) ? tryonVerdict : enhanceVerdict)(req.headers, raw)
            : requestVerdict(req.headers, raw.toString('utf8'));
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
      if (mode.startsWith('enhance-') || mode.startsWith('tryon-')) {
        const { status, body } = mode.startsWith('tryon-') ? tryonResponse(mode) : enhanceResponse(mode);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (mode.startsWith('stylist-')) {
        counts.stylistClothes = verdict.clothes;
        res.end(JSON.stringify(stylistCompletion(mode, verdict.refs)));
        return;
      }
      res.end(JSON.stringify(completion(mode)));
    });
  }).listen(8080, '0.0.0.0');
  console.log('EDGE-DOUBLE listening');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
