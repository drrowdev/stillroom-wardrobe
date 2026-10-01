import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountAnnouncer, announceDelayMs } from '../../src/features/wardrobe/count-announcement';

describe('count announcements', () => {
  let heard: number[];
  let announcer: CountAnnouncer;
  beforeEach(() => { vi.useFakeTimers(); heard = []; announcer = new CountAnnouncer(count => heard.push(count)); });
  afterEach(() => { announcer.dispose(); vi.useRealTimers(); });

  it('does not announce the first count (the wardrobe loading)', () => {
    announcer.update(12);
    vi.advanceTimersByTime(announceDelayMs * 2);
    expect(heard).toEqual([]);
  });

  it('announces once, with the final count, after rapid changes stop', () => {
    announcer.update(12);
    for (const count of [9, 7, 4]) { announcer.update(count); vi.advanceTimersByTime(announceDelayMs - 100); }
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(heard).toEqual([4]);
    vi.advanceTimersByTime(announceDelayMs * 3);
    expect(heard).toEqual([4]);
  });

  it('says nothing when the count ends where it was last announced', () => {
    announcer.update(12);
    announcer.update(5); announcer.update(12);
    vi.advanceTimersByTime(announceDelayMs);
    expect(heard).toEqual([]);
    announcer.update(5); vi.advanceTimersByTime(announceDelayMs);
    announcer.update(3); announcer.update(5); vi.advanceTimersByTime(announceDelayMs);
    expect(heard).toEqual([5]);
  });

  it('drops a pending announcement when disposed', () => {
    announcer.update(12); announcer.update(2);
    announcer.dispose();
    vi.advanceTimersByTime(announceDelayMs * 2);
    expect(heard).toEqual([]);
  });
});
