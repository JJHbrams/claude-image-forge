---
name: image-forge
description: Generate images — hero art, textures, backgrounds, illustrations, thumbnails, OG images, README banners — through an external image model, since Claude cannot draw. Use whenever a task needs a raster image made rather than found. Also use when the request names the machinery instead of the task — ComfyUI, Flux, Stable Diffusion, SDXL, a local or GPU model, gpt-image, DALL-E, Imagen, Gemini, nano-banana, "the image MCP", "the local model", "image-forge" — including a demand for one specific backend, which this skill honours with its tier flag. Korean requests belong here too — 그림 그려줘, 그려줘, 이미지 생성/만들어줘, 배너·썸네일·일러스트·배경·표지 만들어줘, 컴피·컴피유아이·플럭스·로컬 모델로 뽑아줘. Tries a local model, then subscription CLIs, then an API, and says which one produced the image. Do not use for logos, icons or diagrams, which belong in SVG.
---

# image-forge

Claude does not draw. This module hands the job to a model that does, and
reports which backend actually ran.

## Generating

Prefer the MCP tool `generate_image` when it is connected. Otherwise call the
generator directly:

```
node <image-forge>/scripts/gen.mjs --prompt "<description>" --out "<absolute>.png" [--size WxH]
```

Either way you get one JSON object. Parse it — do not judge success by exit
code alone.

```json
{"ok":true,"tier":"comfy","path":"...","mime":"image/png","bytes":184320,"elapsedMs":8412}
```

Three outcomes, and they are not interchangeable:

| `tier` | exit | means | what to do |
|---|---|---|---|
| a backend name | 0 | image written | report which tier ran |
| `blocked` | 4 | a backend is installed but off or misconfigured | relay `remedies`, stop, retry after |
| `svg` | 3 | no raster backend exists here | hand-author the SVG |

**Always tell the user which tier ran.** The difference matters to them: the
local tier is free and unlimited, the subscription tiers spend the quota they
also code with, the API tier spends money.

## When the user names a backend

"Draw it with ComfyUI", "use the local model", "컴피로 뽑아줘" — that is a
request for this skill with the tier already chosen. Pass it through instead of
letting the chain pick:

| they said | `tier` |
|---|---|
| ComfyUI, Flux, SDXL, local, GPU, 로컬, 컴피 | `comfy` |
| gpt-image, Codex, ChatGPT | `codex` |
| Gemini, nano-banana, agy | `agy` (subscription) or `gemini` (API key) |

A named tier is pinned, not preferred: it does not fall through to the others.
If it comes back `blocked`, say what to switch on rather than quietly running a
different backend — they asked for that one, and a silent substitution spends
quota or money they did not agree to.

## Writing the prompt

Name the subject plainly, then the palette, the light, and the composition.
Image models infer none of a project's identity — read its README or package
metadata first and put the real subject in the prompt.

Two failure modes worth knowing before you write:

- **Physics beats instructions.** Ask for teal sparks on molten metal and you
  get orange, because the model believes the metal. Give the colour a physical
  reason instead — "blue-white hot" — and it complies.
- **Lettering comes out as gibberish.** These models cannot spell. Avoid
  subjects that carry writing — gauges, signage, screens, book pages — or the
  image ships with invented words baked into it. No prompt wording fixes this.

## Putting type on an image

Generate the picture, then lay real text over it with the compose scripts, so
the type stays vector-sharp:

```
node <image-forge>/scripts/compose.mjs --plate <png> --out <png> --title "..." [--tagline "..."]
node <image-forge>/scripts/compose-panel.mjs --plate <png> --out <png> --lines "A|B|C" [--rect x,y,w,h]
```

Pass `--grid` first to render a coordinate ruler over the plate and read the
placement off it. One measured look beats several guessed renders.

If the type sits over a lit surface inside the picture — a light wall, a sign —
paint it as a **dark silhouette**, not glowing white. That is what a backlit
sign looks like, and it keeps the text inside the scene instead of floating
over it.

## Composing for type

A picture that will carry a headline is a plate, not a photograph: put the
detail at the edges and leave the middle quiet. A centred subject wins the
thumbnail and loses the title.

If the type will not be added, drop that constraint and compose the whole frame.

## When a backend is present but blocked

`{"ok": false, "tier": "blocked"}` with a `remedies` list. A working backend is
installed and merely switched off or misconfigured — most often ComfyUI, which
is free and unlimited and sitting there not running.

**Stop and say so. Do not draw an SVG, and do not spend a paid tier instead.**
Quote the remedy verbatim — it carries the actual command and path — then wait.
Retry when the user says it is up.

The one thing that is never an answer here: producing a lesser image and
mentioning the failure in passing. The user cannot start a service they were
not told was off.

## When nothing is installed at all

The result comes back `{"ok": false, "tier": "svg"}` — every tier reported
`binary_not_found`, `no_api_key` or `not_installed`, so there is nothing to
switch on. Write the SVG yourself:

- Commit it into the repo. Do not link an external banner service — GitHub
  proxies images through camo and those URLs break.
- Gradient background, one geometric motif, the project name in a system font
  stack, optional tagline at half opacity.
- Set `viewBox`, omit fixed `width`/`height`, no JavaScript, no external fonts,
  no `<image>` references. GitHub strips all three.

An SVG is smaller, diffable and renders identically everywhere. It also cannot
do texture, depth or atmosphere — say that plainly rather than presenting it as
equivalent.

## Limits to state up front

- Logos and icons should be SVG regardless of which tier is available.
- gpt-image-2 has no native transparency. Do not promise a transparent PNG.
- The subscription tiers burn quota several times faster than a text turn.
