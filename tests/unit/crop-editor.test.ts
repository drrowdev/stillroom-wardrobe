// BG2c-2 (plan rev4 §3.1, R1): what Done does in the crop editor, with and without the pre-upload review mode, and
// that the review hint describes the editor only in review mode. Rendered to static markup; no DOM is needed.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cropDone } from '../../src/images/crop';
import { CropEditor } from '../../src/images/crop-editor';
import { FULL_CROP, ORIGINAL_EDIT, type PhotoEdit } from '../../src/images/photo-edit';

const changed: PhotoEdit = { turns: 1, crop: FULL_CROP };
const cropped: PhotoEdit = { turns: 0, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } };

describe('Done in the crop editor', () => {
  it('without review mode: unchanged Done cancels and changed Done applies (today\'s behaviour)', () => {
    expect(cropDone(ORIGINAL_EDIT, ORIGINAL_EDIT, true, false)).toEqual({ kind: 'cancel' });
    expect(cropDone(changed, ORIGINAL_EDIT, true, false)).toEqual({ kind: 'apply' });
    expect(cropDone(cropped, ORIGINAL_EDIT, true, false)).toEqual({ kind: 'apply' });
  });
  it('in review mode: unchanged and changed Done both accept, and say which', () => {
    expect(cropDone(ORIGINAL_EDIT, ORIGINAL_EDIT, true, true)).toEqual({ kind: 'accept', unchanged: true });
    expect(cropDone(changed, ORIGINAL_EDIT, true, true)).toEqual({ kind: 'accept', unchanged: false });
    expect(cropDone(cropped, cropped, true, true)).toEqual({ kind: 'accept', unchanged: true });
  });
  it('an invalid crop does nothing in either mode', () => {
    expect(cropDone(cropped, ORIGINAL_EDIT, false, false)).toBeNull();
    expect(cropDone(ORIGINAL_EDIT, ORIGINAL_EDIT, false, true)).toBeNull();
  });
});

describe('the review hint', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const render = (review: boolean) => renderToStaticMarkup(createElement(CropEditor, {
    preview: 'blob:fixture', width: 640, height: 800, accepted: ORIGINAL_EDIT, preparing: false, t: (key: string) => `[${key}]`,
    onApply: () => {}, onCancel: () => {}, ...(review ? { onAccept: () => {} } : {}),
  } as Parameters<typeof CropEditor>[0]));
  it('describes the editor only in review mode', () => {
    // The editor reads the page language on its first render; nothing else of the DOM is used by static rendering.
    vi.stubGlobal('document', { documentElement: { lang: 'en' } });
    const review = render(true), normal = render(false);
    expect(review).toContain('aria-describedby="crop-review-hint"');
    expect(review).toContain('<p id="crop-review-hint" class="notice">[enhance.reviewHint]</p>');
    expect(normal).not.toContain('crop-review-hint');
    expect(normal).not.toContain('[enhance.reviewHint]');
  });
});
