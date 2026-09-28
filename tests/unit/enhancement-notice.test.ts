import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ENHANCE_NOTICE_REVISION } from '../../src/domain/enhancement';
import { ENHANCE_NOTICE_KEYS } from '../../src/features/settings/enhance-store';
import messages from '../../src/i18n/messages.json';

// The draft notice for revision 1. The owner approves the text and the Azure policy quotes before activation; any
// change to these strings needs a new revision (and a new pin).
describe('photo enhancement notice', () => {
  it('pins revision 1 over EN, FI and SV', () => {
    const notice = JSON.stringify({ noticeRevision: ENHANCE_NOTICE_REVISION,
      ...Object.fromEntries(ENHANCE_NOTICE_KEYS.map((key) => [key, messages[key]])) });
    expect(ENHANCE_NOTICE_REVISION).toBe(1);
    expect(createHash('sha256').update(notice).digest('hex')).toBe('11a60daa48717712a85fe34b2bfae34ef8caf93d3be611da6f0fa1877191baed');
  });
  it('keeps the redraw, Global processing and separate-consent facts', () => {
    expect(messages['enhanceC.noticeSent'].en).toContain('The photo is redrawn by AI');
    expect(messages['enhanceC.noticeProcessing'].en).toContain('including outside the EU');
    expect(messages['enhanceC.noticeProcessing'].fi).toContain('EU:n ulkopuolella');
    expect(messages['enhanceC.noticeProcessing'].sv).toContain('utanför EU');
    expect(messages['enhanceC.noticeOnlyPhoto'].en).toContain('Only the photo is sent');
  });
});