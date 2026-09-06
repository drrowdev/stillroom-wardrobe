import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { PrivateImages } from '../../src/images/private-images';
import type { Database } from '../../src/data/database.types';

const owner = '10000000-0000-4000-8000-000000000001';
const path = (number: number) => `${owner}/20000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-${String(number).padStart(12, '0')}/thumb.jpg`;
function makePool() {
  const pending: Array<(response: Response) => void> = [];
  const download = vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve)));
  const client = createClient<Database>('http://127.0.0.1:54321', 'public-fixture', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: download },
  });
  const controller = new AbortController();
  const pool = new PrivateImages(client, { ownerId: owner, epoch: 1, signal: controller.signal });
  return { pending, download, controller, pool };
}
const response = () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });

describe('session-scoped private media', () => {
  it('coalesces requests and revokes URLs on owner invalidation', async () => {
    const { pending, download, controller, pool } = makePool();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const first = pool.get(path(1));
    const second = pool.get(path(1));
    expect(first).toBe(second);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0]!(response());
    const url = await first;
    expect(download).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(revoke).toHaveBeenCalledWith(url);
    await expect(pool.get(path(1))).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('caps concurrent media downloads at four', async () => {
    const { pending, pool } = makePool();
    const promises = Array.from({ length: 6 }, (_, index) => pool.get(path(index + 1)));
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    pending[0]!(response());
    pending[1]!(response());
    await vi.waitFor(() => expect(pending).toHaveLength(6));
    for (let index = 2; index < 6; index++) pending[index]!(response());
    await Promise.all(promises);
    pool.clear();
  });
  it('discards in-flight bytes after unmount and supports a fresh lifecycle', async () => {
    const { pending, pool } = makePool();
    const first = pool.get(path(1));
    const settled = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pool.clear();
    pool.activate();
    pending[0]!(response());
    expect(await settled).toMatchObject({ name: 'AbortError' });
    const next = pool.get(path(2));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!(response());
    expect(await next).toMatch(/^blob:/);
    pool.clear();
  });
  it('refuses another owner path before a network request', () => {
    const { pool, download } = makePool();
    expect(() => pool.get(path(1).replace(owner, '40000000-0000-4000-8000-000000000001'))).toThrow();
    expect(download).not.toHaveBeenCalled();
    pool.clear();
  });
});
