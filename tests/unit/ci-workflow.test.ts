import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replaceAll('\r\n', '\n');
const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8').replaceAll('\r\n', '\n');

const jobsText = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
const jobs = new Map(jobsText.split(/\n(?= {2}[A-Za-z0-9_-]+:\n)/).map((block) => {
  const id = /^ {2}([A-Za-z0-9_-]+):\n/.exec(block)?.[1];
  if (!id) throw new Error('Unparsed job block');
  return [id, `${block}\n`] as const;
}));
const job = (id: string) => {
  const text = jobs.get(id);
  if (!text) throw new Error(`Missing job ${id}`);
  return text;
};
const steps = (text: string) => text.split(/(?=^ {6}- )/m).slice(1);
const count = (text: string, value: string) => text.split(value).length - 1;

const checkout = '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          persist-credentials: false\n';
const setupNode = '      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\n        with:\n          node-version-file: .node-version\n          cache: npm\n';
const upload = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02';
const headSuffix = '-${{ github.event.pull_request.head.sha || github.sha }}';
const browserArtifacts: Record<string, string[]> = {
  'i06-profile-ui': ['i06-visual/profile-en-desktop.png', 'i06-visual/profile-fi-mobile.png'],
  'i07-capture-ui': ['i07-visual/crop-en-desktop.png', 'i07-visual/crop-fi-mobile.png'],
  'i29b-item-details-ui': ['i29b-visual/item-details-en-desktop.png', 'i29b-visual/item-details-fi-mobile.png'],
  'i29c-garment-fields-ui': ['i29c-visual/garment-fields-en-desktop.png', 'i29c-visual/garment-fields-fi-mobile.png'],
  'i29-photo-first-ui': ['consent-en-desktop', 'consent-fi-mobile', 'analyzed-draft-en-desktop', 'analyzed-draft-fi-mobile']
    .map((name) => `i29-photo-first-visual/${name}.png`),
  'ux-l1a-ui': ['add-ready', 'add-failed', 'more-details', 'saved-item']
    .flatMap((name) => [`ux-l1a-visual/${name}-en-desktop.png`, `ux-l1a-visual/${name}-fi-mobile.png`]),
  'ux-l1b-ui': ['crop', 'crop-exact', 'photo-actions']
    .flatMap((name) => [`ux-l1b-visual/${name}-en-desktop.png`, `ux-l1b-visual/${name}-fi-mobile.png`]),
  'ux-l2a-ui': ['settings-off', 'settings-details', 'settings-on', 'settings-unavailable']
    .flatMap((name) => [`ux-l2a-visual/${name}-en-desktop.png`, `ux-l2a-visual/${name}-fi-mobile.png`]),
  'ux-copy-ui': ['sign-in', 'recovery', 'wardrobe-empty']
    .flatMap((name) => [`ux-copy-visual/${name}-en-desktop.png`, `ux-copy-visual/${name}-fi-mobile.png`]),
  'i08-item-lifecycle-ui': ['trash-en-desktop', 'trash-fi-mobile', 'delete-en-desktop', 'delete-fi-mobile']
    .map((name) => `i08-visual/${name}.png`),
  'i09-wardrobe-ui': ['i09-visual/wardrobe-grid-en-desktop.png', 'i09-visual/wardrobe-filters-fi-mobile.png'],
  'i10b-image-lifecycle-ui': ['i10b-visual/replacement-en-desktop.png', 'i10b-visual/recovery-fi-mobile.png',
    'i10b-visual/deletion-resume-sv-mobile.png'],
  'i11-outfits-ui': ['list-en-desktop', 'editor-en-desktop', 'detail-en-desktop', 'list-fi-mobile', 'editor-fi-mobile', 'detail-fi-mobile']
    .map((name) => `i11-visual/${name}.png`),
  'i15-today-ui': ['ideas-en-desktop', 'missing-en-desktop', 'ideas-fi-mobile', 'missing-fi-mobile']
    .map((name) => `i15-visual/${name}.png`),
  'i16-weather-ui': ['settings-en-desktop', 'settings-fi-mobile', 'today-forecast-en-desktop', 'today-unavailable-fi-mobile']
    .map((name) => `i16-visual/${name}.png`),
  'p6a-backup-ui': ['backup-en-desktop', 'backup-parts-fi-mobile'].map((name) => `p6a-visual/${name}.png`),
  'p6b-restore-ui': ['restore-preview-en-desktop', 'restore-progress-sv-mobile'].map((name) => `p6b-visual/${name}.png`),
};

describe('CI workflow browser split', () => {
  it('declares exactly the App, WebKit photo and database jobs with fixed names and timeouts', () => {
    expect([...jobs.keys()]).toEqual(['app', 'webkit-photo', 'database']);
    const names = [...jobs.values()].map((text) => /\n {4}name: (.+)\n/.exec(text)?.[1]);
    expect(names).toEqual(['App and browser contracts', 'WebKit photo contracts', 'Real local Supabase']);
    expect(new Set(names).size).toBe(names.length);
    expect(job('app')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n');
    expect(job('webkit-photo')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n');
    expect(job('database')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n');
    expect(count(workflow, 'timeout-minutes:')).toBe(3);
  });

  it('selects every Playwright project exactly once across the two browser jobs', () => {
    const projects = [...config.matchAll(/\{ name: '([^']+)'|\n {6}name: '([^']+)'/g)].map((match) => match[1] ?? match[2]);
    expect(projects).toEqual(['chromium', 'mobile', 'webkit-photo']);
    expect(config).toContain("testMatch: ['image-processing.spec.ts', 'slice.spec.ts', 'profile.spec.ts', 'images.spec.ts', "
      + "'item-details.spec.ts', 'garment-fields.spec.ts', 'ai-photo-first.spec.ts', 'items.spec.ts', 'ux-l1a.spec.ts', "
      + "'ux-l1b.spec.ts', 'ux-l2a.spec.ts', 'outfits.spec.ts', 'today.spec.ts', 'weather.spec.ts', 'backup.spec.ts', 'lazy-routes.spec.ts', 'restore.spec.ts'],");
    expect(config).toContain('  failOnFlakyTests: Boolean(process.env.CI),\n');
    expect(config).toContain('  forbidOnly: Boolean(process.env.CI),\n');
    const app = job('app'), webkit = job('webkit-photo');
    expect(count(workflow, 'npm run test:browser')).toBe(2);
    expect(count(workflow, 'npx playwright install')).toBe(3);
    expect(app).toContain('      - run: npx playwright install --with-deps chromium\n'
      + '      - run: npm run test:browser -- --project=chromium --project=mobile\n');
    // images.spec.ts launches Chromium to generate WebP fixtures when WebKit's canvas cannot encode them.
    expect(webkit).toContain('      - run: npx playwright install --with-deps chromium webkit\n'
      + '      - run: npm run test:browser -- --project=webkit-photo\n');
    const selected = [...workflow.matchAll(/--project=([a-z-]+)/g)].map((match) => match[1]).sort();
    expect(selected).toEqual([...projects].sort());
  });

  it('keeps the WebKit job minimal: pinned setup, no uploads, secrets, env or suppression', () => {
    const webkit = job('webkit-photo');
    expect(steps(webkit)).toEqual([
      checkout, setupNode, '      - run: npm ci --no-fund\n', '      - run: npx playwright install --with-deps chromium webkit\n',
      '      - run: npm run test:browser -- --project=webkit-photo\n\n',
    ]);
    for (const forbidden of ['upload-artifact', 'secrets.', 'env:', 'CI:', 'if:']) expect(webkit).not.toContain(forbidden);
  });

  it('uploads each of the 17 browser artifacts exactly once, from the App job, success-only and exact-head named', () => {
    const app = job('app');
    const uploads = steps(app).filter((step) => step.includes(upload));
    expect(uploads).toHaveLength(17);
    const seen = uploads.map((step) => {
      const name = /\n {10}name: ([a-z0-9-]+)-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\n/.exec(step)?.[1];
      expect(name, step).toBeDefined();
      expect(step).toContain(`        uses: ${upload}\n`);
      expect(step).toContain('\n          if-no-files-found: error\n          retention-days: 1\n');
      expect(step).not.toContain('if:');
      const files = [...step.matchAll(/\n {12}test-results\/(\S+)/g)].map((match) => match[1]);
      expect(files).toEqual(browserArtifacts[name!]);
      return name!;
    });
    expect(seen).toEqual(Object.keys(browserArtifacts));
    for (const name of seen) expect(count(workflow, `name: ${name}${headSuffix}\n`)).toBe(1);
    expect(count(workflow, upload)).toBe(18);
    expect(count(job('database'), upload)).toBe(1);
    expect(job('database')).toContain('          name: database-types\n          path: src/data/database.types.ts\n'
      + '          if-no-files-found: error\n          retention-days: 1\n');
  });

  it('pins every action and never tolerates errors or disables flaky-test failure', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    expect(new Set(uses)).toEqual(new Set([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      upload,
    ]));
    for (const id of ['app', 'webkit-photo']) {
      expect(job(id).split(checkout).length - 1).toBe(1);
      expect(job(id).split(setupNode).length - 1).toBe(1);
    }
    for (const forbidden of ['continue-on-error', '|| true', 'set +e', 'failOnFlakyTests', '--retries', '--pass-with-no-tests',
      'CI: ', 'CI=']) {
      expect(workflow).not.toContain(forbidden);
    }
  });
});
