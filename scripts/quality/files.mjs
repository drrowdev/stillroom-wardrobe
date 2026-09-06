import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(url) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url);
}

export function relativePath(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

export async function walkFiles(root, exclude = () => false) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || exclude(relativePath(root, filename), entry.isDirectory())) continue;
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) files.push(filename);
    }
  }
  await visit(root);
  return files.sort();
}
