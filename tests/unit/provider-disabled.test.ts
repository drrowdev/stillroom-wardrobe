import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageEnhancementProvider } from '../../src/providers/enhancement';
import { recommend, type EngineItem } from '../../src/domain/recommendations';

const owner = '11111111-1111-4111-8111-111111111111';
const item = (id: string, category: EngineItem['category']): EngineItem => ({
  id, ownerId: owner, category, colours: ['navy'], seasons: ['summer'], formality: 1, warmth: 1, lowerCoverage: 2,
  minTemp: null, maxTemp: null, rainRating: null, windproof: null, favourite: false,
  availability: 'ready', lifecycle: 'active', excludeSuggestions: false, deleted: false,
});

afterEach(() => vi.restoreAllMocks());

describe('no provider or network in suggestions', () => {
  it('the enhancement provider stays unavailable and makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(imageEnhancementProvider.enhance()).resolves.toEqual({ status: 'unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('recommend makes no network request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = recommend({
      items: [item('a0000000-0000-4000-8000-000000000001', 'top'), item('a0000000-0000-4000-8000-000000000002', 'bottom'), item('a0000000-0000-4000-8000-000000000003', 'footwear')],
      context: { ownerId: owner, occasion: 'everyday', season: 'summer' },
    });
    expect(result.status).toBe('ideas');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
