import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { isMain, relativePath, walkFiles } from './quality/files.mjs';

const publicKeys = new Set(['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_APP_VERSION']);
const builtInKeys = new Set(['MODE', 'BASE_URL', 'DEV', 'PROD', 'SSR']);
const excludedDirectories = new Set([
  '.git', 'node_modules', '.supabase', '.copilot', '.session', '.sessions', 'session-state',
  'test-results', 'playwright-report', 'coverage', 'artifacts', '.artifacts', '.temp',
]);
const binaryExtensions = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif', '.ico', '.avif', '.pdf',
  '.zip', '.gz', '.br', '.woff', '.woff2', '.ttf', '.wasm', '.exe', '.dll', '.mp4', '.webm',
]);

export function excludedPath(filename, directory = false) {
  const parts = filename.replaceAll('\\', '/').split('/');
  const name = parts.at(-1);
  if (parts.some((part) => excludedDirectories.has(part))) return true;
  if (directory) return false;
  if (/^\.env(?:\.|$)/i.test(name) && name !== '.env.example') return true;
  if (/^(?:sessions?|credentials?)(?:[.-].*)?\.json$/i.test(name)) return true;
  return binaryExtensions.has(path.extname(name).toLowerCase());
}

function accessPath(node) {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isMetaProperty(node)) return [node.getText()];
  if (ts.isPropertyAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base && [...base, node.name.text];
  }
  if (ts.isElementAccessExpression(node)) {
    const base = accessPath(node.expression);
    return base && [...base, ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : '*'];
  }
  return null;
}

function environmentAccess(text, filename, browserSource) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true,
    filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const codes = new Set();
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parts = accessPath(node);
      if (parts) {
        const prefix = parts.slice(0, -1).join('.');
        if (prefix === 'import.meta.env' || prefix === 'process.env') {
          const key = parts.at(-1);
          if (key.startsWith('VITE_') && !publicKeys.has(key)) codes.add('UNAPPROVED_BROWSER_VARIABLE');
          if (browserSource && (key === '*' || prefix === 'process.env' && !publicKeys.has(key)
            || prefix === 'import.meta.env' && !builtInKeys.has(key) && !publicKeys.has(key))) codes.add('UNAPPROVED_BROWSER_VARIABLE');
        }
      }
    }
    // A destructured browser environment is another read, not a licence to bypass the allowlist.
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      const parts = accessPath(node.initializer);
      if (parts && ['import.meta.env', 'process.env'].includes(parts.join('.'))) {
        for (const element of node.name.elements) {
          const key = element.propertyName?.text ?? element.name.text;
          if (element.dotDotDotToken || typeof key !== 'string'
            || key.startsWith('VITE_') && !publicKeys.has(key)
            || browserSource && !publicKeys.has(key) && !(parts[0] === 'import.meta' && builtInKeys.has(key))) {
            codes.add('UNAPPROVED_BROWSER_VARIABLE');
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...codes];
}

export function scanText(text, filename, canary = '') {
  const codes = new Set();
  if (/\bsb_secret_[A-Za-z0-9_-]{8,}\b/.test(text)) codes.add('SUPABASE_SECRET_KEY');
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]*\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\b/g)) {
    try {
      if (JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')).role === 'service_role') codes.add('PRIVILEGED_JWT');
    } catch { /* Non-JWT dotted strings are not credentials. */ }
  }
  if (canary && text.includes(canary)) codes.add('SECRET_CANARY');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) codes.add('PRIVATE_KEY');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sbp_[a-f0-9]{30,}|AKIA[A-Z0-9]{16})\b/.test(text)) codes.add('PROVIDER_TOKEN');
  if (/\bpostgres(?:ql)?:\/\/[^:\s/@]+:[^$\s<>{}@]+@/i.test(text)) codes.add('DATABASE_CREDENTIAL');
  const normalized = filename.replaceAll('\\', '/');
  const browserSource = normalized.startsWith('src/') || normalized.startsWith('dist/');
  const configSource = /(?:^|\/)[^/]*config\.[cm]?[jt]s$/.test(normalized);
  if (browserSource || configSource) {
    for (const match of text.matchAll(/\bVITE_[A-Z][A-Z0-9_]+\b/g)) {
      if (!publicKeys.has(match[0])) codes.add('UNAPPROVED_BROWSER_VARIABLE');
    }
    if (/\.[cm]?[jt]sx?$/.test(normalized)) environmentAccess(text, filename, browserSource).forEach((code) => codes.add(code));
  }
  return [...codes].sort();
}

export async function scanProject(root = process.cwd(), canary = process.env.STILLROOM_SECRET_CANARY ?? '') {
  const files = await walkFiles(root, excludedPath);
  const findings = [];
  let checked = 0;
  for (const filename of files) {
    const bytes = await readFile(filename);
    if (bytes.includes(0)) continue;
    checked += 1;
    const relative = relativePath(root, filename);
    for (const code of scanText(bytes.toString('utf8'), relative, canary)) findings.push({ path: relative, code });
  }
  return { findings, fileCount: checked, canaryChecked: Boolean(canary) };
}

if (isMain(import.meta.url)) {
  try {
    if (process.env.CI && !process.env.STILLROOM_SECRET_CANARY) {
      console.error('Secret scan: CI_CANARY_REQUIRED');
      process.exitCode = 1;
    }
    const result = await scanProject();
    if (result.findings.length) {
      for (const finding of result.findings) console.error(`${finding.path}: ${finding.code}`);
      process.exitCode = 1;
    } else console.log(`Secret scan: ${result.fileCount} text files checked; canary ${result.canaryChecked ? 'checked' : 'not supplied (CI must supply one)'}.`);
  } catch {
    console.error('Secret scan: INPUT_UNAVAILABLE');
    process.exitCode = 1;
  }
}
