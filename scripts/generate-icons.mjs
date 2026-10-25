// Renders public/icon.svg to the PNG icons used by the web app manifest.
// Run with: node scripts/generate-icons.mjs (requires Playwright and Chromium).
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Playwright is not a project dependency; use the globally installed one.
const { chromium } = createRequire(import.meta.url)('playwright');

const svg = await readFile(new URL('../public/icon.svg', import.meta.url), 'utf8');
const targets = [
  { file: 'icon-192.png', size: 192, padding: 0 },
  { file: 'icon-512.png', size: 512, padding: 0 },
  // iOS draws its own rounded mask and shows transparency as black, so fill the corners.
  { file: 'apple-touch-icon.png', size: 180, padding: 0, solid: true },
  // Maskable icons need a safe zone: draw on a full-bleed background with padding.
  { file: 'icon-maskable-512.png', size: 512, padding: 0.12, solid: true },
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const { file, size, padding, solid = false } of targets) {
  const inner = Math.round(size * (1 - 2 * padding));
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;display:grid;place-items:center;width:${size}px;height:${size}px;background:${solid ? '#2f6f4f' : 'transparent'}">` +
      `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`,
  );
  await page.screenshot({
    path: new URL(`../public/${file}`, import.meta.url).pathname,
    omitBackground: !solid,
  });
}
await browser.close();
