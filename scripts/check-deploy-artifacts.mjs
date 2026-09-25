// PR-3b (rev5 A2): prove that no CI fixture can reach a deployed Edge function. Parses every
// [functions.*] entry in supabase/config.toml, walks each deployable static import graph and scans the
// deployable SQL. Fails on fixture modules, non-literal dynamic imports, fixture import-map targets, or
// fixture markers in migrations/seed files. Prints the graph so the deployed inventory is reviewable.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FIXTURE_MARKERS = Object.freeze(['local-dummy-not-a-credential', 'stillroom-edge-gate-activation',
  'provider-double', 'EDGE_GATEWAY_UPSTREAM']);
const FIXTURE_NAME = /(^|\/)(provider-double|fixture-gateway|egress-probe|canary|analyze-clothing-double)(\.[a-z]+|\/|$)/;

export function forbiddenModule(relative) {
  const value = relative.replaceAll('\\', '/');
  if (value.startsWith('../') || path.isAbsolute(value)) return 'outside-repository';
  if (/^(tests|scripts)\//.test(value) || /^supabase\/seed/.test(value) || /(^|\/)edge-fixtures\//.test(value)) return 'fixture-path';
  if (FIXTURE_NAME.test(value)) return 'fixture-name';
  return null;
}
/** Removes block comments and whole-line `//` comments only; `//` inside strings (URLs) is kept. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line)).join('\n');
}
/** Static and dynamic import specifiers in one module, handling multi-line import lists. */
export function importsOf(source) {
  const text = stripComments(source), specifiers = [], dynamic = [];
  const statement = /(?:^|[;\n}])\s*(?:import|export)\b\s*(?:[^'";]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g;
  for (const match of text.matchAll(statement)) specifiers.push(match[2]);
  for (const match of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
    const literal = /^(['"])([^'"\n]+)\1$/.exec(match[1].trim());
    if (literal) specifiers.push(literal[2]); else dynamic.push(match[1].trim().slice(0, 60));
  }
  return { specifiers, dynamic };
}
const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const STRING = /^"([^"\\\p{Cc}]*)"/u;
/**
 * Strict TOML subset used by supabase/config.toml: bare table headers, bare keys, basic single-line strings without
 * escapes, integers, booleans and single-line string arrays. Anything else (quoted or dotted keys, literal or
 * multi-line strings, inline tables, array tables, floats, dates, duplicates) is reported, never skipped.
 */
export function parseToml(text) {
  const root = {}, problems = [], tables = new Set();
  let table = root;
  text.split(/\r?\n/).forEach((raw, index) => {
    const where = `config.toml:${index + 1}`, line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (line.startsWith('[')) {
      table = null;
      const header = /^\[([^[\]"'#]+)\]\s*(?:#.*)?$/.exec(line);
      const parts = header ? header[1].split('.').map((part) => part.trim()) : [];
      if (!header || !parts.every((part) => BARE_KEY.test(part))) { problems.push(`${where}: unsupported table header`); return; }
      const name = parts.join('.');
      if (tables.has(name)) { problems.push(`${where}: duplicate table ${name}`); return; }
      tables.add(name);
      let node = root;
      for (const part of parts) {
        if (node[part] === undefined) node[part] = {};
        else if (typeof node[part] !== 'object' || Array.isArray(node[part])) { problems.push(`${where}: table ${name} conflicts with a value`); return; }
        node = node[part];
      }
      table = node;
      return;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!pair) { problems.push(`${where}: unsupported key syntax`); return; }
    if (table === null) return;
    const parsed = tomlValue(pair[2]);
    if ('error' in parsed) { problems.push(`${where}: ${pair[1]} has an unsupported value (${parsed.error})`); return; }
    if (Object.hasOwn(table, pair[1])) { problems.push(`${where}: duplicate key ${pair[1]}`); return; }
    table[pair[1]] = parsed.value;
  });
  return { value: root, problems };
}
function tomlValue(text) {
  let value, rest;
  if (text.startsWith('"""') || text.startsWith("'")) return { error: 'literal or multi-line string' };
  if (text.startsWith('"')) {
    const match = STRING.exec(text);
    if (!match) return { error: 'string with escapes or unterminated' };
    value = match[1]; rest = text.slice(match[0].length);
  } else if (text.startsWith('[')) {
    const match = /^\[\s*((?:"[^"\\\p{Cc}]*"\s*,\s*)*(?:"[^"\\\p{Cc}]*"\s*,?\s*)?)\]/u.exec(text);
    if (!match) return { error: 'array other than single-line strings' };
    value = [...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1]); rest = text.slice(match[0].length);
  } else {
    const match = /^(true|false|[+-]?(?:0|[1-9][0-9]*))(?=[\s#]|$)/.exec(text);
    if (!match) return { error: 'type' };
    value = match[1] === 'true' ? true : match[1] === 'false' ? false : Number(match[1]); rest = text.slice(match[0].length);
  }
  return /^\s*(?:#.*)?$/.test(rest) ? { value } : { error: 'trailing content' };
}
const FUNCTION_KEYS = Object.freeze({ enabled: 'boolean', verify_jwt: 'boolean', entrypoint: 'string', import_map: 'string' });
/** `[functions.<name>]` entries from a strictly parsed config; unknown keys or types are problems. */
export function functionEntries(config) {
  const { value, problems } = parseToml(config), entries = [];
  const functions = value.functions ?? {};
  if (typeof functions !== 'object' || Array.isArray(functions)) return { entries, problems: [...problems, 'config: functions is not a table'] };
  for (const [name, settings] of Object.entries(functions)) {
    if (typeof settings !== 'object' || Array.isArray(settings)) { problems.push(`config: functions.${name} is not a table`); continue; }
    for (const [key, setting] of Object.entries(settings)) {
      if (!Object.hasOwn(FUNCTION_KEYS, key)) problems.push(`config: functions.${name}.${key} is not supported by this check`);
      else if (typeof setting !== FUNCTION_KEYS[key]) problems.push(`config: functions.${name}.${key} has the wrong type`);
    }
    entries.push({ name, entrypoint: typeof settings.entrypoint === 'string' ? settings.entrypoint : null,
      importMap: typeof settings.import_map === 'string' ? settings.import_map : null });
  }
  return { entries, problems };
}
/** JSON with line and block comments outside strings; trailing commas stay invalid (fail closed). */
export function parseJsonc(text) {
  let out = '', index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1); index = end + 1;
    } else if (text.startsWith('//', index)) {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new SyntaxError('unterminated comment');
      out += ' '; index = end + 2;
    } else { out += char; index += 1; }
  }
  return JSON.parse(out);
}
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTERNAL = /^(https?|jsr|npm|node):/;
const relativeLike = (value) => value.startsWith('./') || value.startsWith('../') || value.startsWith('/');
/** A loaded import map: validated shape, keys and targets normalized to URLs against the map file. */
export function importMap(json, mapUrl, label) {
  const problems = [], imports = {}, scopes = {};
  const allowed = new Set(['imports', 'scopes']);
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { problems: [`${label}: not an object`], imports, scopes };
  for (const key of Object.keys(json)) if (!allowed.has(key)) problems.push(`${label}: key ${key} is not supported by this check`);
  // WICG import-map semantics, as Deno applies them. Keys: relative-like joins the map URL, an absolute URL is
  // normalized, anything else is a bare specifier. Targets: relative-like or absolute URL only; a bare target
  // (for example "lib.ts") is an invalid address, which Deno maps to null, so it is reported. Every scope key is
  // joined against the map URL (so "sub/" is a scope), and an unparseable one is reported.
  const normalize = (specifiers, where) => {
    const out = {};
    if (specifiers === undefined) return out;
    if (!specifiers || typeof specifiers !== 'object' || Array.isArray(specifiers)) { problems.push(`${where}: not an object`); return out; }
    for (const [key, target] of Object.entries(specifiers)) {
      if (key === '') { problems.push(`${where}: empty specifier key`); continue; }
      if (typeof target !== 'string') { problems.push(`${where} ${key} is not a string`); continue; }
      const normalizedKey = relativeLike(key) ? new URL(key, mapUrl).href : absoluteUrl(key) ?? key;
      const address = relativeLike(target) ? new URL(target, mapUrl).href : absoluteUrl(target);
      if (address === null) { problems.push(`${where} ${key} -> ${target} (invalid address)`); out[normalizedKey] = null; continue; }
      if (normalizedKey.endsWith('/') && !address.endsWith('/')) { problems.push(`${where} ${key} -> ${target} (prefix target without /)`); out[normalizedKey] = null; continue; }
      out[normalizedKey] = address;
    }
    return out;
  };
  Object.assign(imports, normalize(json.imports, `${label} imports`));
  if (json.scopes !== undefined && (!json.scopes || typeof json.scopes !== 'object' || Array.isArray(json.scopes))) problems.push(`${label} scopes: not an object`);
  else for (const [scope, specifiers] of Object.entries(json.scopes ?? {})) {
    let prefix;
    try { prefix = new URL(scope, mapUrl).href; } catch { problems.push(`${label} scope ${scope}: not a URL`); continue; }
    scopes[prefix] = normalize(specifiers, `${label} scope ${scope}`);
  }
  return { problems, imports, scopes };
}
function absoluteUrl(value) {
  if (!SCHEME.test(value)) return null;
  try { return new URL(value).href; } catch { return null; }
}
/** undefined = no entry; null = mapped to an invalid address (resolution fails, as in Deno). */
function matchSpecifiers(specifiers, key) {
  if (Object.hasOwn(specifiers, key)) return specifiers[key];
  const prefix = Object.keys(specifiers).filter((entry) => entry.endsWith('/') && key.startsWith(entry)).sort((a, b) => b.length - a.length)[0];
  if (prefix === undefined) return undefined;
  if (specifiers[prefix] === null) return null;
  try {
    const resolved = new URL(key.slice(prefix.length), specifiers[prefix]).href;
    return resolved.startsWith(specifiers[prefix]) ? resolved : null;
  } catch { return null; }
}
/** Import-map resolution (scopes, longest prefix first, then top-level imports), as Deno applies it. */
export function resolveSpecifier(specifier, referrer, map) {
  const key = relativeLike(specifier) ? new URL(specifier, referrer).href : absoluteUrl(specifier) ?? specifier;
  for (const scope of Object.keys(map?.scopes ?? {}).sort((a, b) => b.length - a.length)) {
    if (referrer === scope || (scope.endsWith('/') && referrer.startsWith(scope))) {
      const hit = matchSpecifiers(map.scopes[scope], key);
      if (hit !== undefined) return hit;
    }
  }
  const hit = map ? matchSpecifiers(map.imports, key) : undefined;
  if (hit !== undefined) return hit;
  return relativeLike(specifier) || absoluteUrl(specifier) !== null ? key : null;
}

async function exists(file) { try { return (await stat(file)).isFile(); } catch { return false; } }

/** Pure-ish analysis over a repository root; returns { problems, graph }. */
export async function analyzeDeployArtifacts(root) {
  const problems = [], graph = {};
  const rel = (file) => path.relative(root, file).replaceAll('\\', '/');
  const config = await readFile(path.join(root, 'supabase', 'config.toml'), 'utf8');
  const parsed = functionEntries(config);
  problems.push(...parsed.problems);
  const entries = parsed.entries;
  // The CLI deploys every function directory, configured or not; unconfigured ones use the defaults.
  const functionsDir = path.join(root, 'supabase', 'functions');
  let directories = [];
  try { directories = (await readdir(functionsDir, { withFileTypes: true })).filter((d) => d.isDirectory() && /^[A-Za-z][A-Za-z0-9_-]*$/.test(d.name)).map((d) => d.name); }
  catch { /* no functions directory */ }
  for (const name of directories) if (!entries.some((entry) => entry.name === name)) entries.push({ name, entrypoint: null, importMap: null });
  if (!entries.length) problems.push('config: no [functions.*] entries');
  const loadMap = async (file, label) => {
    let json;
    try { const text = await readFile(file, 'utf8'); json = file.endsWith('.jsonc') ? parseJsonc(text) : JSON.parse(text); }
    catch { problems.push(`${label}: unreadable import map ${rel(file)}`); return null; }
    const map = importMap(json, pathToFileURL(file).href, `${label}: ${rel(file)}`);
    problems.push(...map.problems);
    const targets = [...Object.entries(map.imports), ...Object.values(map.scopes).flatMap((scope) => Object.entries(scope))];
    for (const [alias, target] of targets) {
      if (target === null || EXTERNAL.test(target)) continue;
      if (!target.startsWith('file:')) { problems.push(`${label}: import-map ${alias} -> ${target} (bare target)`); continue; }
      const reason = forbiddenModule(rel(fileURLToPath(target)));
      if (reason) problems.push(`${label}: import-map ${alias} -> ${rel(fileURLToPath(target))} (${reason})`);
    }
    return map;
  };
  const fallback = path.join(functionsDir, 'import_map.json');
  for (const shared of ['deno.json', 'deno.jsonc', 'import_map.json']) {
    if (await exists(path.join(functionsDir, shared))) await loadMap(path.join(functionsDir, shared), `functions/${shared}`);
  }
  for (const entry of entries) {
    const directory = path.join(functionsDir, entry.name);
    const entrypoint = path.resolve(path.join(root, 'supabase'), entry.entrypoint ?? `./functions/${entry.name}/index.ts`);
    let mapFile;
    if (entry.importMap) {
      mapFile = path.resolve(path.join(root, 'supabase'), entry.importMap);
      if (!(await exists(mapFile))) { problems.push(`${entry.name}: import map ${entry.importMap} missing`); mapFile = null; }
    } else {
      const own = [];
      for (const candidate of ['deno.json', 'deno.jsonc']) if (await exists(path.join(directory, candidate))) own.push(path.join(directory, candidate));
      if (own.length > 1) problems.push(`${entry.name}: both deno.json and deno.jsonc exist`);
      mapFile = own[0] ?? ((await exists(fallback)) ? fallback : null);
    }
    const map = mapFile ? await loadMap(mapFile, entry.name) : null;
    const seen = new Set(), queue = [entrypoint];
    graph[entry.name] = [];
    while (queue.length) {
      const file = queue.shift();
      const name = rel(file);
      if (seen.has(name)) continue;
      seen.add(name);
      graph[entry.name].push(name);
      const reason = forbiddenModule(name);
      if (reason) { problems.push(`${entry.name}: ${name} (${reason})`); continue; }
      if (!(await exists(file))) { problems.push(`${entry.name}: missing module ${name}`); continue; }
      const source = await readFile(file, 'utf8');
      for (const marker of FIXTURE_MARKERS) if (source.includes(marker)) problems.push(`${entry.name}: ${name} contains fixture marker ${marker}`);
      const { specifiers, dynamic } = importsOf(source);
      for (const value of dynamic) problems.push(`${entry.name}: ${name} non-literal import(${value})`);
      for (const specifier of specifiers) {
        const target = resolveSpecifier(specifier, pathToFileURL(file).href, map);
        if (target === null) { problems.push(`${entry.name}: ${name} bare import ${specifier}`); continue; }
        if (EXTERNAL.test(target)) continue;
        if (!target.startsWith('file:')) { problems.push(`${entry.name}: ${name} unsupported import ${specifier}`); continue; }
        queue.push(fileURLToPath(target));
      }
    }
  }
  const sqlFiles = [];
  const migrations = path.join(root, 'supabase', 'migrations');
  try { for (const file of await readdir(migrations)) if (file.endsWith('.sql')) sqlFiles.push(path.join(migrations, file)); }
  catch { /* no migrations directory */ }
  for (const file of await readdir(path.join(root, 'supabase'))) if (/^seed.*\.sql$/.test(file)) sqlFiles.push(path.join(root, 'supabase', file));
  for (const file of sqlFiles) {
    const source = await readFile(file, 'utf8');
    for (const marker of FIXTURE_MARKERS) if (source.includes(marker)) problems.push(`sql: ${rel(file)} contains fixture marker ${marker}`);
  }
  return { problems, graph, sqlFiles: sqlFiles.map(rel) };
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { problems, graph, sqlFiles } = await analyzeDeployArtifacts(root);
  for (const [name, modules] of Object.entries(graph)) console.log(`DEPLOY-GRAPH ${name}: ${modules.join(' -> ')}`);
  console.log(`DEPLOY-SQL scanned ${sqlFiles.length} migration/seed files`);
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL: deploy artifact ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS: deploy artifacts; ${Object.keys(graph).length} functions, no fixture module, marker or dynamic import`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
