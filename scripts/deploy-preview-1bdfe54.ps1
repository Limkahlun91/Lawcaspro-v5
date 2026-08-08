$ErrorActionPreference = "Stop"
$RepoRoot = "c:\Users\User\Documents\GitHub\Lawcaspro-v5"
$WtRoot = Join-Path $RepoRoot ".preview-worktree-1bdfe54"
$ExpectedSha = "1bdfe54130134766fc793972ef3ac1225a13a986"
$ExpectedShort = $ExpectedSha.Substring(0,7)
$ScriptsBin = Join-Path $RepoRoot "scripts\node_modules\.bin"
$VercelPs1 = Join-Path $ScriptsBin "vercel.ps1"
$VercelCmd = Join-Path $ScriptsBin "vercel.cmd"
$MainPjJson = Join-Path $RepoRoot ".vercel\project.json"

Write-Host "== Gate 1: GitClean worktree =="
Set-Location $WtRoot
$porcelain = git status --porcelain=v1 --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw "Gate1 git status exit=$LASTEXITCODE" }
$dirtyCount = (@($porcelain)).Count
Write-Host "  dirty_lines=$dirtyCount"
if ($dirtyCount -ne 0) { throw "Gate1 FAIL: dirty worktree lines=$dirtyCount`n$porcelain" }
Write-Host "  PASS (Exit=0 Count=0)"

Write-Host "== Gate 2: HEAD == $ExpectedShort =="
$head = (git rev-parse HEAD).Trim()
Write-Host "  HEAD=$head"
if ($head -ne $ExpectedSha) { throw "Gate2 FAIL: HEAD=$head expected=$ExpectedSha" }
Write-Host "  PASS"

Write-Host "== Gate 3: No commit-extra deploy config files =="
$forbidden = @(
  (Join-Path $WtRoot ".vercelignore"),
  (Join-Path $WtRoot ".vercel\project.json"),
  (Join-Path $WtRoot ".vercel\README.txt")
)
foreach ($f in $forbidden) {
  if (Test-Path $f) { throw "Gate3 FAIL: must not exist: $f" }
}
Write-Host "  .vercelignore absent            : TRUE"
Write-Host "  .vercel/project.json absent     : TRUE"
Write-Host "  .vercel/README.txt absent       : TRUE"
Write-Host "  Any commit-extra deploy configuration present: FALSE"
Write-Host "  PASS"

Write-Host "== Resolve vercel exe =="
$VercelExe = $null
if (Test-Path $VercelCmd) { $VercelExe = $VercelCmd }
elseif (Test-Path $VercelPs1) { $VercelExe = $VercelPs1 }
else { throw "vercel not found in $ScriptsBin; run: cd scripts ; pnpm add -D vercel@58.7.1 first." }
Write-Host "  VercelExe=$VercelExe"

Write-Host "== Extract main project/org IDs =="
if (-not (Test-Path $MainPjJson)) { throw "Missing $MainPjJson" }
$mainPj = Get-Content $MainPjJson -Raw | ConvertFrom-Json
$env:VERCEL_PROJECT_ID = $mainPj.projectId
$env:VERCEL_ORG_ID     = $mainPj.orgId
Write-Host "  VERCEL_PROJECT_ID=$($env:VERCEL_PROJECT_ID.Substring(0,8)+'...')"
Write-Host "  VERCEL_ORG_ID=$($env:VERCEL_ORG_ID.Substring(0,8)+'...')"

Write-Host "== Deploy Preview (--yes, no scope/prod flags) =="
try {
  & $VercelExe deploy --yes
  $ec = $LASTEXITCODE
  Write-Host "  vercel deploy exit=$ec"
  if ($ec -ne 0) { throw "vercel deploy exit=$ec" }
} finally {
  Remove-Item Env:VERCEL_PROJECT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:VERCEL_ORG_ID -ErrorAction SilentlyContinue
  Set-Location $RepoRoot
}
Write-Host "== Done. Old worktree preserved. Cleanup (LATER, after user tests) =="
Write-Host "  git worktree remove .preview-worktree-a4b70af ; git worktree prune"
Write-Host "  git worktree remove .preview-worktree-1bdfe54 ; git worktree prune"
