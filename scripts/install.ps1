# Job Scout installer - Windows PowerShell. Run from inside the job-scout folder:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = "Stop"

Write-Host "Installing Job Scout..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Node.js was not found. Installing Node LTS via winget..."
  winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  Write-Host ""
  Write-Host "Node installed. CLOSE and REOPEN this terminal, then run scripts\install.ps1 again."
  exit
}

$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) {
  Write-Host ""
  Write-Host "Found Node $(node -v), but Job Scout needs Node 24 or newer."
  Write-Host "Upgrade with:  winget install OpenJS.NodeJS.LTS"
  exit 1
}

# Put a `job-scout` command on your PATH (no publish needed - links this folder).
Set-Location (Split-Path $PSScriptRoot -Parent)
Write-Host "Installing dependencies..."
npm install --no-audit --no-fund
npm link

Write-Host ""
Write-Host "Job Scout installed."
Write-Host "Next:"
Write-Host "  1. Start it:        job-scout serve     (then open http://127.0.0.1:7777)"
Write-Host "  2. In the app, open 'Setup & Help' to connect your job sources."
Write-Host "  3. (Optional) Daily auto-refresh:       job-scout autostart"
Write-Host ""
Write-Host "Your data stays on your computer. Full guide: GETTING-STARTED.md"
