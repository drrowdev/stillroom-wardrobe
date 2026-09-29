import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN, LIMIT_MS, RUNS, buildEngineScript, checkBinding, fixtureOf, isPrivateIPv4, main, parseBenchArguments, renderPage, serveBench,
} from '../../scripts/engine-bench.mjs';

const C = 'c'.repeat(40);
const fakeGit = (head: string, porcelain = '') => (args: string[]) => {
  if (args[0] === 'rev-parse') return `${head}\n`;
  if (args[0] === 'status') return porcelain;
  throw new Error('unexpected git call');
};
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('bench:engine binding to the candidate', () => {
  it('refuses a dirty checkout, an untracked file, HEAD other than the candidate, and a missing or short SHA, before building', async () => {
    const cases: Array<[string[], (args: string[]) => string, RegExp]> = [
      [['--candidate', C], fakeGit(C, ' M src/app.tsx\n'), /not clean/],
      [['--candidate', C], fakeGit(C, '?? notes.txt\n'), /not clean/],
      [['--candidate', C], fakeGit('d'.repeat(40)), /is not the candidate/],
      [[], fakeGit(C), /--candidate must be/],
      [['--candidate', C.slice(0, 12)], fakeGit(C), /--candidate must be/],
    ];
    for (const [argv, git, reason] of cases) {
      const logs: string[] = [];
      let built = false;
      let served = false;
      const root = mkdtempSync(path.join(tmpdir(), 'stillroom-bench-'));
      temporary.push(root);
      const code = await main(argv, { git, root, log: (line) => logs.push(line),
        build: async () => { built = true; return ''; },
        serve: async () => { served = true; throw new Error('should not serve'); } });
      expect(code, argv.join(' ')).not.toBe(0);
      expect(logs.join('\n')).toMatch(reason);
      expect(built).toBe(false);
      expect(served).toBe(false);
    }
  });

  it('accepts only a clean checkout at the candidate', () => {
    expect(checkBinding(C, fakeGit(C))).toBeNull();
    expect(checkBinding(C, () => { throw new Error('no git'); })).toMatch(/cannot read/);
  });
});

describe('bench:engine hosts', () => {
  it('binds to loopback by default and to one RFC 1918 address with --lan', () => {
    expect(parseBenchArguments(['--candidate', C]).options).toMatchObject({ host: '127.0.0.1', port: 4180 });
    for (const address of ['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20']) {
      expect(parseBenchArguments(['--candidate', C, '--lan', address]).options?.host).toBe(address);
    }
  });

  it('refuses 0.0.0.0, loopback, public, link-local, IPv6 and malformed --lan addresses', () => {
    for (const address of ['0.0.0.0', '127.0.0.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '169.254.1.1', '192.169.0.1', '::', '::1', 'fe80::1',
      '192.168.001.1', '192.168.1', '192.168.1.256', 'localhost']) {
      expect(isPrivateIPv4(address), address).toBe(false);
      expect(parseBenchArguments(['--candidate', C, '--lan', address]).error, address).toMatch(/--lan must be/);
    }
  });

  it('serves the page with its CSP and stops by itself after the lifetime', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'stillroom-bench-'));
    temporary.push(root);
    const { html, headers } = renderPage({ sha: C, engineScript: 'var StillroomEngine = {};', fixture: { seed: 7, items: 500, contexts: 23, runs: RUNS } });
    writeFileSync(path.join(root, 'index.html'), html);
    writeFileSync(path.join(root, '_headers'), headers);
    const running = await serveBench({ root, host: '127.0.0.1', port: 0, lifetimeMs: 300 });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${running.url}/`);
    expect(await response.text()).toContain(C);
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    await running.closed;
    await expect(fetch(`${running.url}/`)).rejects.toThrow();
  });

  it('refuses to serve on any other host', async () => {
    await expect(serveBench({ root: tmpdir(), host: '0.0.0.0', port: 0, lifetimeMs: 100 })).rejects.toThrow(/refused host/);
  });
});

describe('bench:engine page', () => {
  it('builds the fictional 500-item engine with no network or storage calls, and shows the full SHA, fixture and acceptance rule', async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), 'stillroom-bench-engine-'));
    temporary.push(outDir);
    const engineScript = await buildEngineScript(outDir);
    const fixture = fixtureOf(engineScript);
    expect(fixture).toEqual({ seed: 7, items: 500, contexts: 23, runs: 5 });
    const { html, headers } = renderPage({ sha: C, engineScript, fixture });
    for (const word of FORBIDDEN) expect(html, word).not.toContain(word);
    expect(html).toContain(`Candidate <code>${C}</code>`);
    expect(html).toContain("'Candidate ' + sha");
    expect(html).toContain("' items, ' + 23 + ' contexts, seed ' + 7 + ', ' + 5 + ' runs'");
    expect(html).toContain(`median < ${LIMIT_MS} ms`);
    expect(html.match(/<script>/g)).toHaveLength(1);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    const hash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(headers).toContain(`script-src 'sha256-${hash}'`);
    expect(headers).toMatch(/default-src 'none'.*connect-src 'none'/);
  }, 120_000);

  it('uses the same seeded catalogue as the CI performance budget', () => {
    const entry = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'performance', 'engine-entry.ts'), 'utf8');
    expect(entry).toContain('export const fixture = { seed: 7, items: 500 } as const;');
    expect(entry).toContain('const items = catalog(fixture.seed, fixture.items);');
  });
});
