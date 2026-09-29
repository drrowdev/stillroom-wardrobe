// CIEDE2000, shared by the BG2c clean-up check (tests/unit/cleanup-check.test.ts covers the check itself). The BG2b
// compareEnhancement tests were removed with the function in BG2c-2.
import { describe, expect, it } from 'vitest';
import { deltaE2000 } from '../../src/images/fidelity';

describe('CIEDE2000', () => {
  it('matches the Sharma, Wu and Dalal reference pairs', () => {
    expect(deltaE2000(50, 2.6772, -79.7751, 50, 0, -82.7485)).toBeCloseTo(2.0425, 4);
    expect(deltaE2000(50, -1, 2, 50, 0, 0)).toBeCloseTo(2.3669, 4);
    expect(deltaE2000(50, 2.5, 0, 73, 25, -18)).toBeCloseTo(27.1492, 4);
    expect(deltaE2000(2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514)).toBeCloseTo(0.9082, 4);
    expect(deltaE2000(60, 0, 0, 60, 0, 0)).toBe(0);
  });
});
