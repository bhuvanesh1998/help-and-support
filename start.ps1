#Requires -Version 5.1
# HOW TO RUN
# ----------
# Option A - double-click:       start.bat
# Option B — PowerShell terminal: powershell -ExecutionPolicy Bypass -File start.ps1
# Option C — from this file:      Right-click → Run with PowerShell

<#
.SYNOPSIS
  Starts the In-App Help Assistant (backend + frontend) in separate terminals.
.DESCRIPTION
  - Installs npm dependencies if node_modules is missing.
  - Runs `npm run dev`  in ./backend  on  http://localhost:3000
  - Runs `npm start`    in ./frontend on  http://localhost:4200
#>

$Root     = $PSScriptRoot
$Backend  = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"

function Ensure-Deps($dir) {
  $nm = Join-Path $dir "node_modules"
  if (-not (Test-Path $nm)) {
    Write-Host "  Installing dependencies in $dir ..." -ForegroundColor Yellow
    Push-Location $dir
    npm install
    Pop-Location
  }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  In-App Help Assistant - Dev Start" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Dependency checks ────────────────────────────────────────────────────────
Write-Host "[1/2] Checking dependencies..." -ForegroundColor White
Ensure-Deps $Backend
Ensure-Deps $Frontend
Write-Host "  Dependencies OK." -ForegroundColor Green
Write-Host ""

# ── Backend ──────────────────────────────────────────────────────────────────
Write-Host "[2/2] Starting servers..." -ForegroundColor White
Write-Host "  Backend  -> http://localhost:3000  (new window)" -ForegroundColor DarkCyan
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$Backend'; `$host.UI.RawUI.WindowTitle = 'Help Assistant - Backend'; npm run dev"
)

# ── Frontend ─────────────────────────────────────────────────────────────────
Write-Host "  Frontend -> http://localhost:4200  (new window)" -ForegroundColor DarkCyan
Start-Process powershell -ArgumentList @(
  "-NoExit",
  "-Command",
  "Set-Location '$Frontend'; `$host.UI.RawUI.WindowTitle = 'Help Assistant - Frontend'; npm start"
)

Write-Host ""
Write-Host "Both servers are starting." -ForegroundColor Green
Write-Host ""
Write-Host "  API health : http://localhost:3000/api/health" -ForegroundColor Gray
Write-Host "  Admin UI   : http://localhost:4200/admin/login" -ForegroundColor Gray
Write-Host ""
Write-Host "Close the two terminal windows to stop the servers." -ForegroundColor DarkGray
Write-Host ""
