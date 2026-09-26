// Lets Node load the app's TypeScript restore modules as they are. Vite resolves `./module` to `./module.ts`; Node does
// not, so this resolve hook maps only extensionless relative imports whose importer and target both lie inside the
// repository's src folder. Everything else, including packages and imports with an extension, goes to Node unchanged,
// and evaluation errors are never caught here. Register it with `registerSourceLoader()` before the first dynamic import.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = realpathSync(fileURLToPath(new URL('../src', import.meta.url)));

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
const isFile = path => existsSync(path) && statSync(path).isFile();
const extensionless = specifier => (specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier.split('/').pop());

// Pure, so it can be tested with Windows and POSIX paths: returns the real file for a src-internal extensionless
// import, or null to let Node resolve it.
export function resolveSourceSpecifier(specifier, parentURL, root = defaultRoot, fileExists = isFile, real = realpathSync) {
  if (!extensionless(specifier) || !parentURL?.startsWith('file:')) return null;
  let parent;
  try { parent = real(fileURLToPath(parentURL)); } catch { return null; }
  if (!inside(root, parent)) return null;
  const base = resolve(dirname(parent), specifier.split('/').join(sep));
  for (const candidate of [`${base}.ts`, resolve(base, 'index.ts')]) {
    if (!fileExists(candidate)) continue;
    const target = real(candidate);
    return inside(root, target) ? pathToFileURL(target).href : null;
  }
  return null;
}

let registered = false;
export function registerSourceLoader() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, next) {
      const url = resolveSourceSpecifier(specifier, context.parentURL);
      return url ? { url, shortCircuit: true } : next(specifier, context);
    },
  });
}
