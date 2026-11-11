import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Screenshot helper for the manual playthrough specs: shoots only the area of
// interest (the first visible element matching `focus`, padded), and keeps a
// numbered shot list so each image can be reviewed against what the UI did.
export function makeShots(page: Page, dir: string) {
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  const index: string[] = [];
  let n = 0;
  const snap = async (tag: string, opts: { focus?: string; always?: boolean; note?: string } = {}) => {
    if (!opts.always && seen.has(tag)) return;
    seen.add(tag);
    const file = `${String(++n).padStart(3, '0')}-${tag}.png`;
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (opts.focus) {
      const el = page.locator(opts.focus).first();
      if (await el.isVisible().catch(() => false)) {
        const b = await el.boundingBox();
        const vp = page.viewportSize() ?? { width: 1440, height: 900 };
        if (b && b.width > 20 && b.height > 20) {
          const pad = 16;
          const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
          clip = { x, y, width: Math.min(vp.width - x, b.width + 2 * pad), height: Math.min(vp.height - y, b.height + 2 * pad) };
        }
      }
    }
    await page.screenshot({ path: path.join(dir, file), clip }).catch(() => {});
    index.push(`${file}${opts.note ? ` — ${opts.note}` : ''}`);
  };
  const flush = (lines: string[]) => writeFileSync(path.join(dir, 'notes.txt'), [...lines, '', 'SHOTS', ...index].join('\n'));
  return { snap, flush };
}
