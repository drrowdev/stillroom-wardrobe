import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CLEANUP_NOTICE_REVISION } from '../../src/domain/enhancement';
import { ENHANCE_NOTICE_KEYS } from '../../src/features/settings/enhance-store';
import messages from '../../src/i18n/messages.json';

// The DRAFT clean-up notice, revision 2 (BG2c plan rev4 §9). The owner approves the text and the Azure policy quotes
// before activation; any change to these strings needs a new revision (and a new pin).
describe('photo clean-up notice', () => {
  it('pins revision 2 over EN, FI and SV', () => {
    const notice = JSON.stringify({ noticeRevision: CLEANUP_NOTICE_REVISION,
      ...Object.fromEntries(ENHANCE_NOTICE_KEYS.map((key) => [key, messages[key]])) });
    expect(CLEANUP_NOTICE_REVISION).toBe(2);
    expect(createHash('sha256').update(notice).digest('hex')).toBe('16fc0108302fd114a524e54fd16e8d2021b7b5d97fb652bb67418a32afec85ee');
  });
  it('states what is sent, the redraw, identity changes, Global processing and the crop-out step', () => {
    expect(messages['enhanceC.noticeSent'].en).toContain('original, unmasked pixels');
    expect(messages['enhanceC.noticeSent'].en).toContain('people and objects inside the crop can be sent');
    expect(messages['enhanceC.noticeRedraw'].en).toContain('without hangers, other items or creases');
    expect(messages['enhanceC.noticeLabel'].en).toContain('look like a different item');
    expect(messages['enhanceC.noticeOnlyPhoto'].en).toContain('Crop out people and anything private');
    expect(messages['enhanceC.noticeProcessing'].en).toContain('including outside the EU');
    expect(messages['enhanceC.noticeProcessing'].fi).toContain('EU:n ulkopuolella');
    expect(messages['enhanceC.noticeProcessing'].sv).toContain('utanför EU');
    expect(messages['enhanceC.noticeOnlyPhoto'].en).toContain('Only the photo is sent');
  });
});