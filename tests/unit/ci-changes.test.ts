import { describe, expect, it } from 'vitest';
import { classify, isDocumentation } from '../../scripts/ci-changes.mjs';

const pr = (files: string[], parents = 2) => classify({ event: 'pull_request', parents, files });

describe('CI documentation-only classification', () => {
  it('lets a pull request that changes only documentation skip the heavy jobs', () => {
    expect(pr(['docs/cloud-development.md'])).toEqual({ heavy: false, reason: 'documentation only' });
    expect(pr(['docs/phase-5-result.md', 'blueprint/20-AI-MODELS-AND-WORKFLOWS.md', 'README.md', 'AGENTS.md',
      '.github/copilot-instructions.md', 'blueprint/.github/copilot-instructions.md', 'docs/dependencies.json']).heavy).toBe(false);
  });

  it('runs everything when any other file changes, including Markdown outside the root and the documentation folders', () => {
    for (const other of ['src/app/app.tsx', 'tests/unit/ci-workflow.test.ts', '.github/workflows/ci.yml', 'package.json', 'package-lock.json',
      'supabase/migrations/20260905000000_initial.sql', 'scripts/ci-changes.mjs', 'src/notes.md', 'tests/browser/README.md', '.github/pull_request_template.md',
      'playwright.config.ts', '.node-version', 'docs', 'blueprint', 'documentation/x.md', 'docsx/a.md']) {
      expect(pr(['docs/a.md', other]), other).toEqual({ heavy: true, reason: 'code or configuration changed' });
    }
  });

  it('fails safe: pushes, manual runs, unexpected history, no files or odd paths run everything', () => {
    expect(classify({ event: 'push', parents: 2, files: ['docs/a.md'] }).heavy).toBe(true);
    expect(classify({ event: 'workflow_dispatch', parents: 2, files: ['docs/a.md'] }).heavy).toBe(true);
    expect(classify({ event: 'pull_request_target', parents: 2, files: ['docs/a.md'] }).heavy).toBe(true);
    expect(pr(['docs/a.md'], 1)).toEqual({ heavy: true, reason: 'not a merge commit' });
    expect(pr(['docs/a.md'], 3).heavy).toBe(true);
    expect(pr([])).toEqual({ heavy: true, reason: 'no changed files found' });
    for (const odd of ['docs/../src/app.tsx', 'docs\\a.md', 'docs//a.md', './README.md', '/README.md', '', 'docs/./a.md']) {
      expect(isDocumentation(odd), odd).toBe(false);
    }
  });
});
