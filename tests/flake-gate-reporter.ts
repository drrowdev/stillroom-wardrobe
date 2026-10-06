import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { judgeFlakes, parseAllowlist, type KnownFlake } from '../scripts/flake-gate.mjs';

// Replaces failOnFlakyTests: a flaky test listed in tests/known-flakes.json passes with a warning annotation;
// any other flaky test fails the run. Hard failures are untouched. A malformed allowlist fails the run.
export default class FlakeGateReporter implements Reporter {
  private suite: Suite | undefined;
  private allowlist: KnownFlake[] | undefined;
  private problem: string | undefined;

  onBegin(config: FullConfig, suite: Suite) {
    this.suite = suite;
    try {
      this.allowlist = parseAllowlist(readFileSync(path.join(path.dirname(config.configFile ?? '.'), 'tests', 'known-flakes.json'), 'utf8'));
    } catch (error) {
      this.problem = error instanceof Error ? error.message : String(error);
    }
  }

  async onEnd(result: FullResult) {
    if (!this.allowlist) {
      console.error(`::error::${this.problem ?? 'Known flakes: the allowlist was not read.'}`);
      return { status: result.status === 'passed' ? 'failed' as const : result.status };
    }
    const results = (this.suite?.allTests() ?? []).map((test) => ({
      file: path.basename(test.location.file),
      // titlePath: root, project, file, then describe blocks and the test title.
      title: test.titlePath().slice(3).join(' \u203a '),
      project: test.parent.project()?.name ?? '',
      outcome: test.outcome(),
    }));
    const verdict = judgeFlakes(results, this.allowlist);
    for (const warning of verdict.warnings) console.log(`::warning::${warning}`);
    for (const error of verdict.errors) console.error(`::error::${error}`);
    if (verdict.failed && result.status === 'passed') return { status: 'failed' as const };
  }
}
