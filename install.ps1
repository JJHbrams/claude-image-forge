<#
.SYNOPSIS
  Registers claude-image-forge with Claude Code: the MCP server and the skill.

.DESCRIPTION
  Run this once after cloning. It is idempotent — running it again re-points
  everything at this checkout, which is also how you move the repository.

  What it does:
    1. checks Node 18+ and the claude CLI
    2. registers the MCP server at user scope, pointing at THIS checkout
    3. installs the skill into ~/.claude/skills (symlink if allowed, else copy)
    4. creates .env from .env.example when missing
    5. probes which generation backends are actually reachable right now

.PARAMETER Uninstall
  Removes the MCP registration and the installed skill. Leaves the checkout
  and your .env alone.

.PARAMETER SkipProbe
  Skips the backend probe. The probe only reads; it generates nothing.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$SkipProbe
)

$ErrorActionPreference = 'Stop'

# Anchored to this file, never to the caller's location — the same rule the
# server itself follows, and for the same reason.
$Root      = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerJs  = Join-Path $Root 'mcp\server.mjs'
$SkillSrc  = Join-Path $Root 'skills\image-forge'
$SkillDst  = Join-Path $HOME '.claude\skills\image-forge'
$McpName   = 'image-forge'

function Write-Step { param($Text) Write-Host "`n$Text" -ForegroundColor Cyan }
function Write-Ok   { param($Text) Write-Host "  [ok]   $Text" -ForegroundColor Green }
function Write-Warn { param($Text) Write-Host "  [warn] $Text" -ForegroundColor Yellow }
function Write-Bad  { param($Text) Write-Host "  [fail] $Text" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------

if ($Uninstall) {
  Write-Step 'Removing registration'

  try {
    claude mcp remove $McpName --scope user 2>&1 | Out-Null
    Write-Ok "MCP server '$McpName' removed"
  } catch {
    Write-Warn "MCP server was not registered"
  }

  if (Test-Path $SkillDst) {
    # A symlinked skill must be removed as a link, or Remove-Item walks into
    # the checkout and deletes the originals.
    $item = Get-Item $SkillDst -Force
    if ($item.LinkType) { $item.Delete() } else { Remove-Item $SkillDst -Recurse -Force }
    Write-Ok "skill removed from $SkillDst"
  } else {
    Write-Warn 'skill was not installed'
  }

  Write-Host "`nDone. The checkout and your .env were left alone.`n"
  exit 0
}

# ---------------------------------------------------------------------------
# prerequisites
# ---------------------------------------------------------------------------

Write-Step 'Checking prerequisites'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Bad 'node not found on PATH. Install Node 18 or newer: https://nodejs.org'
  exit 1
}
$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 18) {
  Write-Bad "node $nodeVersion is too old; this needs 18 or newer (it uses fetch and parseArgs)."
  exit 1
}
Write-Ok "node $nodeVersion"

if (-not (Test-Path $ServerJs)) {
  Write-Bad "server missing: $ServerJs — is this a complete checkout?"
  exit 1
}
Write-Ok 'server present'

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Write-Bad 'claude CLI not found on PATH. Install Claude Code first.'
  exit 1
}
Write-Ok 'claude CLI found'

# ---------------------------------------------------------------------------
# MCP registration
# ---------------------------------------------------------------------------

Write-Step 'Registering the MCP server (user scope)'

# Remove first so a re-run re-points at this checkout instead of failing or
# leaving a stale path behind. A missing entry is not an error here.
try { claude mcp remove $McpName --scope user 2>&1 | Out-Null } catch { }

$addOutput = & claude mcp add --scope user $McpName -- node $ServerJs 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Bad "registration failed: $addOutput"
  exit 1
}
Write-Ok "registered -> $ServerJs"

# ---------------------------------------------------------------------------
# skill
# ---------------------------------------------------------------------------

Write-Step 'Installing the skill'

$skillsRoot = Split-Path -Parent $SkillDst
if (-not (Test-Path $skillsRoot)) { New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null }

if (Test-Path $SkillDst) {
  $existing = Get-Item $SkillDst -Force
  if ($existing.LinkType) { $existing.Delete() } else { Remove-Item $SkillDst -Recurse -Force }
}

# A symlink keeps the installed skill in step with the checkout, but it needs
# Developer Mode or an elevated shell on Windows. Copying works everywhere, at
# the cost of having to re-run this script after editing the skill.
$linked = $false
try {
  New-Item -ItemType SymbolicLink -Path $SkillDst -Target $SkillSrc -ErrorAction Stop | Out-Null
  $linked = $true
} catch {
  Copy-Item $SkillSrc $SkillDst -Recurse -Force
}

if ($linked) {
  Write-Ok "linked $SkillDst -> $SkillSrc"
} else {
  Write-Ok "copied to $SkillDst"
  Write-Warn 'copied, not linked (Developer Mode is off) — re-run this script after editing the skill'
}

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------

Write-Step 'Configuration'

$envPath = Join-Path $Root '.env'
$envExample = Join-Path $Root '.env.example'
if (-not (Test-Path $envPath) -and (Test-Path $envExample)) {
  Copy-Item $envExample $envPath
  Write-Ok 'created .env from .env.example'
  Write-Warn 'the API tier stays off until you put a key in .env — the other tiers need no key'
} elseif (Test-Path $envPath) {
  Write-Ok '.env already exists, left untouched'
}

# ---------------------------------------------------------------------------
# backend probe
#
# Reports what is reachable right now. None of this is required to install —
# the chain falls through to whatever is available, and says so at call time.
# ---------------------------------------------------------------------------

if (-not $SkipProbe) {
  Write-Step 'Backends reachable right now'

  # local: ComfyUI
  $comfyUrl = if ($env:COMFY_URL) { $env:COMFY_URL } else { 'http://127.0.0.1:8188' }
  try {
    Invoke-WebRequest -Uri "$comfyUrl/system_stats" -TimeoutSec 3 -UseBasicParsing | Out-Null
    Write-Ok "local (ComfyUI) at $comfyUrl — free, unlimited"
  } catch {
    Write-Warn "local (ComfyUI) not running at $comfyUrl — start it to use the free tier"
  }

  # subscription CLIs
  foreach ($cli in @(
      @{ Name = 'codex'; Note = 'gpt-image-2 on your ChatGPT quota' },
      @{ Name = 'agy';   Note = 'generate_image on your Google quota' })) {
    if (Get-Command $cli.Name -ErrorAction SilentlyContinue) {
      Write-Ok "$($cli.Name) CLI found — $($cli.Note)"
    } else {
      Write-Warn "$($cli.Name) CLI not on PATH — that tier will be skipped"
    }
  }

  # API key, presence only. The value is never read or printed.
  $hasKey = $false
  if ($env:GEMINI_API_KEY) { $hasKey = $true }
  elseif (Test-Path $envPath) {
    if (Select-String -Path $envPath -Pattern '^\s*GEMINI_API_KEY\s*=\s*\S' -Quiet) { $hasKey = $true }
  }
  if ($hasKey) {
    Write-Ok 'GEMINI_API_KEY is set — metered API tier available'
  } else {
    Write-Warn 'no GEMINI_API_KEY — metered API tier will be skipped'
  }
}

# ---------------------------------------------------------------------------

Write-Host @"

Installed.

  Restart Claude Code, or run /mcp to reconnect, and generate_image appears.

  Uninstall:  .\install.ps1 -Uninstall
  Move it:    move the checkout, then run .\install.ps1 there again

"@ -ForegroundColor Green
