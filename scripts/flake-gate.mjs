// PROC1 flake gate (owner decision, #84 comment 6021407660). A test that failed and then passed on retry
// passes the run only when tests/known-flakes.json lists it (spec file plus full title, tied to a K2 entry);
// any other flaky test fails the run. A test that failed on every attempt is left failing by Playwright.

const keys = ['file', 'title', 'k2'];

export function parseAllowlist(text) {
  let entries;
  try {
    entries = JSON.parse(text);
  } catch {
    throw new Error('Known flakes: the allowlist is not valid JSON.');
  }
  if (!Array.isArray(entries)) throw new Error('Known flakes: the allowlist must be an array.');
  const seen = new Set();
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Known flakes: entry ${index} is not an object.`);
    const names = Object.keys(entry).sort();
    if (names.join() !== [...keys].sort().join()) throw new Error(`Known flakes: entry ${index} must have exactly ${keys.join(', ')}.`);
    for (const key of keys) {
      if (typeof entry[key] !== 'string' || entry[key].trim() !== entry[key] || entry[key] === '') {
        throw new Error(`Known flakes: entry ${index} has an empty or untrimmed ${key}.`);
      }
    }
    if (!/^[\w.-]+\.spec\.ts$/.test(entry.file)) throw new Error(`Known flakes: entry ${index} file must be a spec file name without a path.`);
    if (!entry.k2.startsWith('K2 ')) throw new Error(`Known flakes: entry ${index} must cite its K2 entry.`);
    const id = `${entry.file}\n${entry.title}`;
    if (seen.has(id)) throw new Error(`Known flakes: entry ${index} is a duplicate.`);
    seen.add(id);
    return Object.freeze({ file: entry.file, title: entry.title, k2: entry.k2 });
  });
}

// results: [{ file, title, project, outcome }] with Playwright's test outcome
// ('expected' | 'unexpected' | 'flaky' | 'skipped'). Returns the failure decision and the annotations to print.
export function judgeFlakes(results, allowlist) {
  const known = new Map(allowlist.map((entry) => [`${entry.file}\n${entry.title}`, entry]));
  const warnings = [], errors = [];
  for (const result of results) {
    if (result.outcome !== 'flaky') continue;
    const name = `[${result.project}] ${result.file} \u203a ${result.title}`;
    const entry = known.get(`${result.file}\n${result.title}`);
    if (entry) warnings.push(`Known flaky test passed on retry: ${name} (${entry.k2})`);
    else errors.push(`New flaky test (failed, then passed on retry; not in tests/known-flakes.json): ${name}`);
  }
  return { failed: errors.length > 0, warnings, errors };
}
