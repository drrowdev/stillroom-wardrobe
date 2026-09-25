import { describe, expect, it } from 'vitest';
// @ts-expect-error Executable CLI JavaScript has no TypeScript declaration.
import { assertNoSecretEnvironment, operate, parseArgs } from '../../scripts/resume-deletion.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const URL = 'https://abcdefghijklmnopqrst.supabase.co';

describe('resume-deletion operator tool', () => {
  it('accepts only the closed argument set', () => {
    expect(parseArgs(['--url', URL, '--owner', OWNER])).toMatchObject({ action: 'resume', owner: OWNER });
    expect(parseArgs(['--url', URL, '--owner', OWNER, '--grant', '--confirm', OWNER])).toMatchObject({ action: 'grant' });
    expect(parseArgs(['--url', URL, '--owner', OWNER, '--reconcile'])).toMatchObject({ action: 'reconcile' });
    expect(parseArgs(['--url', 'http://127.0.0.1:55321', '--purge-completed'])).toMatchObject({ action: 'purge', owner: null });
  });

  it.each([
    [['--url', URL, '--owner', OWNER, '--begin']],
    [['--url', URL, '--owner', OWNER, '--grant']],
    [['--url', URL, '--owner', OWNER, '--grant', '--confirm', '22222222-2222-4222-8222-222222222222']],
    [['--url', URL, '--owner', OWNER, '--reconcile', '--confirm', OWNER]],
    [['--url', URL, '--owner', OWNER, '--grant', '--reconcile', '--confirm', OWNER]],
    [['--url', URL, '--owner', OWNER, '--purge-completed']],
    [['--url', 'https://example.test', '--owner', OWNER]],
    [['--url', 'http://127.0.0.1:5432', '--owner', OWNER]],
    [['--url', URL, '--owner', 'not-a-uuid']],
    [['--url', URL, '--url', URL, '--owner', OWNER]],
  ])('refuses %j before any prompt or call', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });

  it('refuses service credentials in the environment', () => {
    expect(() => assertNoSecretEnvironment({ SUPABASE_SERVICE_ROLE_KEY: 'x' })).toThrow(/prompt/);
    expect(() => assertNoSecretEnvironment({ PATH: 'x' })).not.toThrow();
  });

  it('grants and reconciles only through deletion_control for the named existing owner and prints no key', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const call = async (path: string, init: { body?: unknown }) => {
      calls.push({ path, body: init.body });
      return { response: new Response(JSON.stringify({ stage: 'storage', attempts: 10, grants: 1 })), signal: new AbortController().signal };
    };
    const lines: string[] = [];
    await operate({ action: 'grant', owner: OWNER }, 'service-key-canary', call, (line: string) => lines.push(line));
    expect(calls).toEqual([{ path: '/rest/v1/rpc/deletion_control', body: { p_owner_id: OWNER, p_action: 'grant', p_op: null, p_code: null } }]);
    expect(lines.join('\n')).not.toContain('canary');
  });

  it('resumes with `resume`, never `begin`, and reports a missing job without creating one', async () => {
    const actions: string[] = [];
    const call = async (path: string, init: { body?: { p_action?: string } }) => {
      if (path === '/rest/v1/rpc/deletion_control') actions.push(String(init.body?.p_action));
      return { response: new Response(JSON.stringify({ code: 'P0002', message: 'Not available', details: null, hint: null }), { status: 404 }),
        signal: new AbortController().signal };
    };
    const lines: string[] = [];
    await expect(operate({ action: 'resume', owner: OWNER }, 'k', call, (line: string) => lines.push(line))).resolves.toBe(3);
    expect(actions).not.toContain('begin');
    expect(actions[0]).toBe('resume');
    expect(lines).toEqual(['resume: not_available']);
  });
});
