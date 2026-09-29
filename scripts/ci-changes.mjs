// Decides whether a CI run needs the heavy jobs. Only a pull request whose changes are all documentation may skip them;
// pushes, manual runs and anything that can't be classified run everything.
import { execFileSync } from 'node:child_process';
import { isMain } from './quality/files.mjs';

const DOCUMENTATION_FILES = new Set(['AGENTS.md', '.github/copilot-instructions.md']);

export function isDocumentation(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.split('/').some((part) => part === '' || part === '.' || part === '..')) return false;
  if (DOCUMENTATION_FILES.has(file)) return true;
  if (file.startsWith('docs/') || file.startsWith('blueprint/')) return true;
  return !file.includes('/') && file.endsWith('.md');
}

export function classify({ event, parents, files }) {
  if (event !== 'pull_request') return { heavy: true, reason: 'not a pull request' };
  // Checkout gives a pull request its test merge commit; its first parent is the base, so the diff is exactly the PR's effect.
  if (parents !== 2) return { heavy: true, reason: 'not a merge commit' };
  if (!Array.isArray(files) || files.length === 0) return { heavy: true, reason: 'no changed files found' };
  const other = files.find((file) => !isDocumentation(file));
  return other === undefined ? { heavy: false, reason: 'documentation only' } : { heavy: true, reason: 'code or configuration changed' };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (isMain(import.meta.url)) {
  let result;
  try {
    const event = process.env.GITHUB_EVENT_NAME ?? '';
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ').length - 1;
    const files = parents === 2 ? git(['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD']).split('\0').filter(Boolean) : [];
    result = classify({ event, parents, files });
    console.error(`CI changes: ${files.length} file(s); ${result.reason}.`);
  } catch {
    result = { heavy: true, reason: 'classification failed' };
    console.error('CI changes: classification failed; running everything.');
  }
  console.log(`heavy=${result.heavy}`);
}
