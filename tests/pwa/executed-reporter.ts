import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

// The production shell run fails unless every spec file actually executed at least one passing test.
const required = ['cache.spec.ts', 'update.spec.ts', 'visual.spec.ts'];

export default class ExecutedReporter implements Reporter {
  private readonly passed = new Map<string, number>();

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== 'passed') return;
    const file = test.location.file.replaceAll('\\', '/').split('/').at(-1) ?? '';
    this.passed.set(file, (this.passed.get(file) ?? 0) + 1);
  }

  async onEnd(result: FullResult) {
    const missing = required.filter((file) => !this.passed.get(file));
    if (missing.length === 0) return;
    console.error(`Production shell tests did not run: ${missing.join(', ')}`);
    return { status: result.status === 'passed' ? 'failed' as const : result.status };
  }
}
