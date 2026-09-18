#!/usr/bin/env node
// banner-forge — sequential-fallback image generation.
//
//   T1  gpt-image-2 via Codex CLI   (ChatGPT subscription quota, no API key)
//   T2  generate_image via agy CLI  (Google subscription quota, no API key)
//   T2b Gemini REST                 (GEMINI_API_KEY, metered — only if a key exists)
//   T3  caller hand-authors SVG     (this script only reports that it got here)
//
// T1 and T2 are the same shape: a locally installed, already-logged-in agent CLI
// driven headlessly. Reaching for an API key before checking for a local CLI is
// how this script got T2 wrong the first time.
//
// Emits one JSON object on stdout. Exit 0 = image written, 4 = a backend is present
// but blocked (say what to fix, do NOT draw an SVG), 3 = nothing is installed at all.
// Secrets are read from env/.env and never printed, logged, or put in argv or a URL.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { homedir, platform } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_TIMEOUT_MS = Number(process.env.IMAGE_FORGE_TIMEOUT_MS || 300000);
const attempts = [];

// ---------- helpers ----------

function loadDotEnv() {
  const f = resolve(ROOT, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, '');
    if (v && !process.env[m[1]]) process.env[m[1]] = v;
  }
}

// PNG / JPEG / WebP magic bytes — proves an actual image landed, not a stray text file.
function sniff(buf) {
  if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length > 3 && buf.toString('hex', 0, 3) === 'ffd8ff') return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function verify(path) {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const mime = sniff(buf);
  return mime ? { mime, bytes: buf.length } : null;
}

function findCodex() {
  const explicit = process.env.CODEX_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;

  const candidates = [];
  if (platform() === 'win32') {
    const appdata = process.env.APPDATA || resolve(homedir(), 'AppData/Roaming');
    // npm global install vendors the real .exe here. The codex.cmd/.ps1 shims on PATH
    // are NOT usable: execFile runs without a shell and dies with ENOENT on them.
    candidates.push(resolve(
      appdata,
      'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64',
      'vendor/x86_64-pc-windows-msvc/bin/codex.exe',
    ));
  } else {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex');
    candidates.push(resolve(homedir(), '.npm-global/bin/codex'));
    candidates.push('/usr/local/bin/codex');
  }
  return candidates.find(existsSync) || null;
}

// ---------- T1: Codex / gpt-image-2 ----------

function runCodex(bin, prompt, outPath) {
  const cwd = dirname(outPath);
  const file = basename(outPath);
  const instruction =
    prompt +
    '\n\nSave the result as "' + file + '" in the current working directory. ' +
    'Do not write any other file. $imagegen';
  const args = ['exec', '--skip-git-repo-check', '-C', cwd, '-s', 'workspace-write', instruction];

  return new Promise((done) => {
    const child = execFile(
      bin,
      args,
      { cwd, timeout: CODEX_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const log = (stdout || '') + '\n' + (stderr || '');
        if (/hit your usage limit|usage limit|quota|rate.?limit|429/i.test(log)) {
          const when = /try again at ([^\n.]+)/i.exec(log);
          return done({ ok: false, reason: 'quota_exhausted', retryAfter: when ? when[1].trim() : null });
        }
        if (err && err.killed) return done({ ok: false, reason: 'timeout' });
        const v = verify(outPath);
        if (v) return done({ ok: true, ...v });
        done({ ok: false, reason: err ? 'codex_failed: ' + String(err.message).slice(0, 200) : 'no_image_written' });
      },
    );
    // Codex reads stdin when it is piped; close it or the run hangs waiting for input.
    child.stdin?.end();
  });
}

// ---------- T2: generate_image via the agy CLI ----------

function findAgy() {
  const explicit = process.env.AGY_BIN;
  if (explicit) return existsSync(explicit) ? explicit : null;
  const candidates = [];
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local');
    candidates.push(resolve(local, 'agy/bin/agy.exe'));
  } else {
    candidates.push(resolve(homedir(), '.local/share/agy/bin/agy'));
    candidates.push('/usr/local/bin/agy');
  }
  return candidates.find(existsSync) || null;
}

function runAgy(bin, prompt, outPath) {
  const cwd = dirname(outPath);
  const file = basename(outPath);
  // The orchestrating model does not have to be Gemini: generate_image is a tool,
  // so a model with quota left can drive it. Gemini models are the usual default
  // and will simply hang when their quota is gone.
  const model = process.env.AGY_MODEL || 'claude-sonnet-4-6';
  const instruction =
    'Use your generate_image tool once to create this image: ' + prompt +
    '\nSave it as "' + file + '" in the current working directory. ' +
    'Do not write any other file. Reply with only DONE, or the exact error text.';
  // --print=<text> must be one argument; a separate arg is swallowed as a flag value.
  const args = [
    '--model', model,
    '--sandbox',
    '--mode', 'accept-edits',
    '--print-timeout', '5m',
    '--print=' + instruction,
  ];

  return new Promise((done) => {
    const child = execFile(
      bin,
      args,
      { cwd, timeout: CODEX_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const log = (stdout || '') + '\n' + (stderr || '');
        if (/usage limit|quota|resource.?exhausted|429/i.test(log)) {
          return done({ ok: false, reason: 'quota_exhausted' });
        }
        // Google answers an exhausted image backend with a 500, not a 429.
        if (/500 Internal Server Error|"code":\s*500|Internal error encountered/i.test(log)) {
          return done({ ok: false, reason: 'upstream_500' });
        }
        if (/print timeout .* turn in progress/i.test(log)) {
          return done({ ok: false, reason: 'turn_timeout' });
        }
        if (err && err.killed) return done({ ok: false, reason: 'timeout' });
        const v = verify(outPath);
        if (v) return done({ ok: true, ...v });
        done({ ok: false, reason: err ? 'agy_failed: ' + String(err.message).slice(0, 200) : 'no_image_written' });
      },
    );
    child.stdin?.end();
  });
}

// ---------- locating a ComfyUI that is installed but switched off ----------

// Directory names never worth descending into when hunting for an install.
const SKIP_DIRS = new Set([
  'windows', 'program files', 'program files (x86)', 'programdata', 'users',
  '$recycle.bin', 'system volume information', 'perflogs', 'recovery', 'appdata',
  'node_modules', 'onedrive',
]);

function looksLikeComfy(dir) {
  return existsSync(resolve(dir, 'ComfyUI/main.py')) || existsSync(resolve(dir, 'main.py'));
}

// Only called when the server did not answer, so the cost lands on the rare path.
// Two levels deep: people put it at "D:\ComfyUI_windows_portable" about as often
// as at "D:\ai\ComfyUI_windows_portable", and one level would miss half of them.
function findComfyDir() {
  const explicit = process.env.COMFY_DIR;
  if (explicit) return looksLikeComfy(explicit) ? resolve(explicit) : null;

  const roots = [homedir()];
  if (platform() === 'win32') {
    for (const letter of 'CDEFG') if (existsSync(letter + ':\\')) roots.push(letter + ':\\');
  } else {
    roots.push('/opt', '/usr/local/share');
  }

  const dirsIn = (p) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      return [];
    }
  };

  for (const root of roots) {
    const top = dirsIn(root);
    for (const e of top) {
      const path = resolve(root, e.name);
      if (/^comfyui/i.test(e.name) && looksLikeComfy(path)) return path;
    }
    for (const e of top) {
      const name = e.name.toLowerCase();
      // Short, non-system folders only — "D:\ai", "D:\tools", not "C:\Windows".
      if (SKIP_DIRS.has(name) || name.startsWith('.') || name.length > 12) continue;
      for (const s of dirsIn(resolve(root, e.name))) {
        const path = resolve(root, e.name, s.name);
        if (/^comfyui/i.test(s.name) && looksLikeComfy(path)) return path;
      }
    }
  }
  return null;
}

function comfyStartCommand(dir) {
  const bat = ['run_nvidia_gpu.bat', 'run_cpu.bat']
    .map((f) => resolve(dir, f))
    .find(existsSync);
  if (bat) return `"${bat}"`;
  const py = resolve(dir, 'python_embeded/python.exe');
  if (existsSync(py)) return `"${py}" -s "${resolve(dir, 'ComfyUI/main.py')}" --listen 127.0.0.1`;
  return `python main.py   (in ${dir})`;
}

// ---------- T2.5: local ComfyUI ----------

// Flux schnell: 4 steps, cfg 1.0, and an SD3-shaped latent. Feeding it a normal
// EmptyLatentImage or a cfg above 1 produces noise, not a worse picture.
function comfyWorkflow(prompt, width, height) {
  const ckpt = process.env.COMFY_CKPT || 'flux1-schnell-fp8.safetensors';
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 1] } },
    4: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } },
    5: {
      class_type: 'KSampler',
      inputs: {
        seed: Math.floor(Math.random() * 2 ** 48),
        steps: Number(process.env.COMFY_STEPS || 4),
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'banner-forge' } },
  };
}

async function runComfy(prompt, outPath, width, height) {
  const base = process.env.COMFY_URL || 'http://127.0.0.1:8188';

  try {
    await fetch(base + '/system_stats', { signal: AbortSignal.timeout(3000) });
  } catch {
    // "Off" and "never installed" are different answers. Saying the first when the
    // second is true sends someone hunting a process that does not exist; saying
    // the second when the first is true throws away a working GPU.
    const dir = findComfyDir();
    if (!dir) {
      return {
        ok: false,
        reason: 'not_installed',
        detail: `nothing at ${base} and no ComfyUI found on this machine. ` +
          'See the README section on the local tier, or set COMFY_DIR/COMFY_URL if it lives somewhere unusual.',
      };
    }
    return {
      ok: false,
      reason: 'server_not_running',
      detail: `installed at ${dir} but nothing is listening on ${base}`,
      fix: `Start ComfyUI, then retry:\n      ${comfyStartCommand(dir)}` +
        (process.env.COMFY_DIR ? '' : `\n    (put COMFY_DIR=${dir} in .env to skip this search next time)`),
    };
  }

  // Check the checkpoint before submitting. ComfyUI rejects an unknown one with
  // a node-validation error that names the field but not the alternatives, so a
  // user whose model is simply called something else has nothing to act on.
  const wanted = process.env.COMFY_CKPT || 'flux1-schnell-fp8.safetensors';
  try {
    const info = await (await fetch(base + '/object_info/CheckpointLoaderSimple')).json();
    const available = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
    if (Array.isArray(available) && !available.includes(wanted)) {
      return {
        ok: false,
        reason: 'checkpoint_not_found',
        detail: available.length
          ? `wanted "${wanted}"; ComfyUI has: ${available.join(', ')}`
          : `wanted "${wanted}"; ComfyUI has no checkpoints at all`,
        fix: available.length
          ? `Set COMFY_CKPT in .env to one of: ${available.join(', ')}`
          : 'Put a .safetensors checkpoint in ComfyUI/models/checkpoints — see the README on the local tier.',
      };
    }
  } catch {
    // The listing is a courtesy. If it cannot be read, submit anyway and let
    // ComfyUI answer — better a real error than a guess about why.
  }

  let promptId;
  try {
    const res = await fetch(base + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: comfyWorkflow(prompt, width, height) }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: 'rejected_' + res.status, detail: body.slice(0, 300) };
    }
    promptId = (await res.json()).prompt_id;
  } catch (e) {
    return { ok: false, reason: 'submit_failed: ' + String(e.message).slice(0, 120) };
  }

  // No completion webhook, so poll history. Offloading on 8 GB cards is slow;
  // a short budget here reads as a hang rather than a slow render.
  const deadline = Date.now() + Number(process.env.COMFY_TIMEOUT_MS || 600000);
  let entry;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const h = await (await fetch(base + '/history/' + promptId)).json();
      if (h?.[promptId]) { entry = h[promptId]; break; }
    } catch { /* server busy mid-render; keep polling */ }
  }
  if (!entry) {
    return {
      ok: false,
      reason: 'render_timeout',
      fix: 'The render outlived COMFY_TIMEOUT_MS (' + Number(process.env.COMFY_TIMEOUT_MS || 600000) +
        ' ms). Raise it in .env, or lower COMFY_STEPS / the requested size.',
    };
  }

  const img = Object.values(entry.outputs || {}).flatMap((o) => o.images || [])[0];
  if (!img) {
    const err = entry.status?.messages?.flat?.().join(' ') || '';
    return { ok: false, reason: 'no_image_in_history', detail: String(err).slice(0, 300) || undefined };
  }

  const view = base + '/view?filename=' + encodeURIComponent(img.filename) +
    '&subfolder=' + encodeURIComponent(img.subfolder || '') +
    '&type=' + encodeURIComponent(img.type || 'output');
  const buf = Buffer.from(await (await fetch(view)).arrayBuffer());
  const mime = sniff(buf);
  if (!mime) return { ok: false, reason: 'fetched_bytes_not_an_image' };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  return { ok: true, mime, bytes: buf.length };
}

// ---------- T2b: Gemini REST / Nano Banana ----------

async function runGemini(prompt, outPath) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

  let res;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      // Key travels as a header, never in the URL — URLs end up in logs and proxies.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    });
  } catch (e) {
    return { ok: false, reason: 'network: ' + String(e.message).slice(0, 120) };
  }

  if (!res.ok) {
    // Google's message says *why* (free tier, per-model limit, bad model name);
    // the status alone does not. The body never contains the key.
    let detail = '';
    try {
      const body = await res.json();
      detail = String(body?.error?.message || '').slice(0, 600);
    } catch {
      detail = '';
    }
    return {
      ok: false,
      reason: res.status === 429 ? 'quota_exhausted' : 'http_' + res.status,
      detail: detail || undefined,
    };
  }

  const json = await res.json();
  const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) return { ok: false, reason: 'no_image_in_response' };

  const buf = Buffer.from(part.inlineData.data, 'base64');
  const mime = sniff(buf);
  if (!mime) return { ok: false, reason: 'response_not_an_image' };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  return { ok: true, mime, bytes: buf.length };
}

// ---------- main ----------

const { values } = parseArgs({
  options: {
    prompt: { type: 'string' },
    out: { type: 'string' },
    tier: { type: 'string', default: 'auto' }, // auto | codex | agy | comfy | gemini
    size: { type: 'string', default: '1024x1024' },
  },
});

if (!values.prompt || !values.out) {
  console.log(JSON.stringify({
    ok: false,
    error: 'usage: gen.mjs --prompt "..." --out path.png [--tier auto|codex|gemini]',
  }));
  process.exit(2);
}

loadDotEnv();
const outPath = resolve(values.out.replace(/^~/, homedir()));
mkdirSync(dirname(outPath), { recursive: true });
const started = Date.now();

const wantCodex = values.tier === 'auto' || values.tier === 'codex';
const wantAgy = values.tier === 'auto' || values.tier === 'agy';
const wantComfy = values.tier === 'auto' || values.tier === 'comfy';
const wantGemini = values.tier === 'auto' || values.tier === 'gemini';

// Flux wants both sides to be multiples of 16; odd sizes silently distort.
const sizeMatch = /^(\d+)x(\d+)$/.exec(values.size || '');
const width = sizeMatch ? Math.round(Number(sizeMatch[1]) / 16) * 16 : 1024;
const height = sizeMatch ? Math.round(Number(sizeMatch[2]) / 16) * 16 : 1024;

// The only reasons that mean "there is nothing here to fix". Everything else is
// a backend that exists and misbehaved, which the caller must be told about.
const ABSENT = new Set(['binary_not_found', 'no_api_key', 'not_installed']);

function remedyFor(a) {
  if (a.reason === 'quota_exhausted') {
    return a.retryAfter
      ? `subscription quota is spent; it returns at ${a.retryAfter}. Retry then, or use another tier.`
      : 'subscription quota is spent. Retry later, or use another tier.';
  }
  if (a.reason === 'upstream_500' || a.reason === 'turn_timeout') {
    return 'the provider failed on its side. Retry, or force another tier with --tier.';
  }
  if (a.reason === 'timeout') {
    return `the backend outlived IMAGE_FORGE_TIMEOUT_MS (${CODEX_TIMEOUT_MS} ms). Raise it or use a faster tier.`;
  }
  return `failed with "${a.reason}"${a.detail ? ` — ${a.detail}` : ''}. This tier is present, so the cause is fixable.`;
}

function succeeded(tier, r) {
  console.log(JSON.stringify({
    ok: true,
    tier,
    path: outPath,
    mime: r.mime,
    bytes: r.bytes,
    elapsedMs: Date.now() - started,
    attempts,
  }));
  return true;
}

// Never call process.exit() here. A spawned child's handles may still be closing,
// and tearing the loop down mid-close trips a libuv assertion on Windows
// (src\win\async.c:76) that replaces the real exit code with a crash code.
// Setting exitCode lets the loop drain on its own.
async function main() {
  if (wantCodex) {
    const bin = findCodex();
    if (!bin) {
      attempts.push({ tier: 'codex', ok: false, reason: 'binary_not_found' });
    } else {
      const r = await runCodex(bin, values.prompt, outPath);
      attempts.push({ tier: 'codex', ...r });
      if (r.ok) { succeeded('codex', r); return 0; }
    }
  }

  if (wantAgy) {
    const bin = findAgy();
    if (!bin) {
      attempts.push({ tier: 'agy', ok: false, reason: 'binary_not_found' });
    } else {
      const r = await runAgy(bin, values.prompt, outPath);
      attempts.push({ tier: 'agy', ...r });
      if (r.ok) { succeeded('agy', r); return 0; }
    }
  }

  if (wantComfy) {
    const r = await runComfy(values.prompt, outPath, width, height);
    attempts.push({ tier: 'comfy', ...r });
    if (r.ok) { succeeded('comfy', r); return 0; }
  }

  if (wantGemini) {
    const r = await runGemini(values.prompt, outPath);
    attempts.push({ tier: 'gemini', ...r });
    if (r.ok) { succeeded('gemini', r); return 0; }
  }

  // SVG is the answer to "this machine has no image model", not to "the image
  // model is switched off". Anything present-but-unhappy gets reported as
  // blocked, with what to do about it, because degrading quietly is how a free
  // GPU sits idle while the caller hand-draws a gradient.
  const remedies = [];
  for (const a of attempts) {
    if (a.ok || ABSENT.has(a.reason)) continue;
    remedies.push(`[${a.tier}] ${a.fix || remedyFor(a)}`);
  }

  if (remedies.length) {
    console.log(JSON.stringify({
      ok: false,
      tier: 'blocked',
      message: 'A backend is installed but did not produce an image. Fix the cause below and retry; ' +
        'do not fall back to SVG.',
      remedies,
      elapsedMs: Date.now() - started,
      attempts,
    }));
    return 4;
  }

  console.log(JSON.stringify({
    ok: false,
    tier: 'svg',
    message: 'No raster backend is installed on this machine. Hand-author an SVG instead.',
    elapsedMs: Date.now() - started,
    attempts,
  }));
  return 3;
}

process.exitCode = await main();
