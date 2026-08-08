<#
.SYNOPSIS
  Accounting Security Sweep Static Lint (PART 3 Sec 11)
  Enumerates all accounting-family route files in artifacts/api-server/src/routes
  and checks 7 scenario contract antipatterns via static regex scan.
  Does NOT need a running server. Runs in CI with nonzero exit on violations.
#>

param(
  [string]$RoutesRoot = (Resolve-Path (Join-Path $PSScriptRoot "../../artifacts/api-server/src/routes")).Path,
  [switch]$WriteReports = $false
)

$ErrorActionPreference = "Stop"

$ACCOUNTING_ROUTE_FILES = @(
  "accounting.ts","accounting-settings.ts","payment-vouchers.ts","payment-voucher-actions.ts",
  "invoices.ts","receipts.ts","quotations.ts","file-custody.ts","einvoices.ts","case-monitor.ts",
  "audit.ts"
)

$VIOLATIONS = New-Object System.Collections.Generic.List[object]

function Add-Violation([string]$level, [string]$file, [int]$lineNo, [string]$rule, [string]$snippet) {
  $VIOLATIONS.Add([pscustomobject]@{ Level=$level; File=$file; Line=$lineNo; Rule=$rule; Snippet=$snippet })
}

Write-Host ("="*90)
Write-Host "ACCOUNTING SECURITY SWEEP STATIC LINT (PART 3 SEC.11)"
Write-Host "Routes root: $RoutesRoot"
Write-Host ("="*90)

$scannedFiles = 0
foreach ($fname in $ACCOUNTING_ROUTE_FILES) {
  $fpath = Join-Path $RoutesRoot $fname
  if (-not (Test-Path $fpath)) { Write-Warning "Skip missing route: $fname"; continue }
  $scannedFiles++
  $lines = Get-Content $fpath
  $raw = [System.IO.File]::ReadAllText($fpath)

  for ($i = 0; $i -lt $lines.Length; $i++) {
    $line = $lines[$i]
    $lineNo = $i + 1

    if ($line -match 'firm_?[Ii]d\s*[:=]\s*\d{2,}' -and $line -notmatch 'firmId\s*:\s*0\s*,\s*//\s*audit\s+non-fatal|//\s*FALLBACK') {
      Add-Violation -level "FAIL" -file $fname -lineNo $lineNo -rule "11G_HARDCODED_NUMERIC_FIRM_ID" -snippet ($line.Trim())
    }

    $phrases = @("belongs to another firm","not in your firm","case exists","invalid firm_id for","another firm","firm's case","exists elsewhere","entity exists")
    foreach ($phrase in $phrases) {
      if ($line -match [regex]::Escape($phrase) -and $line -match '(message|statusText|detail|send\(|json\()') {
        Add-Violation -level "FAIL" -file $fname -lineNo $lineNo -rule "11DE_CROSS_FIRM_ORACLE" -snippet ($line.Trim())
      }
    }

    if ($line -match 'res\.(json|send)\s*\(.*err\.(stack|detail|where|schema|table|column)' -and $line -notmatch 'NODE_ENV') {
      Add-Violation -level "FAIL" -file $fname -lineNo $lineNo -rule "21_RAW_SQL_OR_STACK_LEAK" -snippet ($line.Trim())
    }
  }

  if ($raw -notmatch 'requireFirmUser|requireAuth|requireAnyFirmRole|authorize\(' -and $fname -notin @("audit.ts")) {
    Add-Violation -level "WARN" -file $fname -lineNo 0 -rule "11A_UNHANDLED_UNAUTH" -snippet "File-level: no requireFirmUser/requireAuth/authorize middleware attach detected. Manual audit required."
  }

  $writeMethods = [regex]::Matches($raw, 'app\.(post|patch|put|delete)\s*\(').Count
  $firmIdWhereMatches = [regex]::Matches($raw, 'firm_?[Ii]d\s*[=:]\s*req\.(firm|auth|user)[^a-zA-Z]|firm_?[Ii]d\s*[=:]\s*currentFirm|eq\(.*firm_?[Ii]d\s*,\s*req\.').Count
  if ($writeMethods -gt 0 -and $firmIdWhereMatches -lt [Math]::Max(1,[Math]::Floor($writeMethods/2))) {
    Add-Violation -level "WARN" -file $fname -lineNo 0 -rule "11CD_SCOPED_WHERE_MISSING" -snippet ("Writes=$writeMethods, explicit firm_id=req.* matches=$firmIdWhereMatches - manual audit confirm DB-level scoped WHERE")
  }
}

$fails  = @($VIOLATIONS | Where-Object { $_.Level -eq "FAIL" }).Count
$warns  = @($VIOLATIONS | Where-Object { $_.Level -eq "WARN" }).Count
Write-Host ""
Write-Host "Scanned route files: $scannedFiles / $($ACCOUNTING_ROUTE_FILES.Count) accounting coverage"
Write-Host ("FAIL violations: {0}" -f $fails)
Write-Host ("WARN violations: {0}" -f $warns)
if ($fails -eq 0) { Write-Host "RESULT: PASS (0 FAIL-level SEC.11 static violations)." } else { Write-Host "RESULT: FAIL - nonzero FAIL-level violations." }
Write-Host ("-"*90)
if ($VIOLATIONS.Count) {
  $VIOLATIONS | Format-Table Level,File,Line,Rule,Snippet -AutoSize -Wrap | Out-Host
}

if ($WriteReports) {
  $outDir = Join-Path $PSScriptRoot "../../docs"
  if (-not (Test-Path $outDir)) { $null = New-Item -ItemType Directory -Force $outDir }
  $outPath = Join-Path $outDir "generated-accounting-sweep-report.json"
  $VIOLATIONS | ConvertTo-Json -Depth 5 | Set-Content $outPath -Encoding UTF8
  Write-Host "Wrote JSON report: $outPath"
}

exit [Math]::Min(255,$fails)
