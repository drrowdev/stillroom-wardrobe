// scripts/ci-chromium-sandbox.mjs finds the browser's processes by parentage, not by argv[0], because Chromium rewrites
// its command line. A fake /proc stands in for Linux here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { descendantsOf, hasFlag, ProcessReadError } from '../../scripts/ci-chromium-sandbox.mjs';

let proc = '';
afterEach(() => { if (proc) rmSync(proc, { recursive: true, force: true }); });
function fake(entries: [pid: number, ppid: number, cmdline: string | null][]) {
  proc = mkdtempSync(join(tmpdir(), 'fake-proc-'));
  mkdirSync(join(proc, 'self'));
  for (const [pid, ppid, cmdline] of entries) {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), 'status'), `Name:\tchrome\nState:\tS (sleeping)\nPPid:\t${ppid}\nSeccomp:\t2\n`);
    if (cmdline !== null) writeFileSync(join(proc, String(pid), 'cmdline'), cmdline);
  }
  return proc;
}

describe('Chromium process discovery', () => {
  it('walks the whole tree below the launcher and reads rewritten command lines', () => {
    const root = fake([
      [10, 1, 'node\0script\0'],
      [11, 10, '/home/runner/.cache/ms-playwright/chromium-1/chrome-linux64/chrome\0--headless\0'],
      [12, 11, '/home/runner/.cache/ms-playwright/chromium-1/chrome-linux64/chrome --type=zygote --no-zygote-sandbox'],
      [13, 12, '/proc/self/exe --type=renderer --lang=en-US'],
      [14, 1, 'unrelated --type=renderer'],
      [15, 13, null],
    ]);
    const found = descendantsOf(10, root);
    expect(found.map(entry => entry.pid).sort()).toEqual([11, 12, 13, 15]);
    expect(found.find(entry => entry.pid === 15)!.command).toBeNull();
    const renderers = found.filter(entry => hasFlag(entry.command, '--type=renderer'));
    expect(renderers.map(entry => entry.pid)).toEqual([13]);
    expect(renderers[0]!.status).toMatch(/^Seccomp:\s+2$/m);
  });

  it('matches whole flags only', () => {
    expect(hasFlag('/x --no-sandbox', '--no-sandbox')).toBe(true);
    expect(hasFlag('/x --no-sandbox=1', '--no-sandbox')).toBe(true);
    expect(hasFlag('/x --type=zygote --no-zygote-sandbox', '--no-sandbox')).toBe(false);
    expect(hasFlag('/x --type=renderer', '--type=renderer')).toBe(true);
    expect(hasFlag('/x --type=renderers', '--type=renderer')).toBe(false);
    expect(hasFlag(null, '--no-sandbox')).toBe(false);
  });
  it('fails closed when a live process status cannot be read at the first scan, and skips only ended processes', () => {
    const root = fake([
      [10, 1, 'node\0script\0'],
      [11, 10, '/x/chrome'],
      [12, 11, '/x/chrome --type=zygote'],
      [13, 12, '/x/chrome --type=renderer --no-sandbox'],
    ]);
    const failing = (code: string) => (file: string, encoding: 'utf8') => {
      if (file.replace(/\\/g, '/').endsWith('/12/status')) throw Object.assign(new Error(code), { code });
      return readFileSync(file, encoding);
    };
    // Unreadable (EACCES or anything else): the scan stops instead of losing 12 and the --no-sandbox renderer below it.
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
      expect(() => descendantsOf(10, root, failing(code))).toThrow(ProcessReadError);
    }
    // Gone: 12 ended between listing and reading, so its subtree is no longer attached and nothing is claimed about it.
    expect(descendantsOf(10, root, failing('ENOENT')).map(entry => entry.pid)).toEqual([11]);
    expect(descendantsOf(10, root, failing('ESRCH')).map(entry => entry.pid)).toEqual([11]);
    // A status without a parent is refused too.
    writeFileSync(join(root, '13', 'status'), 'Name:\tchrome\n');
    expect(() => descendantsOf(10, root)).toThrow(ProcessReadError);
  });
});