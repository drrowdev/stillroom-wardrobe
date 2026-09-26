// CI only (ubuntu runners). Ubuntu 23.10 and later restrict unprivileged user namespaces with AppArmor, so the
// sandboxed Chromium that restore-own uses cannot start there. The CI step writes an AppArmor profile, like the one
// Google Chrome's package installs, for exactly the pinned Playwright Chromium binary this prints with `--path`, and
// then runs `--verify`. The sandbox is never turned off and the runner-wide setting is left alone.
//   --path    prints the pinned binary's path, refusing anything but the expected cache location
//   --verify  starts that binary the way restore-own does and checks that its renderer runs under the seccomp sandbox
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (message) => { process.stderr.write(`::error title=Chromium sandbox::${message}\n`); process.exit(1); };

export async function pinnedChromium() {
  const { chromium } = await import('@playwright/test');
  const path = chromium.executablePath();
  const expected = new RegExp(`^${homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.cache/ms-playwright/chromium-\\d+/chrome-linux(64)?/chrome$`);
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return { problem: 'PLAYWRIGHT_BROWSERS_PATH must not be set' };
  if (typeof path !== 'string' || !expected.test(path)) return { problem: 'the pinned Chromium is not at the expected path' };
  if (!existsSync(path) || realpathSync(path) !== path) return { problem: 'the pinned Chromium is missing or is a link' };
  return { path };
}

const parentOf = (status) => Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? -1);

/**
 * Every process started below `root` (this script, which launched only the browser), found by the PPid in
 * /proc/<pid>/status. Chromium rewrites its command line (argv[0] and the argument layout), so the binary is read from
 * /proc/<pid>/exe and flags are matched anywhere in the command line.
 */
export class ProcessReadError extends Error {
  constructor(pid, code) { super(`process ${pid}: ${code}`); this.name = 'ProcessReadError'; this.pid = pid; this.code = code; }
}
const GONE = new Set(['ENOENT', 'ESRCH']);

export function descendantsOf(root, proc = '/proc', read = readFileSync) {
  const all = new Map();
  for (const name of readdirSync(proc).filter(entry => /^\d+$/.test(entry))) {
    let status;
    // Only a process that has ended may be left out; any other failure could hide a live subtree from the checks.
    try { status = read(`${proc}/${name}/status`, 'utf8'); } catch (error) {
      if (GONE.has(error?.code)) continue;
      throw new ProcessReadError(Number(name), error?.code ?? 'unreadable');
    }
    if (parentOf(status) < 0) throw new ProcessReadError(Number(name), 'no parent');
    all.set(Number(name), status);
  }
  const found = new Set([root]);
  for (let grown = true; grown;) {
    grown = false;
    for (const [pid, status] of all) if (!found.has(pid) && found.has(parentOf(status))) { found.add(pid); grown = true; }
  }
  found.delete(root);
  return [...found].map(pid => {
    let exe = null, command = null;
    try { exe = readlinkSync(`${proc}/${pid}/exe`); } catch { /* unreadable */ }
    try { command = read(`${proc}/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { /* unreadable */ }
    let status = null;
    try { status = read(`${proc}/${pid}/status`, 'utf8'); } catch { /* unreadable */ }
    return { pid, exe, command, status };
  });
}
export const hasFlag = (command, flag) => new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(=|\\s|$)`).test(command ?? '');
async function verify(path) {
  const { launchImageBrowser } = await import('./restore-image-page.mjs');
  let browser;
  try { browser = await launchImageBrowser(); } catch (error) { fail(`the sandboxed Chromium did not start (${error?.code ?? 'launch'})`); }
  try {
    const page = await browser.newPage();
    await page.setContent('<p>sandbox</p>');
    let running;
    try { running = descendantsOf(process.pid); } catch (error) { fail(`a process below this script could not be read (${error?.code ?? 'unreadable'})`); }
    // Sandboxed children are not dumpable, so their /proc/<pid>/exe may be unreadable. This script starts nothing but the
    // browser, so the binary is checked on the browser process and every process below this script belongs to it.
    const chromium = running.filter(entry => entry.exe === path);
    const renderers = running.filter(entry => hasFlag(entry.command, '--type=renderer'));
    // One line to show how this Chromium presents itself (binary, process types); no page content is involved.
    process.stdout.write(`Chromium processes: ${running.length} below this script, ${chromium.length} of the pinned binary, types `
      + `${JSON.stringify(running.map(entry => /--type=([a-z-]+)/.exec(entry.command ?? '')?.[1] ?? 'browser'))}.\n`);
    if (running.some(entry => hasFlag(entry.command, '--no-sandbox'))) fail('Chromium was started with --no-sandbox');
    if (chromium.length === 0) fail('the pinned Chromium binary was not found below this script');
    if (running.some(entry => entry.command === null || entry.status === null)) fail('a Chromium process could not be read');
    if (renderers.length === 0) fail('no renderer process of the pinned Chromium was found');
    // Seccomp mode 2 is Chromium's seccomp-bpf renderer sandbox; it is only applied when the sandbox is on.
    if (!renderers.every(entry => /^Seccomp:\s+2$/m.test(entry.status))) fail('the renderer is not under the seccomp sandbox');
    process.stdout.write(`Sandboxed Chromium verified: ${renderers.length} renderer(s) under seccomp-bpf, no --no-sandbox.\n`);
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (process.platform !== 'linux') fail('this check runs on the Linux CI runners only');
  const { path, problem } = await pinnedChromium();
  if (!path) fail(problem);
  if (mode === '--path') process.stdout.write(path);
  else if (mode === '--verify') await verify(path);
  else fail('use --path or --verify');
}
