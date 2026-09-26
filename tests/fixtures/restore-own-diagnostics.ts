// Bounded CI diagnostics for the restore-own gate. Only allowlisted, structured facts are reported: never the CLI's
// raw output, and nothing at all from output that failed the redaction check.
import { RESTORE_ROUTES } from '../../scripts/owner-transport.mjs';

export type DiagnosedRun = { code: number | null; signal: string | null; stdout: string; stderr: string };

const PROBLEMS = new Set(['usage', 'endpoint', 'key', 'environment', 'input', 'folder', 'busy', 'chromium', 'sandbox', 'images',
  'passphrase', 'invalid', 'missing', 'tooLarge', 'crossTty', 'otherAccount', 'declined', 'confirm', 'auth', 'refused',
  'unavailable', 'unreachable', 'recheck', 'cancelled', 'blocked', 'retry']);
const OUTCOMES = ['Restore complete.', 'Restore incomplete', 'Restore refused', 'Restore stopped'] as const;
// The CLI's fixed summary lines, which carry only counts.
const SUMMARIES = [
  /^Items: \d+ restored, \d+ already here, \d+ changed here and left as they are, \d+ in Trash and left, \d+ not finished, \d+ blocked, \d+ held back\.$/,
  /^Outfits: \d+ restored, \d+ left as they are\. History: \d+ restored, \d+ left as they are\.$/,
  /^Photos: \d+ written, \d+ already here, \d+ not needed or not reached, \d+ not finished, \d+ blocked\.$/,
  /^Restore incomplete: \d+ not finished, \d+ held back\. Completed changes remain\. Run the same command again to continue\.$/,
];
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Literal routes from the restore transport policy, and the owner photo shape with its IDs replaced.
const photo = /^(GET|POST) \/storage\/v1\/object\/wardrobe\/ID\/ID\/ID\/(?:main|thumb)\.jpg$/;
const known = (route: string) => RESTORE_ROUTES.includes(route) || photo.test(route);

/** `paths` are the proxy's `METHOD /path` entries; `answers` its `METHOD /path STATUS` entries for forwarded requests. */
export function restoreDiagnostics(run: DiagnosedRun, paths: readonly string[], clean: boolean, answers: readonly string[] = []) {
  const facts = [`exit=${Number.isInteger(run.code) ? run.code : 'none'}`, `signal=${/^SIG[A-Z0-9]{1,12}$/.test(run.signal ?? '') ? run.signal : 'none'}`];
  if (!clean) return ` ${facts.join(' ')} output=suppressed(redaction check failed)`;
  const text = `${run.stdout}\n${run.stderr}`;
  const lines = text.split('\n').filter(Boolean);
  const outcomes = OUTCOMES.filter(outcome => text.includes(outcome));
  const problems = [...new Set([...text.matchAll(/Restore (?:refused|incomplete) \(([A-Za-z]{1,32})\)/g)].map(match => match[1]!))];
  const knownProblems = problems.filter(problem => PROBLEMS.has(problem));
  const summaries = lines.filter(line => SUMMARIES.some(pattern => pattern.test(line)));
  const unique = [...new Set(paths.map(path => path.replace(uuid, 'ID')))];
  const routes = unique.filter(known);
  const statuses = new Map<string, number>();
  for (const answer of answers) {
    const match = /^(.*) (\d{3})$/.exec(answer.replace(uuid, 'ID'));
    if (match && known(match[1]!)) statuses.set(`${match[1]} ${match[2]}`, (statuses.get(`${match[1]} ${match[2]}`) ?? 0) + 1);
  }
  facts.push(`outcomes=${JSON.stringify(outcomes)}`, `problems=${JSON.stringify(knownProblems)}`,
    `unrecognizedProblems=${problems.length - knownProblems.length}`, `lines=${lines.length}`, `summaries=${JSON.stringify(summaries)}`,
    `routes=${JSON.stringify(routes.slice(0, 40))}`, `unrecognizedRoutes=${unique.length - routes.length}`,
    `statuses=${JSON.stringify([...statuses].map(([route, count]) => `${route} x${count}`).slice(0, 60))}`);
  return ` ${facts.join(' ')}`;
}
