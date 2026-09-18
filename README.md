<p align="center">
  <img src="assets/banner.png" alt="image-forge — external image generation for Claude" width="100%">
</p>

# image-forge

Claude 세션에 **이미지 생성을 붙이는 외장 모듈**. Claude는 이미지를 직접 그리지 못하니
그릴 줄 아는 모델을 밖에서 물려준다. MCP 서버 하나와, 결과물을 다듬는 합성 스크립트
몇 개로 되어 있다.

```
Claude ──MCP──► image-forge ──┬─► 로컬 모델 (ComfyUI)      쿼터 없음
                              ├─► 구독 CLI (codex / agy)   키 없음
                              ├─► API (Gemini)             키 필요
                              └─► 전부 막힘 → SVG로 안내
```

백엔드 하나가 막혀도 다음으로 내려간다. 어느 티어가 그렸는지는 매번 결과에 적힌다 —
로컬은 공짜지만 느리고, 구독 티어는 네 코딩 쿼터를 깎고, API는 돈을 쓴다. 어느 쪽을
썼는지 모르면 안 되는 차이다.

## 설치

```powershell
git clone https://github.com/JJHbrams/claude-image-forge
cd claude-image-forge
.\install.ps1
```

Claude Code 를 재시작하거나 `/mcp` 로 재연결하면 `generate_image` 가 잡힌다.

설치 스크립트가 하는 일 — MCP 서버를 **user scope** 로 등록하고, 스킬을
`~/.claude/skills` 에 설치하고, `.env` 가 없으면 만들고, **지금 어느 백엔드가 살아
있는지** 찍어준다. 멱등이라 다시 돌려도 안 깨진다. 저장소를 옮겼으면 옮긴 자리에서
한 번 더 돌리면 경로가 다시 잡힌다.

```powershell
.\install.ps1 -Uninstall    # 등록과 스킬만 제거. 체크아웃과 .env 는 그대로
.\install.ps1 -SkipProbe    # 백엔드 탐지 건너뛰기
```

의존성은 없다. Node 18+ 면 된다(`fetch`, `parseArgs` 사용).

개발자 모드가 꺼져 있으면 스킬이 **링크가 아니라 복사**로 들어간다 — 그 경우 스킬을
고친 뒤 스크립트를 다시 돌려야 반영된다. 스크립트가 어느 쪽인지 알려준다.

API 티어를 쓰려면 `.env` 에 키를 채운다. 키는 argv·URL·로그에 싣지 않으며 `.env` 는
gitignore 되어 있다. **나머지 티어는 키 없이 돈다.**

## 로컬 티어 설치 (선택)

없어도 모듈은 돈다 — 구독 CLI 나 API 로 내려간다. 다만 **로컬만 쿼터가 없다.** 장당
8초에 20장 뽑아 고르는 게 가능한 건 여기뿐이라, GPU 가 있으면 깔 값어치가 있다.

설치 스크립트는 **이걸 받아주지 않는다.** 수십 GB 를 묻지도 않고 내려받는 건 남의
디스크와 회선에 대한 결정이라, 무엇이 없는지만 알려주고 판단은 넘긴다.

### 1. ComfyUI

[릴리즈](https://github.com/comfyanonymous/ComfyUI/releases)에서 Windows 포터블을
받는다. NVIDIA 면 `ComfyUI_windows_portable_nvidia.7z` (약 1.8 GB). 파이썬이 같이
들어 있어 별도 설치가 필요 없다. 압축을 풀면 끝이다.

### 2. 체크포인트

포터블 안 `ComfyUI\models\checkpoints\` 에 `.safetensors` 를 넣는다. 기본 기대값은
[Flux.1-schnell fp8](https://huggingface.co/Comfy-Org/flux1-schnell) 단일 파일
(`flux1-schnell-fp8.safetensors`, 약 16 GB) 이다 — UNet·CLIP·T5·VAE 가 한 파일에
들어 있어 인코더를 따로 받아 배선할 필요가 없다.

`schnell` 은 4 스텝짜리라 빠르다. `dev` 는 20~50 스텝이라 품질이 조금 낫지만 장당
몇 분씩 걸려서, **여러 장 뽑아 고른다**는 로컬의 유일한 강점이 사라진다.

다른 모델을 써도 된다. 파일 이름을 `.env` 의 `COMFY_CKPT` 에 적어주면 되고, 이름이
어긋나면 체인이 **ComfyUI 에 실제로 뭐가 있는지 목록으로 알려준다.**

### 3. 기동

```powershell
cd <포터블 폴더>
.\python_embeded\python.exe -s ComfyUI\main.py --listen 127.0.0.1
```

`.\install.ps1` 을 다시 돌리면 잡혔는지, 체크포인트가 뭐가 보이는지 찍어준다.

### VRAM

8 GB 면 Flux fp8 이 다 안 올라가서 시스템 RAM 으로 오프로딩한다. **느린 거지 안 되는
건 아니다** — 1216x320 기준 콜드 스타트 약 170 초, 이후 28~36 초. 첫 장만 모델을
디스크에서 올리느라 오래 걸린다.

## 도구

### `generate_image`

| 인자 | |
|---|---|
| `prompt` | **필수.** 소재·팔레트·분위기·구도를 구체적으로. 글자는 요구하지 말 것 |
| `output_path` | 절대경로. 생략하면 서버 기본 출력 폴더. **상대경로는 거부된다** |
| `size` | `WIDTHxHEIGHT`, 16의 배수로 반올림. 기본 `1024x1024` |
| `tier` | 특정 백엔드 강제. 디버깅용 |

상대경로를 거부하는 건 까다로워서가 아니다. MCP 서버는 **클라이언트가 실행된 곳**에서
뜨고, 그 cwd는 호출자가 생각한 디렉터리가 아니다. 조용히 엉뚱한 데 쓰느니 거절한다.

## 티어

| | 백엔드 | 비용 | 필요한 것 |
|---|---|---|---|
| T1 | gpt-image-2 (`codex exec`) | ChatGPT 구독 쿼터 | Codex CLI 로그인 |
| T2 | `generate_image` (`agy --print`) | Google 구독 쿼터 | agy CLI 로그인 |
| T2.5 | 로컬 (ComfyUI) | **무료·무제한** | GPU + 체크포인트 ([설치](#로컬-티어-설치-선택)) |
| T2b | `gemini-2.5-flash-image` REST | 종량 과금 | `GEMINI_API_KEY` |
| T3 | — | — | 래스터 불가. SVG로 안내 |

T1·T2는 같은 모양이다 — **로컬에 깔려서 이미 로그인된 에이전트 CLI를 헤드리스로 모는
것.** 로컬 CLI를 확인하기 전에 API 키부터 찾는 건 이 모듈이 처음에 틀렸던 부분이다.

## 알아둘 것

- **글자를 생성시키지 마라.** 이 모델들은 레터링을 못 한다. 계기판·간판·책처럼 글자가
  들어갈 소재를 고르면 `RESTAR` 같은 가짜 글자가 픽셀에 박히고, 프롬프트로는 못 고친다.
  제목이 필요하면 배경만 생성하고 글자는 `scripts/compose*.mjs` 로 얹는다.
- **로고·아이콘은 티어와 무관하게 SVG 가 맞다.** 래스터로 뽑지 말 것.
- **gpt-image-2 는 투명 배경을 지원하지 않는다.** 알파가 필요하면 후처리하거나 SVG로.
- **Gemini 무료 키로는 T2b 가 영원히 안 된다.** 소진이 아니라 미할당이다 —
  `generate_content_free_tier_requests, limit: 0`. 결제를 붙인 프로젝트의 키여야 한다.
- **T1 은 코딩 쿼터를 같이 깎는다.** 이미지 생성은 텍스트 턴 대비 3~5배 빠르게 소모된다.

## 합성 스크립트

생성 모델이 못 하는 걸 브라우저가 대신한다. 질감은 래스터로 얻고 글자는 벡터로 얹는다.

```powershell
# 배경 위에 워드마크
node scripts\compose.mjs --plate <png> --out <png> --title "..." [--tagline "..."]

# 이미지 안의 발광면 위에 글자 (라이트박스 벽, 간판 등)
node scripts\compose-panel.mjs --plate <png> --out <png> --lines "A|B|C" [--rect x,y,w,h] [--grid]
```

`--grid` 는 좌표 자를 겹쳐 렌더한다. 눈대중으로 여러 번 왔다갔다 하느니 한 번 재고 끝내는
게 싸다.

두 스크립트 모두 **제목 기본값이 없다.** 기본값이 있으면 플래그 하나 빠뜨렸을 때 남의
프로젝트 이름이 그림에 박히는데, 렌더는 성공하므로 눈으로 보기 전까지 아무도 모른다.

## 사용 예

README 배너를 만든 레시피는 그 저장소가 갖고 있다 — 프롬프트와 좌표는 프로젝트의
디자인 결정이지 이 도구의 지식이 아니다.

```
<your-project>/scripts/banner-recipe.mjs
```

이 모듈은 어떻게 그리는지만 알고, 무엇을 그릴지는 부르는 쪽이 안다.
