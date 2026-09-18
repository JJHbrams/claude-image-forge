#!/usr/bin/env node
// Composite a wordmark over a generated plate and render one PNG.
//
// Flux schnell cannot letter cleanly, so the type is never generated — it is laid
// over the plate as real text and rendered by the browser at 2x. Raster gives the
// ground its texture; vector type stays crisp at any size.
//
//   node compose.mjs --plate out/x.png --out docs/assets/banner.png
//                    [--title "..."] [--tagline "..."] [--size 1200x220]

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';

const run = promisify(execFile);

const { values } = parseArgs({
  options: {
    plate: { type: 'string' },
    out: { type: 'string' },
    // No defaults. A default title is one forgotten flag away from stamping some
    // other project's name onto this one's artwork, and the render succeeds, so
    // nothing tells you until you look at the picture.
    title: { type: 'string' },
    tagline: { type: 'string', default: '' },
    size: { type: 'string', default: '1200x220' },
    scrim: { type: 'string', default: '0.55' }, // centre darkening behind the type
  },
});

if (!values.plate || !values.out || !values.title) {
  console.error('usage: compose.mjs --plate <png> --out <png> --title "..." [--tagline "..."] [--size WxH]');
  process.exit(2);
}

const [w, h] = values.size.split('x').map(Number);
const plate = resolve(values.plate);
const out = resolve(values.out);
if (!existsSync(plate)) { console.error('plate not found: ' + plate); process.exit(2); }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plateUrl = 'file:///' + plate.replace(/\\/g, '/');

// An elliptical scrim, not a flat overlay: it darkens exactly where the type sits
// and fades out before it touches the lit edges that make the plate worth having.
const html = `<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; background: #0b1322; }
  .banner {
    position: relative; width: ${w}px; height: ${h}px;
    border-radius: 16px; overflow: hidden;
    box-shadow: inset 0 0 0 1px #1e2b41;
  }
  .plate {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; display: block;
  }
  .scrim {
    position: absolute; inset: 0;
    background: radial-gradient(ellipse 58% 90% at 50% 52%,
      rgba(8,15,28,${values.scrim}) 0%, rgba(8,15,28,${Number(values.scrim) * 0.7}) 45%, rgba(8,15,28,0) 78%);
  }
  .type {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 0;
    font-family: 'Pretendard','Segoe UI','Malgun Gothic',system-ui,sans-serif;
    text-align: center;
  }
  h1 {
    font-size: ${Math.round(h * 0.227)}px; font-weight: 700; letter-spacing: -0.8px;
    color: #f2f6fc; line-height: 1.1;
    text-shadow: 0 2px 18px rgba(4,9,18,.85);
  }
  .rule {
    width: 140px; height: 3px; border-radius: 1.5px; margin: ${Math.round(h * 0.073)}px 0 0;
    background: linear-gradient(90deg, #5b8def 0%, #3fbf7f 100%);
  }
  .tag {
    margin-top: ${Math.round(h * 0.073)}px;
    font-family: ui-monospace,'Cascadia Mono','Consolas',monospace;
    font-size: ${Math.round(h * 0.064)}px; letter-spacing: 1.2px; color: #8fa6c8;
    text-shadow: 0 1px 10px rgba(4,9,18,.9);
  }
</style>
<div class="banner">
  <img class="plate" src="${plateUrl}">
  <div class="scrim"></div>
  <div class="type">
    <h1>${esc(values.title)}</h1>
    <div class="rule"></div>
    <div class="tag">${esc(values.tagline)}</div>
  </div>
</div>`;

const tmp = resolve(dirname(out), '.compose.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(tmp, html, 'utf8');

const browsers = [
  process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = browsers.find(existsSync);
if (!browser) { console.error('no Chrome or Edge found'); process.exit(1); }

// 2x so the wordmark stays sharp on high-DPI screens and when GitHub scales it.
await run(browser, [
  '--headless', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--screenshot=' + out,
  '--window-size=' + w + ',' + h,
  'file:///' + tmp.replace(/\\/g, '/'),
]);

console.log(JSON.stringify({ ok: existsSync(out), out, plate, size: `${w * 2}x${h * 2}` }));
