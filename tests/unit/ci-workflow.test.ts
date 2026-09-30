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
const downloadArtifact = 'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093';
// Every heavy job waits for the change classification and runs unless it succeeded with an explicit heavy=false.
const heavyIf = "    if: ${{ !cancelled() && !(needs.changes.result == 'success' && needs.changes.outputs.heavy == 'false') }}\n";
const gate = `    needs: changes\n${heavyIf}`;
const heavyJobs = ['app-checks', 'app-browser', 'pwa', 'webkit-photo', 'database', 'deletion-rehearsal', 'performance'];
const ungated = (id: string) => {
  const text = job(id);
  expect(count(text, gate), id).toBe(1);
  expect(text, id).toMatch(/^ {2}[a-z-]+:\n {4}name: .+\n {4}needs: changes\n {4}if: /);
  return text.replace(gate, '');
};
const shard = '${{ matrix.shard }}';
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
  'i15-today-ui': ['ideas-en-desktop', 'missing-en-desktop', 'ideas-fi-mobile', 'missing-fi-mobile', 'pair-chooser-fi-mobile',
    'pair-chooser-fi-320-200', 'pair-hidden-en-desktop', 'avoided-pairs-sv-mobile']
    .map((name) => `i15-visual/${name}.png`),
  'i16-weather-ui': ['settings-en-desktop', 'settings-fi-mobile', 'today-forecast-en-desktop', 'today-forecast-fi-mobile', 'today-forecast-fi-320-200',
    'today-off-en-desktop', 'today-off-sv-320-200', 'today-indoors-sv-mobile', 'today-unavailable-fi-mobile']
    .map((name) => `i16-visual/${name}.png`),
  'i12-calendar-ui': ['month-en-desktop', 'day-looks-en-desktop', 'agenda-fi-mobile', 'plan-sv-mobile', 'month-fi-320-200']
    .map((name) => `i12-visual/${name}.png`),
  'i13-statistics-ui': ['overview-en-desktop', 'overview-fi-mobile', 'overview-sv-320-200'].map((name) => `i13-visual/${name}.png`),
  'bg1-background-ui': ['removed-en-desktop', 'working-sv-mobile', 'fallback-fi-mobile'].map((name) => `bg1-visual/${name}.png`),
  'bg2b-enhance-ui': ['enhancing-en-mobile', 'enhanced-en-desktop', 'fallback-sv-mobile', 'reverted-en-mobile', 'enhanced-fi-mobile',
    'settings-fi-mobile', 'review-en-mobile', 'ambiguous-fi-mobile'].map((name) => `bg2b-visual/${name}.png`),
  'p6a-backup-ui': ['backup-en-desktop', 'backup-parts-fi-mobile'].map((name) => `p6a-visual/${name}.png`),
  'p6b-restore-ui': ['restore-preview-en-desktop', 'restore-progress-sv-mobile', 'restore-reencoded-fi-mobile'].map((name) => `p6b-visual/${name}.png`),
  'p6c-delete-account-ui': ['delete-account-en-desktop', 'delete-account-fi-mobile', 'delete-recovery-sv-desktop', 'delete-recovery-en-mobile'].map((name) => `p6c-visual/${name}.png`),
  'i24-a11y-ui': ['leave-dialog-fi-320-200', 'delete-card-fi-320-200', 'outfit-leave-sv-320-200', 'deletion-resume-sv-320-200']
    .map((name) => `i24-visual/${name}.png`),
  'st1b-stylist-ui': ['chat-en-desktop', 'chat-fi-mobile', 'consent-sv-mobile', 'paused-en-320-200'].map((name) => `st1b-visual/${name}.png`),
  'ad1-admin-ui': ['spending-en-desktop', 'edit-confirm-fi-mobile', 'spending-sv-320-200', 'settings-note-en-mobile'].map((name) => `ad1-visual/${name}.png`),
  'vto2-tryon-ui': ['consent-sv-mobile', 'progress-fi-mobile', 'result-en-desktop', 'failure-fi-320-200'].map((name) => `vto2-visual/${name}.png`),
  };
// Written by tests/pwa/visual.spec.ts, so they upload from the PWA job that runs it.
const pwaArtifacts: Record<string, string[]> = {
  'i23-shell-ui': ['update-en-desktop', 'install-en-desktop', 'update-fi-mobile', 'install-sv-mobile', 'install-fi-iphone'].map((name) => `i23-visual/${name}.png`),
  'i24-shell-ui': ['i24-visual/update-sv-320-200.png'],
};

// Approved CI-infrastructure change (PR #66): Ubuntu 24.04 blocks the sandboxed Chromium that restore-own uses unless an
// AppArmor profile lets exactly the pinned Playwright binary create user namespaces. The sandbox itself stays on.
const sandboxStep = [
  '      - name: Let the pinned Playwright Chromium use its sandbox (Ubuntu AppArmor user-namespace restriction)',
  '        shell: bash -euo pipefail {0}',
  '        run: |',
  '          chrome="$(node scripts/ci-chromium-sandbox.mjs --path)"',
  `          printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\n\\nprofile stillroom-playwright-chromium "%s" flags=(unconfined) {\\n  userns,\\n}\\n' "$chrome" | sudo tee /etc/apparmor.d/stillroom-playwright-chromium > /dev/null`,
  '          sudo apparmor_parser --replace /etc/apparmor.d/stillroom-playwright-chromium',
  '          node scripts/ci-chromium-sandbox.mjs --verify',
  '',
].join('\n');

describe('CI Chromium sandbox profile', () => {
  it('loads the profile for the pinned binary right after the Chromium install in the App browser and database jobs only', () => {
    const install = '      - run: npx playwright install --with-deps chromium\n';
    expect(workflow.split(sandboxStep).length - 1).toBe(2);
    for (const name of ['app-browser', 'database']) expect(job(name).split(install + sandboxStep).length - 1).toBe(1);
    for (const name of ['changes', 'docs', 'app-checks', 'app', 'pwa', 'webkit-photo', 'deletion-rehearsal', 'performance']) {
      expect(job(name)).not.toContain('ci-chromium-sandbox');
    }
    for (const forbidden of ['--no-sandbox', 'apparmor_restrict_unprivileged_userns', 'sysctl', '|| true', 'continue-on-error', '*']) {
      expect(sandboxStep.includes(forbidden)).toBe(false);
    }
    expect(workflow).not.toContain('--no-sandbox');
  });
});

describe('CI workflow browser split', () => {
  it('declares exactly the classification, documentation, App, PWA, WebKit photo, database, deletion rehearsal and performance jobs with fixed names and timeouts', () => {
    expect([...jobs.keys()]).toEqual(['changes', 'docs', 'app-checks', 'app-browser', 'app', 'pwa', 'webkit-photo', 'database', 'deletion-rehearsal', 'performance']);
    const names = [...jobs.values()].map((text) => /\n {4}name: (.+)\n/.exec(text)?.[1]);
    expect(names).toEqual(['Changed files', 'Documentation checks', 'App static checks', `App browser contracts (${shard}/3)`, 'App and browser contracts',
      'PWA production contracts', 'WebKit photo contracts', 'Real local Supabase', 'Account deletion rehearsal', 'Performance budgets']);
    expect(new Set(names).size).toBe(names.length);
    expect(job('changes')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n');
    expect(job('docs')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n');
    expect(job('app-checks')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 25\n    steps:\n');
    expect(job('app-browser')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 40\n    strategy:\n');
    expect(job('app')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    steps:\n');
    expect(job('pwa')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 20\n    steps:\n');
    expect(job('webkit-photo')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n    steps:\n');
    expect(job('database')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 30\n');
    expect(job('deletion-rehearsal')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 25\n');
    expect(job('performance')).toContain('\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n');
    expect(count(workflow, 'timeout-minutes:')).toBe(10);
  });

  it('selects every Playwright project exactly once across the two browser jobs, with the App projects in three shards', () => {
    const projects = [...config.matchAll(/\{ name: '([^']+)'|\n {6}name: '([^']+)'/g)].map((match) => match[1] ?? match[2]);
    expect(projects).toEqual(['chromium', 'mobile', 'webkit-photo', 'cleanup-timing', 'cleanup-timing-webkit']);
    expect(config).toContain("testMatch: ['image-processing.spec.ts', 'slice.spec.ts', 'profile.spec.ts', 'images.spec.ts', "
      + "'item-details.spec.ts', 'garment-fields.spec.ts', 'ai-photo-first.spec.ts', 'items.spec.ts', 'ux-l1a.spec.ts', "
      + "'ux-l1b.spec.ts', 'ux-l2a.spec.ts', 'outfits.spec.ts', 'today.spec.ts', 'weather.spec.ts', 'backup.spec.ts', 'lazy-routes.spec.ts', 'restore.spec.ts', 'delete-account.spec.ts', 'background-removal.spec.ts', 'enhancement.spec.ts', 'admin.spec.ts', 'tryon.spec.ts'],");
    expect(config).toContain('  failOnFlakyTests: Boolean(process.env.CI),\n');
    expect(config).toContain('  forbidOnly: Boolean(process.env.CI),\n');
    const app = job('app-browser'), webkit = job('webkit-photo');
    expect(count(workflow, 'npm run test:browser')).toBe(3);
    // BG2c-3: the clean-up timing budgets run isolated, serial and unretried, after the performance suite in its job.
    expect(config).toContain("    { name: 'chromium', testIgnore: 'cleanup-timing.spec.ts',");
    expect(config).toContain("    { name: 'mobile', testIgnore: 'cleanup-timing.spec.ts',");
    for (const name of ['cleanup-timing', 'cleanup-timing-webkit']) {
      expect(config).toContain(`    { name: '${name}', testMatch: 'cleanup-timing.spec.ts', fullyParallel: false, retries: 0, use: `);
    }
    expect(count(workflow, 'npx playwright install')).toBe(5);
    expect(app).toContain('    strategy:\n      fail-fast: false\n      matrix:\n        shard: [1, 2, 3]\n    steps:\n');
    expect(app).toContain('      - run: npx playwright install --with-deps chromium\n' + sandboxStep
      + `      - run: npm run test:browser -- --project=chromium --project=mobile --shard=${shard}/3\n`
      + "      - name: Stage this shard's visual evidence\n");
    expect(count(workflow, '--shard=')).toBe(1);
    for (const id of ['app-checks', 'app']) expect(job(id)).not.toContain('playwright');
    expect(app).not.toContain('test:pwa');
    expect(count(workflow, 'npm run test:pwa')).toBe(1);
    // images.spec.ts launches Chromium to generate WebP fixtures when WebKit's canvas cannot encode them.
    expect(webkit).toContain('      - run: npx playwright install --with-deps chromium webkit\n'
      + '      - run: npm run test:browser -- --project=webkit-photo\n');
    const selected = [...workflow.matchAll(/--project=([a-z-]+)/g)].map((match) => match[1]).sort();
    expect(selected).toEqual([...projects].sort());
  });

  it('runs the production shell suite once, in its own minimal PWA job and Playwright config that fails when nothing ran', () => {
    expect(steps(ungated('pwa')).filter((step) => !step.includes(upload))).toEqual([
      checkout, setupNode, '      - run: npm ci --no-fund\n', '      - run: npx playwright install --with-deps chromium\n',
      '      - run: npm run test:pwa\n',
    ]);
    for (const forbidden of ['secrets.', 'env:', 'if:', 'permissions:']) expect(ungated('pwa')).not.toContain(forbidden);
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
    expect(job('app-checks')).toContain('      - run: npm run build\n      - run: npm run check:bundle\n');
    expect(count(workflow, 'npm run check:bundle')).toBe(1);
    expect(steps(job('performance'))).toEqual([
      checkout, setupNode, '      - run: npm ci --no-fund\n', '      - run: npx playwright install --with-deps chromium webkit\n',
      '      - run: npm run test:performance\n',
      '      - run: npm run test:browser -- --project=cleanup-timing --project=cleanup-timing-webkit --workers=1\n\n',
    ]);
    expect(count(workflow, 'npm run test:performance')).toBe(1);
    for (const forbidden of ['upload-artifact', 'secrets.', 'env:', 'if:']) expect(ungated('performance')).not.toContain(forbidden);
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

  it('runs the Edge runtime gate last in the database job and the deploy-artifact check in the App static checks', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:edge']).toBe('node scripts/run-local-tests.mjs edge');
    expect(pkg.scripts['check:deploy-artifacts']).toBe('node scripts/check-deploy-artifacts.mjs');
    expect(steps(job('database')).at(-1)).toBe('      - run: npm run test:edge\n\n');
    // P6d: the genuine tag-history round trip runs on freshly reset accounts, just before the Edge gate.
    expect(steps(job('database')).at(-2)).toBe('      - name: P6d genuine tag-history round trip on freshly reset accounts\n        run: |\n'
      + '          npm run db:reset\n          node scripts/attribution-roundtrip-rehearsal.mjs\n');
    expect(count(workflow, 'attribution-roundtrip-rehearsal.mjs')).toBe(1);
    expect(count(workflow, 'npm run test:edge')).toBe(1);
    expect(job('app-checks')).toContain('      - run: npm run check:dependencies\n      - run: npm run check:deploy-artifacts\n');
    expect(count(workflow, 'npm run check:deploy-artifacts')).toBe(1);
  });

  it('keeps the WebKit job minimal: pinned setup, no uploads, secrets, env or suppression', () => {
    const webkit = ungated('webkit-photo');
    expect(steps(webkit)).toEqual([
      checkout, setupNode, '      - run: npm ci --no-fund\n', '      - run: npx playwright install --with-deps chromium webkit\n',
      '      - run: npm run test:browser -- --project=webkit-photo\n\n',
    ]);
    for (const forbidden of ['upload-artifact', 'secrets.', 'env:', 'CI:', 'if:']) expect(webkit).not.toContain(forbidden);
  });

  it('uploads each browser artifact exactly once, from the App job after all shards or the job whose suite writes it, success-only and exact-head named', () => {
    const uploaded = (id: string, expected: Record<string, string[]>) => steps(job(id)).filter((step) => step.includes(upload)).map((step) => {
      const name = /\n {10}name: ([a-z0-9-]+)-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\n/.exec(step)?.[1];
      expect(name, step).toBeDefined();
      expect(step).toContain(`        uses: ${upload}\n`);
      expect(step).toContain('\n          if-no-files-found: error\n          retention-days: 1\n');
      expect(step).not.toContain('if:');
      const files = [...step.matchAll(/\n {12}test-results\/(\S+)/g)].map((match) => match[1]);
      expect(files).toEqual(expected[name!]);
      return name!;
    });
    const app = uploaded('app', browserArtifacts), pwa = uploaded('pwa', pwaArtifacts);
    expect(app).toEqual(Object.keys(browserArtifacts));
    expect(pwa).toEqual(Object.keys(pwaArtifacts));
    // The App job publishes the named captures only after every shard passed and all three shards' evidence has been merged.
    const collect = [
      '      - name: Require the static checks and every browser shard to pass\n        env:\n'
        + '          CHECKS: ${{ needs.app-checks.result }}\n          BROWSER: ${{ needs.app-browser.result }}\n'
        + '        run: |\n          test "$CHECKS" = success\n          test "$BROWSER" = success\n',
      `      - name: Collect the visual evidence from every shard\n        uses: ${downloadArtifact}\n        with:\n`
        + `          pattern: app-visual-shard-*${headSuffix}\n          path: test-results\n          merge-multiple: true\n`,
      '      - name: Require the evidence of all three shards\n        run: |\n'
        + '          test -f test-results/shard-1.txt\n          test -f test-results/shard-2.txt\n          test -f test-results/shard-3.txt\n',
    ];
    expect(steps(job('app')).slice(0, 3)).toEqual(collect);
    expect(steps(job('app')).slice(3).every((step) => step.includes(upload))).toBe(true);
    expect(steps(job('app-browser')).slice(-2)).toEqual([
      "      - name: Stage this shard's visual evidence\n        shell: bash -euo pipefail {0}\n        env:\n          SHARD: ${{ matrix.shard }}\n"
        + '        run: |\n          staged="$RUNNER_TEMP/visual"\n          mkdir -p "$staged"\n          for dir in test-results/*-visual; do\n'
        + '            if [ -d "$dir" ]; then cp -R "$dir" "$staged/"; fi\n          done\n          echo "$SHARD" > "$staged/shard-$SHARD.txt"\n',
      `      - name: Hand this shard's visual evidence to the App job\n        uses: ${upload}\n        with:\n`
        + `          name: app-visual-shard-${shard}${headSuffix}\n          path: \${{ runner.temp }}/visual/\n`
        + '          if-no-files-found: error\n          retention-days: 1\n\n',
    ]);
    // The PWA uploads come after the suite that writes them.
    expect(steps(job('pwa')).findIndex((step) => step.includes(upload))).toBe(steps(job('pwa')).indexOf('      - run: npm run test:pwa\n') + 1);
    for (const name of [...app, ...pwa]) expect(count(workflow, `name: ${name}${headSuffix}\n`)).toBe(1);
    expect(count(workflow, upload)).toBe(app.length + pwa.length + 2);
    expect(count(workflow, downloadArtifact)).toBe(1);
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
      downloadArtifact,
    ]));
    for (const id of ['docs', 'app-checks', 'app-browser', 'pwa', 'webkit-photo', 'database', 'deletion-rehearsal', 'performance']) {
      expect(job(id).split(checkout).length - 1).toBe(1);
      expect(job(id).split(setupNode).length - 1).toBe(1);
    }
    for (const forbidden of ['continue-on-error', '|| true', 'set +e', 'failOnFlakyTests', '--retries', '--pass-with-no-tests',
      'CI: ', 'CI=']) {
      expect(workflow).not.toContain(forbidden);
    }
  });
});

describe('CI documentation-only runs', () => {
  it('classifies the changes first, from the pull request merge commit, with no credentials, setup or secrets', () => {
    expect(steps(job('changes'))).toEqual([
      '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262\n        with:\n          persist-credentials: false\n          fetch-depth: 2\n',
      '      - name: Run the heavy jobs unless a pull request changes only documentation\n        id: classify\n'
        + '        run: node scripts/ci-changes.mjs >> "$GITHUB_OUTPUT"\n\n',
    ]);
    expect(job('changes')).toContain('\n    outputs:\n      heavy: ${{ steps.classify.outputs.heavy }}\n    steps:\n');
    for (const forbidden of ['needs:', 'if:', 'secrets.', 'env:', 'permissions:']) expect(job('changes')).not.toContain(forbidden);
    expect(workflow).toContain('\non:\n  push:\n    branches: [main]\n  pull_request:\n  workflow_dispatch:\n');
  });

  it('gates every heavy job on the classification and runs the light documentation job only when they are skipped', () => {
    for (const id of heavyJobs) ungated(id);
    expect(count(workflow, gate)).toBe(heavyJobs.length);
    expect(job('docs')).toContain("\n    name: Documentation checks\n    needs: changes\n"
      + "    if: ${{ needs.changes.result == 'success' && needs.changes.outputs.heavy == 'false' }}\n");
    expect(steps(job('docs'))).toEqual([checkout, setupNode, '      - run: npm ci --no-fund\n',
      '      - name: Set a secret-scan canary\n        run: echo "STILLROOM_SECRET_CANARY=$(openssl rand -hex 24)" >> "$GITHUB_ENV"\n',
      '      - run: npm run scan:secrets\n', '      - run: npm run check:dependencies\n', '      - run: npm run test:unit\n\n']);
    // The App job keeps its name, fails unless the static checks and every shard succeeded, and is skipped only with them.
    expect(job('app')).toContain(`\n    name: App and browser contracts\n    needs: [changes, app-checks, app-browser]\n${heavyIf}`);
    expect(count(workflow, '    needs:')).toBe(heavyJobs.length + 2);
    expect(count(workflow, '    if:')).toBe(heavyJobs.length + 2);
  });
});
// A small evaluator for the GitHub expression subset these conditions use (case-insensitive string comparison, empty
// strings falsy, and an implicit success() when a condition names no status function), so the pins test outcomes.
type Run = { result: string; heavy: string | undefined; cancelled: boolean };
function evaluate(condition: string, run: Run) {
  const source = /^\$\{\{ (.*) \}\}$/.exec(condition)?.[1] ?? condition;
  const tokens = source.match(/'[^']*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][A-Za-z0-9_.-]*\(\)|[A-Za-z_][A-Za-z0-9_.-]*|\S/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (token === undefined || (expected !== undefined && token !== expected)) throw new Error(`Unexpected ${token} in ${source}`);
    return token;
  };
  const contexts: Record<string, string> = {
    'needs.changes.result': run.result, 'needs.changes.outputs.heavy': run.heavy ?? '',
  };
  const statuses: Record<string, boolean> = { 'cancelled()': run.cancelled, 'always()': true,
    'success()': !run.cancelled && run.result === 'success', 'failure()': run.result === 'failure' };
  const value = (): string | boolean => {
    const token = take();
    if (token === '(') { const inner = or(); take(')'); return inner; }
    if (token.startsWith("'")) return token.slice(1, -1);
    const status = Object.hasOwn(statuses, token) ? statuses[token] : undefined;
    if (status !== undefined) return status;
    const context = Object.hasOwn(contexts, token) ? contexts[token] : undefined;
    if (context !== undefined) return context;
    throw new Error(`Unknown term ${token}`);
  };
  const truthy = (item: string | boolean) => item !== '' && item !== false;
  const compare = (): string | boolean => {
    const left = value();
    if (peek() !== '==' && peek() !== '!=') return left;
    const operator = take();
    const equal = String(left).toLowerCase() === String(value()).toLowerCase();
    return operator === '==' ? equal : !equal;
  };
  const unary = (): boolean | string => (peek() === '!' ? (take(), !truthy(unary())) : compare());
  const and = (): boolean | string => { let left = unary(); while (peek() === '&&') { take(); const right = unary(); left = truthy(left) && truthy(right); } return left; };
  const or = (): boolean | string => { let left = and(); while (peek() === '||') { take(); const right = and(); left = truthy(left) || truthy(right); } return left; };
  const result = truthy(or());
  if (at !== tokens.length) throw new Error(`Trailing tokens in ${source}`);
  return /\b(success|failure|cancelled|always)\(\)/.test(source) ? result : !run.cancelled && run.result === 'success' && result;
}
const condition = (id: string) => /\n {4}if: (.+)\n/.exec(job(id))?.[1] ?? '';

describe('CI documentation-only skip fails open', () => {
  const runs = (id: string, run: Run) => evaluate(condition(id), run);
  const heavyAndApp = [...heavyJobs, 'app'];

  it('skips the heavy jobs only after a successful classification that said heavy=false', () => {
    const docsOnly = { result: 'success', heavy: 'false', cancelled: false };
    for (const id of heavyAndApp) expect(runs(id, docsOnly), id).toBe(false);
    expect(runs('docs', docsOnly)).toBe(true);
  });

  it('runs everything, and not the light job, for heavy=true, empty, missing or unexpected output', () => {
    for (const heavy of ['true', '', undefined, 'maybe', '0', 'no', 'false\nheavy=true', ' false']) {
      const run = { result: 'success', heavy, cancelled: false };
      for (const id of heavyAndApp) expect(runs(id, run), `${id} ${String(heavy)}`).toBe(true);
      expect(runs('docs', run), String(heavy)).toBe(false);
    }
  });

  it('runs everything when the classification job failed or was skipped, even if it printed heavy=false first', () => {
    for (const result of ['failure', 'skipped']) {
      for (const heavy of ['false', '', undefined]) {
        const run = { result, heavy, cancelled: false };
        for (const id of heavyAndApp) expect(runs(id, run), `${id} ${result}`).toBe(true);
        expect(runs('docs', run), result).toBe(false);
      }
    }
  });

  it('runs nothing further once the workflow is cancelled', () => {
    for (const heavy of ['true', 'false', '']) {
      for (const id of [...heavyAndApp, 'docs']) expect(runs(id, { result: 'cancelled', heavy, cancelled: true }), id).toBe(false);
    }
  });

  it('evaluates the conditions it was given, not a model of them', () => {
    expect(() => evaluate("needs.changes.outputs.heavy == 'true' || github.event_name == 'push'", { result: 'success', heavy: '', cancelled: false }))
      .toThrow('Unknown term github.event_name');
    expect(evaluate("needs.changes.outputs.heavy != 'true'", { result: 'success', heavy: '', cancelled: false })).toBe(true);
    expect(evaluate("${{ !cancelled() && needs.changes.outputs.heavy == 'TRUE' }}", { result: 'failure', heavy: 'true', cancelled: false })).toBe(true);
  });
});