#!/usr/bin/env node
// Restores your own Stillroom backup into your account, the same way Restore in the app does:
//   node scripts/restore-own.mjs BACKUP_FOLDER [--local http://127.0.0.1:PORT] [--yes] [--allow-other-account] [--report json]
// BACKUP_FOLDER holds the parts from the Backup card or scripts/export-own.mjs. Sign-in uses your normal email and
// password (typed at the prompt, or three piped lines: email, password, passphrase); nothing secret is accepted from
// arguments, the environment or files, and no administrator key is ever used. Every part and photo is checked, and every
// photo decoded and planned in the locked Playwright Chromium, before signing in: a backup that fails there makes no
// request. The restore then uses the app's own checked writes: nothing is overwritten or deleted, an item changed here is
// left as it is, and no analysis is requested. It is not one transaction: a run that stops keeps what it completed, and
// running the same command again continues.
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTerminalLine, PromptError } from './backup-prompt.mjs';
import { acquireLock, ExportError, forbiddenEnvironment, nodeFiles, publishableKey, readSecrets, releaseLock, resolveEndpoint, signIn } from './export-own.mjs';
import { ownerTransport, restorePolicy } from './owner-transport.mjs';
import { registerSourceLoader } from './src-loader.mjs';
import { listParts, partSource } from './verify-backup.mjs';

export const LOCK = '.stillroom-restore.lock';

// Only fixed text and counts leave the process: no path, title, email or identifier from the backup or the account.
const MESSAGES = {
  usage: 'Usage: node scripts/restore-own.mjs BACKUP_FOLDER [--local http://127.0.0.1:PORT] [--yes] [--allow-other-account] [--report json]',
  endpoint: 'Only the Stillroom project, or --local with a loopback address and port, can be restored to.',
  key: 'Set SUPABASE_PUBLISHABLE_KEY to the project\'s publishable key. Secret keys are refused.',
  environment: 'Administrator or database credentials are set in this environment. Remove them and run again.',
  input: 'Expected the email, password and passphrase as three lines. The passphrase needs at least 16 characters.',
  folder: 'The backup folder can\'t be used. It must hold only the parts of one backup.',
  busy: `Another restore is using this folder. If no restore is running, delete ${LOCK} (and ${LOCK}.reclaim, if present) from the folder that contains the backup folder, then run again.`,
  chromium: 'Photos are checked in the Playwright Chromium, which isn\'t installed. Run `npx playwright install chromium` in the repository, then run again.',
  sandbox: 'Chromium couldn\'t start its sandbox on this system, and it isn\'t run without one. Nothing was changed. See docs/phase-6-result.md (Linux: Chromium sandbox), or use Restore in the app.',
  images: 'Photos couldn\'t be checked: Chromium didn\'t start or stopped. Nothing was changed. Run again; if it keeps failing, use Restore in the app.',
  passphrase: 'That passphrase doesn\'t open this backup. Nothing was changed.',
  invalid: 'This backup can\'t be restored: a part or photo failed its checks. Nothing was changed.',
  missing: 'Parts of this backup are missing. Nothing was changed.',
  tooLarge: 'This backup is larger than a restore can read. Nothing was changed.',
  crossTty: 'Restoring a backup made by another account needs a terminal: run it without piped input.',
  otherAccount: 'This backup was made by a different account. To add its contents to the account you signed in with, run again on a terminal with --allow-other-account.',
  declined: 'Nothing was changed.',
  confirm: 'Piped input can\'t confirm a restore. Add --yes to restore without asking.',
  auth: 'Sign-in failed or the session ended. Check your email and password, then run the same command again.',
  refused: 'A request outside what a restore needs was refused. Nothing more was changed.',
  unavailable: 'Stillroom couldn\'t be reached. Completed changes remain. Run the same command again to continue.',
  unreachable: 'Stillroom couldn\'t be reached. Nothing was changed. Run the same command again.',
  recheck: 'A backup file changed or failed its checks after it was checked. The restore stopped; completed changes remain. Run the same command again: every file is checked again first.',
  cancelled: 'Cancelled. Completed changes remain. Run the same command again to continue.',
};
const OTHER_ACCOUNT_NOTICE = 'This backup was made by a different account. The app can\'t tell whether it was you. '
  + 'Type restore to add its contents to the account you signed in with: ';

export const EXIT = Object.freeze({ complete: 0, refused: 1, retry: 2, recheck: 3, kept: 5, blocked: 6, cancelled: 130 });

export class RestoreOwnError extends Error {
  constructor(code) { super(code); this.name = 'RestoreOwnError'; this.code = code; }
}
const refuse = (code) => { throw new RestoreOwnError(code); };

export function parseArguments(argv) {
  const options = { folder: undefined, local: undefined, yes: false, allowOther: false, json: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (typeof name !== 'string' || !name) refuse('usage');
    if (!name.startsWith('-')) {
      if (options.folder !== undefined) refuse('usage');
      options.folder = resolve(name);
      continue;
    }
    if (seen.has(name)) refuse('usage');
    seen.add(name);
    if (name === '--yes') options.yes = true;
    else if (name === '--allow-other-account') options.allowOther = true;
    else if (name === '--local' || name === '--report') {
      const value = argv[++index];
      if (typeof value !== 'string' || !value || value.startsWith('-')) refuse('usage');
      if (name === '--local') options.local = value;
      else if (value === 'json') options.json = true;
      else refuse('usage');
    } else refuse('usage');
  }
  if (options.folder === undefined) refuse('usage');
  return options;
}

/** The shared restore engine, loaded as the app's own TypeScript (see scripts/src-loader.mjs). */
export async function loadEngine() {
  registerSourceLoader();
  return import('../src/data/restore.ts');
}

// Each call reads the part from disk again, bounded, so restoring never uses what the check kept in memory.
function backupFiles(listing) {
  const source = partSource(listing);
  return [...listing.paths.entries()].sort(([a], [b]) => a - b)
    .map(([index, part]) => ({ name: basename(part.path), size: part.size, text: () => source.read(index) }));
}

const planKey = (photos) => JSON.stringify([...photos.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  .map(([id, plan]) => [id, plan.main, plan.reason, plan.sourceSha256, plan.mainSha256, plan.thumbSha256, plan.width, plan.height]));

function engineProblem(error, guard) {
  if (guard.refused) return 'refused';
  if (error instanceof RestoreOwnError) return error.code;
  if (error instanceof ExportError) return { invalid: 'refused', busy: 'busy', cancelled: 'cancelled', input: 'input', usage: 'usage',
    endpoint: 'endpoint', key: 'key', environment: 'environment', auth: 'auth' }[error.code] ?? 'unavailable';
  if (error?.name === 'RestoreRecheckError') return 'recheck';
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  const key = error?.messageKey;
  if (key === 'restore.wrong') return 'passphrase';
  if (key === 'restore.invalid') return 'invalid';
  if (key === 'restore.missing') return 'missing';
  if (key === 'restore.tooLarge') return 'tooLarge';
  if (error?.name === 'BackupFormatError') return { passphrase: 'passphrase', incomplete: 'missing', tooLarge: 'tooLarge' }[error.problem] ?? 'invalid';
  return 'unavailable';
}
const EXIT_OF = { recheck: EXIT.recheck, unavailable: EXIT.retry, cancelled: EXIT.cancelled };

function summaryLines(result) {
  const photos = { written: 0, present: 0, skipped: 0, failed: 0, blocked: 0 };
  for (const photo of result.photos) photos[photo.outcome]++;
  return [
    `Items: ${result.restored} restored, ${result.same} already here, ${result.conflicts} changed here and left as they are, `
      + `${result.trash} in Trash and left, ${result.failed} not finished, ${result.blocked} blocked, ${result.deferred} held back.`,
    `Outfits: ${result.outfits} restored, ${result.outfitConflicts} left as they are. History: ${result.history} restored, ${result.historyConflicts} left as they are.`,
    `Photos: ${photos.written} written, ${photos.present} already here, ${photos.skipped} not needed or not reached, ${photos.failed} not finished, ${photos.blocked} blocked.`,
  ];
}
function jsonReport(result) {
  const { photos, ...counts } = result;
  return JSON.stringify({ counts, photos: photos.map(photo => ({ sourceImageId: photo.sourceImageId, outcome: photo.outcome,
    planned: photo.planned, stored: photo.stored })) });
}

/** The exit code and closing message for a restore that returned. */
export function outcomeOf(result) {
  if (result.blocked > 0) {
    const blockedPhotos = result.photos.filter(photo => photo.outcome === 'blocked').length;
    return { code: EXIT.blocked, message: 'Restore incomplete. Completed changes remain; blocked photos and their dependents were not completed. '
      + `Blocked: ${result.blocked} items, ${blockedPhotos} photos; held back: ${result.deferred} outfits, rules, feedback or history entries.` };
  }
  if (result.failed > 0 || result.deferred > 0) {
    return { code: EXIT.retry, message: `Restore incomplete: ${result.failed} not finished, ${result.deferred} held back. Completed changes remain. Run the same command again to continue.` };
  }
  if (result.conflicts + result.trash + result.outfitConflicts + result.historyConflicts > 0) {
    return { code: EXIT.kept, message: 'Restore complete. Some entries were changed here or are in Trash, and were left as they are.' };
  }
  return { code: EXIT.complete, message: 'Restore complete.' };
}

async function confirm(deps, question, expected) {
  try {
    const answer = await readTerminalLine({ input: deps.stdin, output: deps.stderr, prompt: question, hidden: false, limit: 64 });
    return answer === expected;
  } catch (error) {
    if (error instanceof PromptError && error.problem === 'cancelled') refuse('cancelled');
    return false;
  }
}

// Runs one restore. All effects come through `deps`, so tests can replace the network, the disk, the photo worker and the clock.
export async function runRestoreOwn(deps) {
  const { argv, env, stdin, stdout, stderr } = deps;
  const signal = deps.signal ?? new AbortController().signal;
  const context = {
    files: deps.files ?? nodeFiles, fetchImpl: deps.fetchImpl ?? fetch, now: deps.now ?? Date.now, platform: deps.platform ?? process.platform,
    guard: { owner: null, refused: false, signal }, client: null, lock: null, storagePrefix: 'stillroom-restore',
  };
  let secrets = null, worker = null;
  const say = (text) => stderr.write(`${text}\n`);
  try {
    const options = parseArguments(argv);
    if (forbiddenEnvironment(env)) refuse('environment');
    context.origin = resolveEndpoint(env, options.local);
    context.key = publishableKey(env);
    // B5: the override is only ever confirmed on a terminal, so a piped run that asks for it is refused before anything else.
    if (options.allowOther && !stdin.isTTY) refuse('crossTty');
    let listing;
    try { listing = await listParts(options.folder); } catch { refuse('folder'); }
    await acquireLock(context, dirname(options.folder), LOCK);
    const startWorker = deps.startImageWorker ?? (await import('./restore-image-client.mjs')).startImageWorker;
    const engine = await (deps.loadEngine ?? loadEngine)();
    secrets = await readSecrets(deps, false);
    const { passphrase } = secrets;
    try { worker = await startWorker({ env }); } catch (error) { refuse(error?.code === 'missing' ? 'chromium' : error?.code === 'sandbox' ? 'sandbox' : 'images'); }
    const files = backupFiles(listing);
    // Offline: every part and photo checked, every photo planned. Nothing has been requested yet.
    say('Checking the backup and its photos...');
    let checked;
    try { checked = await engine.preflightBackup(files, passphrase, signal, worker.deps); }
    catch (error) { if (worker.failure()) refuse('images'); throw error; }
    context.transport = ownerTransport({ origin: context.origin, key: context.key, fetchImpl: context.fetchImpl, state: context.guard,
      policy: restorePolicy, refusal: () => new RestoreOwnError('refused'), observe: deps.observeRequest });
    const ownerId = await signIn(context, secrets);
    secrets.email = secrets.password = '';
    // B5: the account is the one the server signed in (the token's subject), never inferred from the email.
    if (checked.backup.data.sourceOwner !== ownerId) {
      if (!options.allowOther) refuse('otherAccount');
      if (!await confirm(deps, OTHER_ACCOUNT_NOTICE, 'restore')) refuse('declined');
    }
    const scope = { ownerId, epoch: 0, signal };
    let preview;
    try { preview = await engine.checkBackup(context.client, scope, files, passphrase, signal, worker.deps); }
    catch (error) { if (worker.failure()) refuse('images'); throw error; }
    if (planKey(preview.photos) !== planKey(checked.photos) || preview.backup.data.exportId !== checked.backup.data.exportId
      || preview.backup.data.sourceOwner !== checked.backup.data.sourceOwner) refuse('recheck');
    const { counts } = preview;
    say(`Ready to restore: ${counts.add} items to add, ${counts.same} already here, ${counts.conflicts} changed here (left as they are), `
      + `${counts.trash} in Trash (left), ${counts.outfits} outfits, ${preview.backup.data.events.length} history entries.`);
    if (counts.reencoded > 0) say(`${counts.reencoded} photos will be re-encoded.`);
    if (!options.yes) {
      if (!stdin.isTTY) refuse('confirm');
      if (!await confirm(deps, 'Type yes to restore: ', 'yes')) refuse('declined');
    }
    let result;
    try {
      result = await engine.runRestore(context.client, scope, preview, signal, ({ done, total }) => { if (done > 0) say(`Items: ${done} of ${total}.`); });
    } catch (error) {
      const partial = engine.restoreReport();
      const problem = worker.failure() ? 'images' : engineProblem(error, context.guard);
      if (partial) {
        for (const line of summaryLines(partial)) say(line);
        if (options.json) stdout.write(`${jsonReport(partial)}\n`);
      }
      throw new RestoreOwnError(problem === 'images' ? 'imagesAfter' : problem);
    }
    for (const line of summaryLines(result)) stdout.write(`${line}\n`);
    if (options.json) stdout.write(`${jsonReport(result)}\n`);
    const outcome = outcomeOf(result);
    // A refused request or a stopped Chromium inside an item counts there as not finished; neither is fixed by running again.
    // The report above stays; BLOCKED keeps its exit code and message, and the problem is reported beside it.
    const inside = context.guard.refused ? 'refused' : worker.failure() ? 'images' : null;
    if (inside && outcome.code !== EXIT.blocked) throw new RestoreOwnError(inside === 'images' ? 'imagesAfter' : 'refused');
    if (inside) say(`Also (${inside}): ${inside === 'refused' ? MESSAGES.refused : 'Photos couldn\'t be checked: Chromium stopped.'}`);
    (outcome.code === EXIT.complete || outcome.code === EXIT.kept ? stdout : stderr).write(`${outcome.message}\n`);
    return outcome.code;
  } catch (failure) {
    let problem = engineProblem(failure, context.guard);
    let code = EXIT_OF[problem] ?? EXIT.refused;
    if (problem === 'imagesAfter') { problem = 'images'; code = EXIT.retry; }
    // Before sign-in nothing can have been changed.
    if (problem === 'unavailable' && !context.guard.owner) problem = 'unreachable';
    const message = problem === 'images' && code === EXIT.retry
      ? 'Photos couldn\'t be checked: Chromium stopped. Completed changes remain. Run the same command again to continue.'
      : `${MESSAGES[problem] ?? MESSAGES.unavailable}${failure?.detail ?? ''}`;
    say(`Restore ${code === EXIT.refused ? 'refused' : 'incomplete'} (${problem}). ${message}`);
    return code;
  } finally {
    if (secrets) secrets.email = secrets.password = secrets.passphrase = '';
    if (context.client) {
      await context.client.auth.stopAutoRefresh().catch(() => {});
      if (context.guard.owner) await context.client.auth.signOut({ scope: 'local' }).catch(() => {});
      context.client = null;
    }
    await worker?.close().catch(() => {});
    await releaseLock(context).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--check-load' && process.argv.length === 3) {
    // Loads the whole restore engine the way a restore does, and nothing else.
    loadEngine().then(() => import('./restore-image-client.mjs')).then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  } else {
    const controller = new AbortController();
    let interrupted = false;
    process.on('SIGINT', () => { if (interrupted) process.exit(130); interrupted = true; controller.abort(); });
    runRestoreOwn({ argv: process.argv.slice(2), env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: controller.signal })
      .then((code) => { process.exitCode = code; });
  }
}
