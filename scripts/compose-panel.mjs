#!/usr/bin/env node
// Lay type inside a lit surface that already exists in a generated image —
// here, the light-panel wall of c06-unattended.
//
// The wall is a lightbox, so the name is painted as a dark silhouette on it
// rather than glowing white: that is what a backlit sign actually looks like,
// and it keeps the lettering vector-sharp instead of asking the model for it.
//
//   node compose-panel.mjs --plate out/c06-unattended.png --out out/x.png
//                          [--rect 210,44,540,64] [--rotate -0.6] [--text "..."]

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

const run = promisify(execFile);

const { values } = parseArgs({
  options: {
    plate: { type: 'string' },
    out: { type: 'string' },
    // No default. A default here is one forgotten flag away from stamping some
    // other project's name onto this one's artwork, and the render succeeds, so
    // nothing tells you until you look at the picture.
    text: { type: 'string' },
    // Pipe-separated lines, stepped one under the other. A single line of this
    // name only fits the wall's dim angled left edge; stacking uses the height
    // the wall actually has and keeps the type on the bright panels.
    lines: { type: 'string', default: '' },
    step: { type: 'string', default: '34' }, // px of indent added per line
    lead: { type: 'string', default: '0.94' }, // line-height multiplier
    sub: { type: 'string', default: '' },
    rect: { type: 'string', default: '212,46,530,60' }, // x,y,w,h in plate pixels
    rotate: { type: 'string', default: '-0.4' },
    size: { type: 'string', default: '1216x224' },
    ink: { type: 'string', default: '#04121f' },
    // multiply suits dark type on a lit surface — the type occludes light rather
    // than painting over it. On a dark surface that leaves nothing visible, so
    // light type needs screen (glow) or normal (paint).
    blend: { type: 'string', default: 'multiply' }, // multiply | screen | normal
    opacity: { type: 'string', default: '0.82' },
    grid: { type: 'boolean', default: false }, // overlay a ruler to find the rect
  },
});

if (!values.plate || !values.out) {
  console.error('usage: compose-panel.mjs --plate <png> --out <png> --text "..." | --lines "A|B|C"\n' +
    '                        [--rect x,y,w,h] [--step px] [--sub "..."] [--grid]');
  process.exit(2);
}
// --grid only measures the plate, so it needs no copy.
if (!values.grid && !values.text && !values.lines) {
  console.error('compose-panel.mjs: nothing to set. Pass --text "..." or --lines "A|B|C".');
  process.exit(2);
}

const [W, H] = values.size.split('x').map(Number);
const [rx, ry, rw, rh] = values.rect.split(',').map(Number);
const plate = resolve(values.plate);
const out = resolve(values.out);
if (!existsSync(plate)) { console.error('plate not found: ' + plate); process.exit(2); }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const lineList = (values.lines || '').split('|').map((s) => s.trim()).filter(Boolean);
const stacked = lineList.length > 1;
const step = Number(values.step);

// Stacked type is sized to the block height; a single line is sized to fit across.
const titleSize = stacked
  ? Math.round((rh / lineList.length) * Number(values.lead) * 0.86)
  : Math.round(rh * 0.46);

// A ruler overlay makes placing the rect one cheap look instead of a guessing loop.
const ruler = values.grid ? `
  <div class="ruler">${Array.from({ length: Math.floor(W / 100) + 1 }, (_, i) =>
    `<span style="left:${i * 100}px">${i * 100}</span>`).join('')}
  </div>
  <div class="ruler v">${Array.from({ length: Math.floor(H / 50) + 1 }, (_, i) =>
    `<span style="top:${i * 50}px">${i * 50}</span>`).join('')}
  </div>` : '';

const html = `<!doctype html><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; background: #000; }
  .banner { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
  .plate { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }

  .sign {
    position: absolute;
    left: ${rx}px; top: ${ry}px; width: ${rw}px; height: ${rh}px;
    display: flex; flex-direction: column;
    align-items: ${stacked ? 'flex-start' : 'center'}; justify-content: center;
    gap: ${stacked ? 0 : Math.round(rh * 0.14)}px;
    transform: rotate(${values.rotate}deg);
    mix-blend-mode: ${values.blend};
    opacity: ${values.opacity};
    /* The plate is shot with shallow depth of field — crisp type would float. */
    filter: blur(0.35px);
  }
  .sign .t {
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-weight: 700; color: ${values.ink};
    font-size: ${titleSize}px;
    letter-spacing: ${(titleSize * 0.1).toFixed(2)}px;
    line-height: ${values.lead}; white-space: nowrap;
  }
  .sign .s {
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    color: ${values.ink}; opacity: .86;
    /* Scaled off the title, not the block: when the block grew to hold three
       stacked lines, a height-derived subtitle grew with it and ran off the
       bright panels into the chair. */
    font-size: ${Math.round(titleSize * 0.36)}px;
    letter-spacing: ${(titleSize * 0.1).toFixed(2)}px;
    line-height: 1; white-space: nowrap;
  }

  .ruler span {
    position: absolute; top: 0; color: #ff2d55; font: 10px monospace;
    border-left: 1px solid #ff2d55; padding-left: 2px; height: ${H}px;
  }
  .ruler.v span {
    left: 0; top: auto; border-left: none; border-top: 1px solid #00e5ff;
    color: #00e5ff; width: ${W}px; height: auto; padding: 0 0 0 2px;
  }
</style>
<div class="banner">
  <img class="plate" src="file:///${plate.replace(/\\/g, '/')}">
  <div class="sign">
    ${stacked
      ? lineList.map((l, i) => `<div class="t" style="margin-left:${i * step}px">${esc(l)}</div>`).join('\n    ')
      : `<div class="t">${esc(values.text || '')}</div>`}
    ${values.sub
      ? `<div class="s" style="margin-left:0; margin-top:${Math.round(titleSize * 0.38)}px">${esc(values.sub)}</div>`
      : ''}
  </div>
  ${ruler}
</div>`;

const tmp = resolve(dirname(out), '.panel.html');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(tmp, html, 'utf8');

const browser = [
  process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
].find(existsSync);
if (!browser) { console.error('no Chrome or Edge found'); process.exit(1); }

await run(browser, [
  '--headless', '--disable-gpu', '--hide-scrollbars',
  '--force-device-scale-factor=2',
  '--screenshot=' + out,
  '--window-size=' + W + ',' + H,
  'file:///' + tmp.replace(/\\/g, '/'),
]);

console.log(JSON.stringify({ ok: existsSync(out), out, rect: values.rect, size: `${W * 2}x${H * 2}` }));
