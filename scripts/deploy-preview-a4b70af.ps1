# deploy-preview-a4b70af.ps1
# Single-use deployment runner for commit a4b70af.
#
# Rules from Corrective Review V3+V4 (follow strictly):
#  * Detached worktree MUST remain EXACTLY commit a4b70af (+ tracked vercel.json
#    that is byte-identical to the commit).
#  * Commit-extra deploy configuration files (./.vercelignore, ./.vercel/project.json,
#    ./.vercel/README.txt) MUST NOT exist in the worktree and MUST NOT be copied
#    in before deploy.
#  * Linkage to existing project is provided ONLY via environment variables
#    VERCEL_PROJECT_ID and VERCEL_ORG_ID (values come from the main workspace
#    .vercel/project.json, which has been manually verified).
#  * `--scope`, `--project`, `--prod`, `--prod=false`, `vercel promote` are
#    strictly forbidden in this script.

[CmdletBinding()]
param(
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$wt = Join-Path $repoRoot ".preview-worktree-a4b70af"
$expectedSha = "a4b70af8177b5d86342b796389d7bcb9bd6f2ba0"

$binDir = Join-Path $PSScriptRoot "node_modules\.bin"
$vercelPs1 = Join-Path $binDir "vercel.ps1"
$vercelCmd = Join-Path $binDir "vercel.cmd"
if (Test-Path $vercelPs1) {
  $VercelExe = $vercelPs1
} elseif (Test-Path $vercelCmd) {
  $VercelExe = $vercelCmd
} else {
  throw 'Vercel CLI not installed under @workspace/scripts/node_modules/.bin — run pnpm --filter @workspace/scripts add -D vercel first.'
}

Write-Host "== deploy-preview-a4b70af =="
Write-Host "repoRoot: $repoRoot"
Write-Host "worktree: $wt"
Write-Host ""

if (-not (Test-Path $wt)) {
  throw "Preview worktree not found at: $wt"
}

Set-Location $wt

# --- Gate 1: worktree git status MUST be clean ---------------------------------
$statusLines = @( git status --porcelain=v1 --untracked-files=all )
$statusExit = $LASTEXITCODE
if ($statusExit -ne 0) {
  throw "Unable to query Preview Worktree git status (exit $statusExit)."
}
if ($statusLines.Count -ne 0) {
  Write-Host "Git status lines (dirty):"
  $statusLines | ForEach-Object { Write-Host "  STATUS> [$_]" }
  throw "Preview Worktree is not clean. Deployment blocked."
}
Write-Host "[OK] Preview Worktree git status: CLEAN (exit 0, 0 lines)"

# --- Gate 2: HEAD MUST be the exact commit ------------------------------------
$headSha = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) {
  throw "Unable to query Preview Worktree HEAD SHA."
}
if ($headSha -ne $expectedSha) {
  throw "Unexpected deployment SHA. Expected=$expectedSha Actual=$headSha"
}
Write-Host "[OK] Preview Worktree HEAD SHA: $headSha"

# --- Gate 3: NO commit-extra deploy configs in worktree -----------------------
$vercelIgnore = Join-Path $wt ".vercelignore"
$vercelDir     = Join-Path $wt ".vercel"
$projectJson   = Join-Path $vercelDir "project.json"
$readmeTxt     = Join-Path $vercelDir "README.txt"

$violations = @()
if (Test-Path $vercelIgnore) { $violations += ".vercelignore" }
if (Test-Path $projectJson)   { $violations += ".vercel/project.json" }
if (Test-Path $readmeTxt)     { $violations += ".vercel/README.txt" }
if ($violations.Count -gt 0) {
  throw "Commit-extra deploy config present in worktree: $($violations -join ', '). Remove before deploy."
}
Write-Host "[OK] Any commit-extra deploy configuration present: FALSE"
Write-Host "     (only tracked vercel.json from commit $expectedSha remains)"

# --- Gate 4: Vercel env linkage MUST come from main workspace .vercel/project.json
$mainPjPath = Join-Path $repoRoot ".vercel\project.json"
if (-not (Test-Path $mainPjPath)) {
  throw "Main workspace .vercel/project.json missing; cannot set VERCEL_PROJECT_ID/VERCEL_ORG_ID."
}
$mainPj = Get-Content $mainPjPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($mainPj.projectId)) {
  throw "Main workspace project.json missing projectId."
}
if ([string]::IsNullOrWhiteSpace($mainPj.orgId)) {
  throw "Main workspace project.json missing orgId."
}
Write-Host "[OK] Existing Vercel project: name=$($mainPj.projectName) projectId=$($mainPj.projectId) orgId=$($mainPj.orgId)"

$env:VERCEL_PROJECT_ID = $mainPj.projectId
$env:VERCEL_ORG_ID     = $mainPj.orgId
Write-Host "[OK] VERCEL_PROJECT_ID / VERCEL_ORG_ID set for this process only."

try {
  if ($WhatIf) {
    Write-Host ""
    Write-Host "=== WHATIF ==="
    Write-Host "Vercel CLI resolved path (local @workspace/scripts): $VercelExe"
    Write-Host ('Would run in ' + $wt + ' ::')
    Write-Host ('  & "' + $VercelExe + '" deploy --yes')
    Write-Host "with VERCEL_PROJECT_ID / VERCEL_ORG_ID process env set."
    Write-Host "Forbidden flags explicitly not used: --scope, --project, --prod, --prod=false"
    Write-Host "Post-condition (user requested): after deploy, run from repo root:"
    Write-Host "  git worktree remove .preview-worktree-a4b70af"
    Write-Host "  git worktree prune"
    exit 0
  }

  Write-Host ""
  Write-Host ('=== Running & "' + $VercelExe + '" deploy --yes ===')
  & $VercelExe deploy --yes
  $deployExit = $LASTEXITCODE

  if ($deployExit -ne 0) {
    throw "Vercel Preview deployment failed with exit code $deployExit."
  }
  Write-Host ""
  Write-Host ('deploy --yes exit code: ' + $deployExit)
}
finally {
  Remove-Item Env:VERCEL_PROJECT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:VERCEL_ORG_ID     -ErrorAction SilentlyContinue
  Write-Host "VERCEL_PROJECT_ID / VERCEL_ORG_ID removed from process env."
  Set-Location $repoRoot
}

Write-Host ""
Write-Host "=== Deploy complete: requested post-actions ==="
Write-Host "(1) User performs Lawcaspro Browser UI tests on Preview URL."
Write-Host "(2) After tests + logs reviewed, clean the worktree from repoRoot:"
Write-Host "      Set-Location $repoRoot"
Write-Host "      git worktree remove '.preview-worktree-a4b70af'"
Write-Host "      git worktree prune"
