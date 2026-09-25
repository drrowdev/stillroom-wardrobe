// Renders the PNG app icons from public/icon.svg with the locked Playwright Chromium. Run after changing the SVG:
// node scripts/render-icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
if (!svg.includes('rx="44"')) throw new Error('Unexpected icon.svg: the background corner radius changed.');
// Maskable and Apple icons are full-bleed squares; the platform applies its own shape. The artwork already fits the
// maskable safe zone (a centred circle of 40% radius), so only the corners change.
const square = svg.replace('rx="44"', 'rx="0"');
const outputs = [
  { file: 'icon-192.png', size: 192, source: svg },
  { file: 'icon-512.png', size: 512, source: svg },
  { file: 'icon-maskable-512.png', size: 512, source: square },
  { file: 'apple-touch-icon.png', size: 180, source: square },
];

const browser = await chromium.launch();
try {
  for (const { file, size, source } of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const sized = source.replace('<svg ', `<svg width="${size}" height="${size}" `);
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(new URL(`../public/${file}`, import.meta.url), png);
    await page.close();
  }
} finally {
  await browser.close();
}
