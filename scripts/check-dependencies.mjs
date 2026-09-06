import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isMain } from './quality/files.mjs';

const execute = promisify(execFile);
const approvedRuntime = new Set(['react', 'react-dom', '@supabase/supabase-js']);
// These SPDX identifiers cover the reviewed lockfile, not an automatic approval of new licences.
const reviewedSpdx = new Set(['MIT', '0BSD', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', 'CC-BY-4.0', 'BlueOak-1.0.0']);
const purposes = {
  react: 'Component and state model for the browser UI.',
  'react-dom': 'Browser rendering of React components; kept at the same version as React.',
  '@supabase/supabase-js': 'Authenticated owner-scoped Auth, REST/RPC, private Storage and function access.',
};
const alternatives = {
  react: 'Plain DOM removes React but increases manual form, async-state and accessibility coordination; retain the approved component model.',
  'react-dom': 'Native DOM rendering requires replacing the approved React UI; retain while React is used.',
  '@supabase/supabase-js': 'Direct fetch avoids the SDK but requires custom session refresh and recovery; retain the supported SDK authentication lifecycle.',
};

export function isReviewedSpdx(value) {
  return typeof value === 'string' && reviewedSpdx.has(value);
}

function fail(code) {
  const error = new Error(code);
  error.qualityCode = code;
  throw error;
}

function installedPath(root, location) {
  if (!/^(?:node_modules\/(?:@[\w.-]+\/)?[\w.-]+\/)*node_modules\/(?:@[\w.-]+\/)?[\w.-]+$/.test(location)) {
    fail('UNSUPPORTED_PACKAGE_LOCATION');
  }
  return path.join(root, ...location.split('/'));
}

function packageName(location) {
  return location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

function resolveDependency(packages, parent, dependency) {
  let current = parent;
  while (true) {
    const candidate = `${current ? `${current}/` : ''}node_modules/${dependency}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!current) return null;
    const separator = current.lastIndexOf('/node_modules/');
    current = separator < 0 ? '' : current.slice(0, separator);
  }
}

function upstreamFor(metadata) {
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url;
  if (!repository) return null;
  const normalized = repository.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.username || url.password || url.search) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function licenceFiles(directory) {
  const results = [];
  async function visit(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relative = `${prefix}${entry.name}`;
      if (entry.isFile() && (/^(?:licen[cs]e|copying|copyright(?:notice)?|notice)(?:[._-].*)?$/i.test(entry.name) || prefix)) {
        const text = (await readFile(path.join(folder, entry.name), 'utf8')).replaceAll('\r\n', '\n').trim();
        if (!text || text.includes('\0')) fail('INVALID_LICENCE_NOTICE');
        results.push({ file: relative, text });
      } else if (entry.isDirectory() && /^(?:licen[cs]es|notices)$/i.test(entry.name)) {
        await visit(path.join(folder, entry.name), `${relative}/`);
      }
    }
  }
  await visit(directory);
  return results.sort((left, right) => left.file.localeCompare(right.file, 'en'));
}

function assertMaintenance(evidence, name) {
  if (!evidence || !['verified', 'unverified'].includes(evidence.status) || !evidence.reason
    || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.checkedOn)
    || evidence.source !== `https://registry.npmjs.org/${encodeURIComponent(name)}`) fail('INVALID_MAINTENANCE_EVIDENCE');
  if (evidence.status === 'verified' && (!evidence.releasedAt || !Number.isFinite(Date.parse(evidence.releasedAt)))) fail('INVALID_RELEASE_DATE');
  if (evidence.status === 'unverified' && evidence.releasedAt !== null) fail('INVALID_RELEASE_DATE');
}

export async function releaseEvidence(name, version, fetcher = fetch) {
  const source = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  const checkedOn = new Date().toISOString().slice(0, 10);
  try {
    const response = await fetcher(source, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('REGISTRY_UNAVAILABLE');
    const metadata = await response.json();
    const releasedAt = metadata.time?.[version];
    if (typeof releasedAt !== 'string' || !Number.isFinite(Date.parse(releasedAt)) || !metadata.versions?.[version]) throw new Error('RELEASE_UNVERIFIED');
    return {
      status: 'verified', source, checkedOn, releasedAt,
      reason: 'The public npm registry records this exact resolved version and its release timestamp; recency alone is not a maintenance guarantee.',
    };
  } catch {
    return {
      status: 'unverified', source, checkedOn, releasedAt: null,
      reason: 'Public npm registry release metadata was unavailable or incomplete. Do not claim release recency; rerun dependencies:record when available.',
    };
  }
}

export async function buildInventory(root, previous = null, refresh = false) {
  const lockText = await readFile(path.join(root, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) fail('UNSUPPORTED_LOCKFILE');
  const direct = manifest.dependencies ?? {};
  if (Object.keys(direct).length !== approvedRuntime.size || Object.keys(direct).some((name) => !approvedRuntime.has(name))
    || Object.keys(manifest.optionalDependencies ?? {}).length || Object.keys(manifest.peerDependencies ?? {}).length) fail('UNAPPROVED_RUNTIME_DEPENDENCY');
  if (JSON.stringify(Object.entries(direct).sort()) !== JSON.stringify(Object.entries(lock.packages[''].dependencies ?? {}).sort())) fail('RUNTIME_LOCKFILE_DRIFT');
  if (direct.react !== direct['react-dom']) fail('REACT_VERSION_MISMATCH');
  for (const name of approvedRuntime) {
    if (!/^\d+\.\d+\.\d+$/.test(direct[name]) || direct[name] !== lock.packages[''].dependencies?.[name]
      || direct[name] !== lock.packages[`node_modules/${name}`]?.version) fail('DIRECT_DEPENDENCY_NOT_PINNED');
  }
  if (JSON.stringify(Object.entries(manifest.devDependencies ?? {}).sort()) !== JSON.stringify(Object.entries(lock.packages[''].devDependencies ?? {}).sort())) fail('DEVELOPMENT_LOCKFILE_DRIFT');
  const records = new Map();
  const notices = [];
  for (const [location, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (!location) continue;
    const directory = installedPath(root, location);
    const name = packageName(location);
    if (entry.link || entry.name && entry.name !== name || !entry.version) fail('UNSUPPORTED_PACKAGE_RECORD');
    const production = !entry.dev && !entry.devOptional;
    let metadata;
    try {
      metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' || production || !entry.optional) fail('INSTALLED_PACKAGE_UNAVAILABLE');
    }
    if (metadata && (metadata.name !== name || metadata.version !== entry.version)) fail('INSTALLED_PACKAGE_VERSION_DRIFT');
    const licence = metadata?.license ?? entry.license;
    if (!isReviewedSpdx(licence) || !isReviewedSpdx(entry.license)) fail('MISSING_OR_UNREVIEWED_SPDX');
    if (metadata && metadata.license !== entry.license) fail('INSTALLED_LICENCE_DRIFT');
    const record = {
      name, version: entry.version, license: licence, location,
      direct: Object.hasOwn(production ? direct : manifest.devDependencies ?? {}, name) && location === `node_modules/${name}`,
      introducingParents: [],
    };
    if (production) {
      const upstream = upstreamFor(metadata);
      if (!upstream) fail('MISSING_UPSTREAM');
      const texts = await licenceFiles(directory);
      if (!texts.some((notice) => /^(?:licen[cs]e|copying)/i.test(notice.file))) fail('MISSING_PRODUCTION_LICENCE_TEXT');
      notices.push({ name, version: entry.version, license: licence, location, upstream, texts });
      record.upstream = upstream;
      record.purpose = purposes[name] ?? 'Transitive runtime support; see introducingParents for the exact reason this package is resolved.';
      record.alternativeOrRemoval = alternatives[name] ?? (name === '@supabase/realtime-js' || name === '@supabase/phoenix'
        ? 'Realtime is not enabled by the app. This is resolved by the approved Supabase SDK; remove only when upstream no longer requires it or after an approved SDK replacement.'
        : name === 'iceberg-js' ? 'The app does not use Iceberg catalog operations. This is resolved by the approved Storage SDK; remove only when upstream drops it or after an approved SDK replacement.'
          : 'No independent app feature adds this package. Remove by updating or replacing its introducing parent; manually pruning a required transitive package is unsafe.');
      record.licenceFiles = texts.map((notice) => ({
        file: notice.file,
        sha256: createHash('sha256').update(notice.text).digest('hex'),
      }));
      const existing = previous?.production?.find((item) => item.name === name && item.version === entry.version && item.location === location)?.maintenance;
      record.maintenance = refresh && existing?.status !== 'verified' ? await releaseEvidence(name, entry.version) : existing;
      assertMaintenance(record.maintenance, name);
    }
    records.set(location, { entry, record, production });
  }
  for (const [location, parent] of [['', { entry: lock.packages[''], production: true }], ...records]) {
    const regular = parent.entry.dependencies ?? {};
    const optional = parent.entry.optionalDependencies ?? {};
    const peers = parent.entry.peerDependencies ?? {};
    const dependencies = { ...regular, ...optional, ...peers, ...(location ? {} : manifest.devDependencies) };
    for (const name of Object.keys(dependencies)) {
      const target = resolveDependency(lock.packages, location, name);
      if (!target) {
        if (Object.hasOwn(optional, name) || parent.entry.peerDependenciesMeta?.[name]?.optional) continue;
        fail('UNRESOLVED_DEPENDENCY');
      }
      const child = records.get(target);
      if (!child) fail('UNRESOLVED_DEPENDENCY');
      child.record.introducingParents.push(location ? `${parent.record.name}@${parent.record.version} (${location})` : 'application');
      if (location && parent.production && Object.hasOwn(regular, name) && !child.production) fail('INCORRECT_PRODUCTION_CLASSIFICATION');
    }
  }
  for (const { record, production } of records.values()) {
    record.introducingParents = [...new Set(record.introducingParents)].sort();
    if (production && !record.introducingParents.length) fail('UNINTRODUCED_PRODUCTION_PACKAGE');
  }
  const inventory = {
    schemaVersion: 1,
    lockfileSha256: createHash('sha256').update(lockText.replaceAll('\r\n', '\n')).digest('hex'),
    licencePolicy: 'Reviewed SPDX identifiers; new identifiers require review rather than an invented licence. Every production notice is copied from the installed exact-version package.',
    developmentPolicy: 'Build/test packages are not browser runtime additions. Optional platform packages absent on this host are inventoried from their pinned lockfile metadata; installed manifests must match.',
    production: [...records.values()].filter((item) => item.production).map((item) => item.record),
    development: [...records.values()].filter((item) => !item.production).map((item) => item.record),
  };
  return { inventory, notices: renderNotices(notices) };
}

export function renderNotices(packages) {
  const blocks = [
    'Stillroom Wardrobe - resolved production dependency notices',
    'Generated by npm run dependencies:record from package-lock.json and installed package licence files.',
    'This inventories the complete resolved production graph, not a claim that every module is shipped in the browser bundle.',
    'Build/test dependency licences are listed separately in docs/dependencies.json.',
  ];
  for (const entry of packages) {
    blocks.push('='.repeat(78), `${entry.name}@${entry.version}`, `SPDX: ${entry.license}`,
      `Resolved location: ${entry.location}`, `Upstream: ${entry.upstream}`);
    for (const notice of entry.texts) blocks.push(`--- ${notice.file} ---`, notice.text);
  }
  return `${blocks.join('\n\n')}\n`;
}

export function summarizeAudit(report, exitCode = 0) {
  if (!report || report.error || !report.metadata?.vulnerabilities || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities) || ![0, 1].includes(exitCode)) {
    return { ok: false, code: 'AUDIT_UNAVAILABLE' };
  }
  const counts = report.metadata.vulnerabilities;
  if (['info', 'low', 'moderate', 'high', 'critical', 'total'].some((severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0)) {
    return { ok: false, code: 'AUDIT_INVALID_RESPONSE' };
  }
  const critical = Math.max(counts.critical, Object.values(report.vulnerabilities).filter((entry) => entry.severity === 'critical').length);
  if (exitCode === 1 && !critical) return { ok: false, code: 'AUDIT_INCONSISTENT_EXIT' };
  return {
    ok: critical === 0, code: critical ? 'CRITICAL_ADVISORY' : 'AUDIT_COMPLETE',
    critical, high: counts.high, moderate: counts.moderate, low: counts.low,
  };
}

export async function auditDependencies(root = process.cwd()) {
  const args = ['audit', '--omit=dev', '--audit-level=critical', '--json'];
  const options = { cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  let output;
  let exitCode = 0;
  try {
    output = process.env.npm_execpath?.endsWith('.js')
      ? await execute(process.execPath, [process.env.npm_execpath, ...args], options)
      : process.platform === 'win32'
        ? await execute(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], options)
        : await execute('npm', args, options);
  } catch (error) {
    output = error;
    exitCode = typeof error.code === 'number' ? error.code : -1;
  }
  try {
    return summarizeAudit(JSON.parse(output.stdout), exitCode);
  } catch {
    return { ok: false, code: 'AUDIT_UNAVAILABLE' };
  }
}

export async function checkDependencies(root = process.cwd(), write = false) {
  const inventoryPath = path.join(root, 'docs', 'dependencies.json');
  const noticesPath = path.join(root, 'THIRD-PARTY-NOTICES.txt');
  let previous = null;
  try {
    previous = JSON.parse(await readFile(inventoryPath, 'utf8'));
  } catch (error) {
    if (!write || error.code !== 'ENOENT') fail('INVENTORY_UNAVAILABLE');
  }
  const result = await buildInventory(root, previous, write);
  const text = `${JSON.stringify(result.inventory, null, 2)}\n`;
  if (write) {
    await mkdir(path.dirname(inventoryPath), { recursive: true });
    await writeFile(inventoryPath, text, 'utf8');
    await writeFile(noticesPath, result.notices, 'utf8');
  } else if (await readFile(inventoryPath, 'utf8') !== text
    || (await readFile(noticesPath, 'utf8')).replaceAll('\r\n', '\n') !== result.notices) fail('DEPENDENCY_RECORD_DRIFT');
  const audit = await auditDependencies(root);
  return {
    production: result.inventory.production.length,
    development: result.inventory.development.length,
    unverifiedMaintenance: result.inventory.production.filter((entry) => entry.maintenance.status !== 'verified').length,
    audit,
  };
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((argument) => argument !== '--write')) fail('UNKNOWN_ARGUMENT');
    const result = await checkDependencies(process.cwd(), process.argv.includes('--write'));
    console.log(`Dependencies: ${result.production} production and ${result.development} development packages; ${result.unverifiedMaintenance} unverified release dates.`);
    console.log(`Production audit: ${JSON.stringify(result.audit)}`);
    if (!result.audit.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`Dependencies: ${error.qualityCode ?? 'INPUT_UNAVAILABLE'}`);
    process.exitCode = 1;
  }
}
