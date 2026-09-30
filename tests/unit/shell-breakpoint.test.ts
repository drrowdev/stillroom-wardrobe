import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { NARROW_MAX_WIDTH, menuPageFor } from '../../src/app/shell-layout';

const css = readFileSync('src/styles/app.css', 'utf8').replace(/\r\n/g, '\n');

// Returns the body of every media block whose query is exactly `query`, including nested ones.
function mediaBlocks(query: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query} {`, from);
    if (start < 0) return blocks;
    let depth = 0, index = css.indexOf('{', start);
    const open = index;
    for (; index < css.length; index++) {
      if (css[index] === '{') depth++;
      else if (css[index] === '}' && --depth === 0) break;
    }
    blocks.push(css.slice(open + 1, index));
    from = index;
  }
}

describe('UX1 phone breakpoint', () => {
  it('uses one width in the stylesheet and in useNarrow()', () => {
    const query = `(max-width: ${NARROW_MAX_WIDTH}px)`;
    const blocks = mediaBlocks(query).join('\n');
    expect(blocks).toMatch(/\.workspace-header \.top-nav \{ display: none; \}/);
    expect(blocks).toMatch(/\.tab-bar \{ display: block;/);
    // While typing the bar is hidden but keeps its space, so it comes back without a layout jump.
    expect(blocks).toMatch(/\.tab-bar \{ visibility: hidden; transition: none; \}/);
    // No other width switches the tab bar or the top nav.
    for (const match of css.matchAll(/@media \(max-width: (\d+)px\) \{/g)) {
      if (Number(match[1]) === NARROW_MAX_WIDTH) continue;
      expect(mediaBlocks(`(max-width: ${match[1]}px)`).join('\n')).not.toMatch(/\.tab-bar \{ display|\.top-nav \{ display/);
    }
    expect(css).toMatch(/^\.tab-bar \{ display: none; \}$/m);
  });

  it('marks More as current only for the routes it holds or leads to', () => {
    expect(['statistics', 'settings', 'trash', 'admin'].map(menuPageFor)).toEqual(['statistics', 'settings', 'trash', 'admin']);
    expect(['wardrobe', 'today', 'stylist', 'outfits', 'calendar', 'add', 'outfit-new', 'detail:1', 'outfit:1'].map(menuPageFor)).toEqual(Array(9).fill(null));
  });
});
