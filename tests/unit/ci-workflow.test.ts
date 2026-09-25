import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8').replaceAll('\r\n', '\n');
const config = readFileSync(path.join(root, 'playwright.config.ts'), 'utf8').replaceAll('\r\n', '\n');
const pwaConfig = readFileSync(path.join(root, 'playwright.pwa.config.ts'), 'utf8').replaceAll('\r\n', '\n');
const performanceConfig = readFileSync(path.join(root, 'playwright.performance.config.ts'), 'utf8').replaceAll('\r\n', '\n');

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
  'p6c-delete-account-ui': ['delete-account-en-desktop', 'delete-account-fi-mobile', 'delete-recovery-sv-desktop', 'delete-recovery-en-mobile'].map((name) => `p6c-visual/${name}.png`),
    'i23-shell-ui': ['update-en-desktop', 'install-en-desktop', 'update-fi-mobile', 'install-sv-mobile', 'install-fi-iphone'].map((name) => `i23-visual/${name}.png`),
  'i24-a11y-ui': ['leave-dialog-fi-320-200', 'delete-card-fi-320-200', 'outfit-leave-sv-320-200', 'deletion-resume-sv-320-200', 'update-sv-320-200']
    .map((name) => `i24-visual/${name}.png`),
  };

describe('CI workflow browser split', () => {
  it('declares exactly the App, WebKit photo, database, deletion rehearsal and performance jobs with fixed names and timeouts', () => {
    expect([...jobs.keys()]).toEqual(['app', 'webkit-photo', 'database', 'deletion-rehearsal', 'performance']);
    const names = [...jobs.values()].map((text) => /\n {4}name: (.+)\n/.exec(text)?.[1]);
    expect(names).toEqual(['App and browser contracts', 'WebKit photo contracts', 'Real local Supabase', 'Account deletion rehearsal',
      'Performance budgets']);
    expect(new Set(names).size).toBe(names.length);
    expect(job('app')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n');
    expect(job('webkit-photo')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n');
    expect(job('database')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n');
    expect(job('deletion-rehearsal')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 25\n');
    expect(job('performance')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n');
    expect(count(workflow, 'timeout-minutes:')).toBe(5);
  });

  it('selects every Playwright project exactly once across the two browser jobs', () => {
    const projects = [...config.matchAll(/\{ name: '([^']+)'|\n {6}name: '([^']+)'/g)].map((match) => match[1] ?? match[2]);
    expect(projects).toEqual(['chromium', 'mobile', 'webkit-photo']);
    expect(config).toContain("testMatch: ['image-processing.spec.ts', 'slice.spec.ts', 'profile.spec.ts', 'images.spec.ts', "
      + "'item-details.spec.ts', 'garment-fields.spec.ts', 'ai-photo-first.spec.ts', 'items.spec.ts', 'ux-l1a.spec.ts', "
      + "'ux-l1b.spec.ts', 'ux-l2a.spec.ts', 'outfits.spec.ts', 'today.spec.ts', 'weather.spec.ts', 'backup.spec.ts', 'lazy-routes.spec.ts', 'restore.spec.ts', 'delete-account.spec.ts'],");
    expect(config).toContain('  failOnFlakyTests: Boolean(process.env.CI),\n');
    expect(config).toContain('  forbidOnly: Boolean(process.env.CI),\n');
    const app = job('app'), webkit = job('webkit-photo');
    expect(count(workflow, 'npm run test:browser')).toBe(2);
    expect(count(workflow, 'npx playwright install')).toBe(4);
    expect(app).toContain('      - run: npx playwright install --with-deps chromium\n'
      + '      - run: npm run test:browser -- --project=chromium --project=mobile\n'
      + '      - run: npm run test:pwa\n');
    expect(count(workflow, 'npm run test:pwa')).toBe(1);
    // images.spec.ts launches Chromium to generate WebP fixtures when WebKit's canvas cannot encode them.
    expect(webkit).toContain('      - run: npx playwright install --with-deps chromium webkit\n'
      + '      - run: npm run test:browser -- --project=webkit-photo\n');
    const selected = [...workflow.matchAll(/--project=([a-z-]+)/g)].map((match) => match[1]).sort();
    expect(selected).toEqual([...projects].sort());
  });

  it('runs the production shell suite once, in the App job, as its own Playwright config that fails when nothing ran', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:pwa']).toBe('playwright test --config playwright.pwa.config.ts');
    expect(pwaConfig).toContain("  testDir: './tests/pwa',\n");
    expect(pwaConfig).toContain("  outputDir: './test-results/pwa-output',\n");
    expect(pwaConfig).toContain("  reporter: [['list'], ['./tests/pwa/executed-reporter.ts']],\n");
    expect(pwaConfig).toContain("  globalSetup: './tests/pwa/global-setup.ts',\n");
    expect(pwaConfig).toContain('  failOnFlakyTests: Boolean(process.env.CI),\n');
    expect(pwaConfig).toContain('  forbidOnly: Boolean(process.env.CI),\n');
    expect([...pwaConfig.matchAll(/\{ name: '([^']+)'/g)].map((match) => match[1])).toEqual(['pwa-prod']);
    expect(config).not.toContain('tests/pwa');
  });

  it('measures performance budgets in their own single-worker job and checks the bundle budget after the App build', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:performance']).toBe('playwright test --config playwright.performance.config.ts');
    expect(pkg.scripts['check:bundle']).toBe('node scripts/check-bundle-budget.mjs dist');
    expect(job('app')).toContain('      - run: npm run build\n      - run: npm run check:bundle\n');
    expect(count(workflow, 'npm run check:bundle')).toBe(1);
    expect(steps(job('performance'))).toEqual([
      checkout, setupNode, '      - run: npm ci --no-fund\n', '      - run: npx playwright install --with-deps chromium\n',
      '      - run: npm run test:performance\n\n',
    ]);
    expect(count(workflow, 'npm run test:performance')).toBe(1);
    for (const forbidden of ['upload-artifact', 'secrets.', 'env:', 'if:']) expect(job('performance')).not.toContain(forbidden);
    expect(performanceConfig).toContain("  testDir: './tests/performance',\n");
    expect(performanceConfig).toContain("  outputDir: './test-results/performance-output',\n");
    expect(performanceConfig).toContain('  fullyParallel: false,\n');
    expect(performanceConfig).toContain('  retries: 0,\n');
    expect(performanceConfig).toContain('  workers: 1,\n');
    expect(performanceConfig).toContain("  reporter: [['list'], ['./tests/pwa/executed-reporter.ts', { required: ['performance.spec.ts'] }]],\n");
    expect(performanceConfig).toContain("  globalSetup: './tests/performance/global-setup.ts',\n");
    expect(performanceConfig).toContain('  forbidOnly: Boolean(process.env.CI),\n');
    expect([...performanceConfig.matchAll(/\{ name: '([^']+)'/g)].map((match) => match[1])).toEqual(['performance']);
    expect(config).not.toContain('tests/performance');
    expect(pwaConfig).not.toContain('tests/performance');
  });

  it('keeps the WebKit job minimal: pinned setup, no uploads, secrets, env or suppression', () => {
    const webkit = job('webkit-photo');
    expect(steps(webkit)).toEqual([
      checkout, setupNode, '      - run: npm ci --no-fund\n', '      - run: npx playwright install --with-deps chromium webkit\n',
      '      - run: npm run test:browser -- --project=webkit-photo\n\n',
    ]);
    for (const forbidden of ['upload-artifact', 'secrets.', 'env:', 'CI:', 'if:']) expect(webkit).not.toContain(forbidden);
  });

  it('uploads each of the 20 browser artifacts exactly once, from the App job, success-only and exact-head named', () => {
    const app = job('app');
    const uploads = steps(app).filter((step) => step.includes(upload));
    expect(uploads).toHaveLength(20);
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
    expect(count(workflow, upload)).toBe(21);
    expect(count(job('database'), upload)).toBe(1);
    expect(job('database')).toContain('          name: database-types\n          path: src/data/database.types.ts\n'
      + '          if-no-files-found: error\n          retention-days: 1\n');
  });

  it('serializes the deletion rehearsal, checks the endpoint refusal first and gives it no secrets or uploads', () => {
    const rehearsal = job('deletion-rehearsal');
    expect(rehearsal).toContain('\n    permissions:\n      contents: read\n    concurrency:\n      group: deletion-rehearsal\n'
      + "      cancel-in-progress: false\n    env:\n      STILLROOM_DELETION_REHEARSAL: '1'\n    steps:\n");
    expect(steps(rehearsal)).toEqual([
      checkout, setupNode, '      - run: npm ci --no-fund\n',
      '      - name: Refuse an inherited Docker endpoint before anything starts\n        shell: bash -eo pipefail {0}\n        run: |\n'
        + '          if DOCKER_HOST=tcp://127.0.0.1:9 node scripts/run-deletion-rehearsal.mjs > "$RUNNER_TEMP/refusal.txt"; then\n'
        + '            exit 1\n          else\n            code=$?\n          fi\n          test "$code" -eq 3\n'
        + "          grep -Fqx 'REFUSED: ENDPOINT_OVERRIDE' \"$RUNNER_TEMP/refusal.txt\"\n"
        + '          test -z "$(docker ps -a --filter label=com.supabase.cli.project -q)"\n',
      '      - name: Publish container ports on loopback only\n        shell: bash -eo pipefail {0}\n        run: |\n          sudo install -d -m 0755 /etc/docker\n          if sudo test -s /etc/docker/daemon.json; then current="$(sudo cat /etc/docker/daemon.json)"; else current=\'{}\'; fi\n          printf \'%s\' "$current" | jq \'. + {"ip": "127.0.0.1", "default-network-opts": {"bridge": {"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"}}}\' \\\n            | sudo tee /etc/docker/daemon.json > /dev/null\n          sudo systemctl restart docker\n          docker info > /dev/null\n',
      '      - run: node scripts/run-deletion-rehearsal.mjs\n\n',
    ]);
    for (const forbidden of ['upload-artifact', 'secrets.', 'ALLOW_', 'SERVICE', 'db:start', 'playwright']) expect(rehearsal).not.toContain(forbidden);
    expect(count(workflow, 'run-deletion-rehearsal.mjs')).toBe(2);
  });

  it('pins every action and never tolerates errors or disables flaky-test failure', () => {
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
    expect(new Set(uses)).toEqual(new Set([
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
      'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      upload,
    ]));
    for (const id of ['app', 'webkit-photo', 'deletion-rehearsal', 'performance']) {
      expect(job(id).split(checkout).length - 1).toBe(1);
      expect(job(id).split(setupNode).length - 1).toBe(1);
    }
    for (const forbidden of ['continue-on-error', '|| true', 'set +e', 'failOnFlakyTests', '--retries', '--pass-with-no-tests',
      'CI: ', 'CI=']) {
      expect(workflow).not.toContain(forbidden);
    }
  });
});
