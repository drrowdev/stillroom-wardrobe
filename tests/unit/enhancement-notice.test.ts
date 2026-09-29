import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLEANUP_NOTICE_REVISION } from '../../src/domain/enhancement';
import { ENHANCE_NOTICE_KEYS } from '../../src/features/settings/enhance-store';
import messages from '../../src/i18n/messages.json';

// The owner-approved clean-up notice (G5a, #84), revision 2 (BG2c plan rev4 §9). Any change to these strings needs a
// new revision and a new pin.
describe('photo clean-up notice', () => {
  it('pins revision 2 over EN, FI and SV', () => {
    const notice = JSON.stringify({ noticeRevision: CLEANUP_NOTICE_REVISION,
      ...Object.fromEntries(ENHANCE_NOTICE_KEYS.map((key) => [key, messages[key]])) });
    expect(CLEANUP_NOTICE_REVISION).toBe(2);
    expect(createHash('sha256').update(notice).digest('hex')).toBe('9e875d9305a6e7d39c248c7b7f7130aeb6be7ca3fbded33a2f50b304cd6fca0d');
  });
  it('states what is sent, the redraw, identity changes, processing outside the EU and the monthly limit', () => {
    expect(ENHANCE_NOTICE_KEYS).toEqual(['enhanceC.noticeSent', 'enhanceC.noticeRedraw', 'enhanceC.noticeProcessing', 'enhanceC.noticeCharges']);
    expect(messages['enhanceC.noticeSent'].en).toBe('When this is on, the original photo inside your crop, background included, is sent to Microsoft Azure OpenAI after you tap Done. Only the photo is sent. Crop out people and anything private first.');
    expect(messages['enhanceC.noticeRedraw'].en).toBe('AI redraws the photo to show only the garment on a plain background. It can change details like logos or texture, change the shape, or make it look like a different item. The photo is marked "Edited with AI", and you can keep the original instead.');
    expect(messages['enhanceC.noticeProcessing'].en).toBe('Processing may happen outside the EU. Microsoft doesn\'t use it to train models, but may keep images for a limited time to check for abuse.');
    expect(messages['enhanceC.noticeCharges'].en).toBe('Each photo counts toward your monthly AI limit, even if you don\'t use the result.');
    expect(messages['enhanceC.noticeProcessing'].fi).toContain('EU:n ulkopuolella');
    expect(messages['enhanceC.noticeProcessing'].sv).toContain('utanför EU');
    expect(messages['enhanceC.noticeRedraw'].fi).toContain(messages['enhance.edited'].fi);
    expect(messages['enhanceC.noticeRedraw'].sv).toContain(messages['enhance.edited'].sv);
    expect(messages['enhanceC.noticeSent'].fi).toContain(messages['photo.applyCrop'].fi);
    expect(messages['enhanceC.noticeSent'].sv).toContain(messages['photo.applyCrop'].sv);
  });
});