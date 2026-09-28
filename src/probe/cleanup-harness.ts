// BG2c operator probe harness (plan rev4 §11.2). Built only by `vite build --mode operator-probe` into the ignored
// `.probe-dist/`, served on loopback by `scripts/cleanup-probe-harness.mjs`, and never deployed: `checkStaticTree`
// refuses its entry and marker in any deploy tree. It runs the shipped code paths, not copies: the real BG1 model
// and runtime through `prepareCutout(..., wantCleanup = true)`, and the exact `cleanupCheck` on the stage's own
// decode and downsample. Inputs and outputs are base64 strings handed to and from the driver; nothing is stored.
import { browserStageImaging } from '../features/wardrobe/enhancement-runtime';
import { ambiguousReference, REFERENCE_HEIGHT, REFERENCE_WIDTH } from '../images/background/frame';
import { modelAssets } from '../images/background/model-assets';
import { backgroundSegmenter } from '../images/background/remover';
import { cleanupCheck, type CleanupVerdict } from '../images/fidelity';
import type { PhotoEdit } from '../images/photo-edit';
import { prepareCutout } from '../images/process-image';
import { isPhotoInputJpeg } from '../images/restore-jpeg';

export type HarnessAsset = { role: string; path: string; bytes: number; sha256: string; ok: boolean };
export type HarnessPrepared = {
  framed: boolean;
  cleanup: null | {
    h0: string; sha256: string; bytes: number; width: number; height: number; photoInput: boolean;
    reference: string; referenceBytes: number; referenceSha256: string; ambiguous: boolean;
    frame: { source: unknown; dest: unknown; canvas: unknown };
  };
};
export type HarnessMeasured = { h0Sha256: string; h2Sha256: string; referenceSha256: string; verdict: CleanupVerdict };
export type CleanupHarness = {
  verifyAssets: () => Promise<HarnessAsset[]>;
  prepare: (input: string, type: string, edit: PhotoEdit) => Promise<HarnessPrepared>;
  measure: (h0: string, reference: string, h2: string) => Promise<HarnessMeasured>;
};
declare global { interface Window { __stillroomCleanupHarness?: CleanupHarness } }

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (value) => value.toString(16).padStart(2, '0')).join('');
const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
function fromBase64(value: string): Uint8Array {
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index);
  return out;
}
function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

async function pixels(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8ClampedArray> {
  const frame = await browserStageImaging.decode(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), signal);
  try { return browserStageImaging.downsample(frame); } finally { frame.close(); }
}

const owner = new AbortController();
const segmenter = backgroundSegmenter(owner);

window.__stillroomCleanupHarness = {
  async verifyAssets() {
    const out: HarnessAsset[] = [];
    for (const asset of modelAssets) {
      const bytes = new Uint8Array(await (await fetch(asset.path, { cache: 'no-store' })).arrayBuffer());
      const sha256 = await digest(bytes);
      out.push({ role: asset.role, path: asset.path, bytes: bytes.byteLength, sha256, ok: bytes.byteLength === asset.bytes && sha256 === asset.sha256 });
    }
    return out;
  },
  async prepare(input, type, edit) {
    const prepared = await prepareCutout(new Blob([new Uint8Array(fromBase64(input))], { type }), undefined, edit, segmenter, false, true);
    const cleanup = prepared.cleanup;
    if (!cleanup) return { framed: prepared.framed, cleanup: null };
    const h0 = new Uint8Array(await cleanup.main.arrayBuffer());
    return {
      framed: prepared.framed,
      cleanup: {
        h0: toBase64(h0), sha256: await digest(h0), bytes: h0.byteLength, width: cleanup.width, height: cleanup.height,
        photoInput: isPhotoInputJpeg(h0, cleanup.width, cleanup.height),
        reference: toBase64(cleanup.reference), referenceBytes: cleanup.reference.byteLength, referenceSha256: await digest(cleanup.reference),
        ambiguous: ambiguousReference(cleanup.reference),
        frame: { source: cleanup.geometry.source, dest: cleanup.geometry.dest, canvas: cleanup.geometry.canvas },
      },
    };
  },
  async measure(h0Text, referenceText, h2Text) {
    const h0 = fromBase64(h0Text), reference = fromBase64(referenceText), h2 = fromBase64(h2Text);
    if (reference.byteLength !== REFERENCE_WIDTH * REFERENCE_HEIGHT) throw new Error('reference size');
    const signal = new AbortController().signal;
    const verdict = cleanupCheck(await pixels(h0, signal), reference, await pixels(h2, signal));
    return { h0Sha256: await digest(h0), h2Sha256: await digest(h2), referenceSha256: await digest(reference), verdict };
  },
};
