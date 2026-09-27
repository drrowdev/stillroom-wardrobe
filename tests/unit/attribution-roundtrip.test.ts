import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cliEnvironment, differing, expectedImported, terminal } from '../../scripts/attribution-roundtrip-rehearsal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('P6d genuine round-trip rehearsal helpers', () => {
  it('gives the CLIs only the publishable key and OS variables', () => {
    const env = cliEnvironment({ PATH: '/bin', HOME: '/home/x', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 's',
      TEST_A_PASSWORD: 'p', DATABASE_URL: 'd', PLAYWRIGHT_BROWSERS_PATH: '/pw' }, 'publishable');
    expect(env).toEqual({ SUPABASE_PUBLISHABLE_KEY: 'publishable', PATH: '/bin', HOME: '/home/x', PLAYWRIGHT_BROWSERS_PATH: '/pw' });
  });

  it('answers each terminal prompt in order and cancels an unexpected one', async () => {
    const tty = terminal(['first']);
    const lines: string[] = [];
    tty.stdin.on('data', (chunk: Buffer) => lines.push(String(chunk)));
    tty.stderr.write('Email: ');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    tty.stderr.write('Unexpected: ');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(lines).toEqual(['first\r', '\u0003\r']);
    expect(tty.left()).toBe(0);
    expect(tty.stdin.isTTY).toBe(true);
  });

  it('expects imported entries with every photo mapped and refuses an unmapped one', () => {
    const entry = { fields: { colours: { kind: 'ai_observed', value: ['navy'] } }, image_sha256: 'a'.repeat(64), model_id: 'm',
      origin: 'recorded', prompt_version: 2, source_image_id: 'old' };
    expect(expectedImported([entry, { ...entry, source_image_id: null }], new Map([['old', 'new']])))
      .toEqual([{ ...entry, origin: 'imported', source_image_id: 'new' }, { ...entry, origin: 'imported', source_image_id: null }]);
    expect(() => expectedImported([entry], new Map())).toThrow('UNMAPPED');
  });

  it('names differing entry keys and photo targets without values', () => {
    const entry = { fields: {}, image_sha256: 'a'.repeat(64), model_id: 'm', origin: 'imported', prompt_version: 2, source_image_id: 'x' };
    expect(differing([entry], [entry], new Set())).toBe('order');
    expect(differing([], [entry], new Set())).toBe('length-0-1');
    expect(differing(null, [entry], new Set())).toBe('length-none-1');
    expect(differing([{ ...entry, source_image_id: null, model_id: 'secret-value' }], [entry], new Set())).toBe('model_id+source_image_id-null');
    expect(differing([{ ...entry, source_image_id: 'y' }], [entry], new Set(['y']))).toBe('source_image_id-other-copy');
    expect(differing([{ ...entry, source_image_id: 'z' }], [entry], new Set(['y']))).toBe('source_image_id-unknown');
  });

  it('loads the decodable restore fixtures from Node through the narrow loader', () => {
    const script = pathToFileURL(path.join(root, 'scripts', 'attribution-roundtrip-rehearsal.mjs')).href;
    const fixtures = pathToFileURL(path.join(root, 'tests', 'fixtures', 'restore-jpeg-fixtures.ts')).href;
    const jpeg = pathToFileURL(path.join(root, 'src', 'images', 'jpeg.ts')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { registerFixtureLoader } = await import(${JSON.stringify(script)});
      registerFixtureLoader();
      const { flatJpeg } = await import(${JSON.stringify(fixtures)});
      const { assertSanitizedJpeg } = await import(${JSON.stringify(jpeg)});
      const bytes = flatJpeg({ width: 128, height: 96, colour: [90, 120, 140] });
      assertSanitizedJpeg(bytes, 128, 96);
      console.log('LOADED');
    `], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('LOADED\n');
    expect(result.status).toBe(0);
  });
});
