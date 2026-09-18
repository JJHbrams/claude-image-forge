#!/usr/bin/env node
// image-forge — an MCP server that gives a Claude session image generation.
//
// One tool, generate_image, backed by the tier fallback chain in scripts/gen.mjs:
// a local model first where one is running, then whatever subscription or API
// tiers are configured, and a clear refusal when none are reachable.
//
// Nothing here resolves against the caller's cwd. An MCP client starts its
// servers wherever it happens to be running — which may be a directory this
// process cannot write to — so paths are anchored to this file, and a relative
// output path is refused rather than quietly written somewhere surprising.
// The failure that motivated this: a sibling server defaulted its state
// directory to "./…", was launched from C:\WINDOWS\system32, and died with a
// bare PermissionError that reached the client as "connection closed".

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GEN = resolve(ROOT, 'scripts/gen.mjs');

const NAME = 'image-forge';
const VERSION = '0.1.0';
const PROTOCOL = '2024-11-05';

// Where images land when the caller does not say. Anchored to the user's home,
// never to cwd — see the header.
function defaultOutputDir() {
  if (process.env.IMAGE_FORGE_OUT) return resolve(process.env.IMAGE_FORGE_OUT);
  const base = platform() === 'win32'
    ? (process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'))
    : resolve(homedir(), '.local/share');
  return resolve(base, 'image-forge', 'out');
}

// Refuse rather than guess. A relative path means the caller assumed a cwd, and
// the cwd an MCP server inherits is not the one they were thinking of.
function resolveOutput(requested) {
  if (!requested) {
    const dir = defaultOutputDir();
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    return { path: resolve(dir, `image-${stamp}-${Math.floor(Math.random() * 1e4)}.png`) };
  }
  if (!isAbsolute(requested)) {
    return { error: `output_path must be absolute; got "${requested}". ` +
      'This server does not resolve paths against a working directory.' };
  }
  return { path: resolve(requested) };
}

// ---------------------------------------------------------------------------
// startup checks — fail loudly, on stderr, before speaking protocol
// ---------------------------------------------------------------------------

function preflight() {
  const problems = [];
  if (!existsSync(GEN)) problems.push(`generator missing: ${GEN}`);
  const dir = defaultOutputDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    problems.push(`cannot create output directory ${dir}: ${e.code || e.message}. ` +
      'Set IMAGE_FORGE_OUT to a writable absolute path.');
  }
  if (problems.length) {
    for (const p of problems) process.stderr.write(`[${NAME}] startup failed: ${p}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// the one tool
// ---------------------------------------------------------------------------

const TOOL = {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt and write it to disk. Tries each configured ' +
    'backend in order and reports which one produced the image. Returns the absolute ' +
    'file path. Not for logos or icons — those belong in SVG.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What to draw. Be specific about subject, palette, mood and composition. ' +
          'Avoid asking for text in the image; these models render lettering as gibberish.',
      },
      output_path: {
        type: 'string',
        description: 'Absolute path to write the PNG to. Optional; defaults to this ' +
          "server's output directory. Relative paths are refused.",
      },
      size: {
        type: 'string',
        description: 'WIDTHxHEIGHT, e.g. "1216x224". Rounded to multiples of 16. Default 1024x1024.',
      },
      tier: {
        type: 'string',
        description: 'Force one backend instead of trying them in order. Debugging aid.',
      },
    },
    required: ['prompt'],
  },
};

function runGenerator({ prompt, output_path, size, tier }) {
  const out = resolveOutput(output_path);
  if (out.error) return Promise.resolve({ ok: false, error: out.error });

  const args = [GEN, '--prompt', prompt, '--out', out.path];
  if (size) args.push('--size', size);
  if (tier) args.push('--tier', tier);

  return new Promise((done) => {
    const child = execFile(
      process.execPath, args,
      // cwd is this package, not the caller's: the generator writes nothing
      // relative, but anchoring it keeps the chain honest if that ever changes.
      { cwd: ROOT, timeout: Number(process.env.IMAGE_FORGE_TIMEOUT_MS || 900000), maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const line = String(stdout || '').trim().split('\n').pop();
        try {
          const parsed = JSON.parse(line);
          return done(parsed);
        } catch {
          done({
            ok: false,
            error: 'generator produced no usable result',
            detail: String(stderr || err?.message || '').slice(0, 500),
          });
        }
      },
    );
    child.stdin?.end();
  });
}

function describe(result) {
  if (result.ok) {
    return `Generated via ${result.tier} in ${Math.round((result.elapsedMs || 0) / 1000)}s.\n` +
      `${result.path}\n${result.mime}, ${result.bytes} bytes`;
  }
  const tried = (result.attempts || [])
    .map((a) => `  ${a.tier}: ${a.reason}${a.detail ? ` — ${a.detail}` : ''}`)
    .join('\n');

  // A blocked run is not a licence to substitute an SVG. Something here works and
  // is merely switched off or misconfigured, and only the user can flip it back on.
  if (result.tier === 'blocked') {
    const fixes = (result.remedies || []).map((r) => `  - ${r}`).join('\n');
    return `No image yet — a backend is installed but did not run.\n\nTried:\n${tried}\n\n` +
      `To fix:\n${fixes}\n\n` +
      'Do NOT hand-author an SVG instead. Tell the user exactly what to start or set, ' +
      'and retry once they say it is up.';
  }

  return `No backend produced an image.\n${tried || '  ' + (result.error || 'unknown')}` +
    (result.tier === 'svg'
      ? '\n\nNo raster backend is installed on this machine. Author an SVG instead.'
      : '');
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  if (id === undefined || id === null) return; // notification
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
      });

    case 'notifications/initialized':
      return;

    case 'tools/list':
      return reply(id, { tools: [TOOL] });

    case 'tools/call': {
      if (params?.name !== TOOL.name) {
        return fail(id, -32602, `unknown tool: ${params?.name}`);
      }
      const args = params.arguments || {};
      if (!args.prompt || typeof args.prompt !== 'string') {
        return reply(id, { isError: true, content: [{ type: 'text', text: 'prompt is required' }] });
      }
      const result = await runGenerator(args);
      return reply(id, {
        isError: !result.ok,
        content: [{ type: 'text', text: describe(result) }],
      });
    }

    case 'ping':
      return reply(id, {});

    default:
      return fail(id, -32601, `method not found: ${method}`);
  }
}

preflight();

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    // A malformed line is the client's problem, and there is no id to answer.
    process.stderr.write(`[${NAME}] ignoring unparseable line\n`);
    return;
  }
  try {
    await handle(msg);
  } catch (e) {
    fail(msg.id, -32603, String(e?.message || e).slice(0, 300));
  }
});
rl.on('close', () => process.exit(0));
