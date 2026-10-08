param([switch]$Retrain)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPython = & (Join-Path $PSScriptRoot 'setup-owned-runtime.ps1') | Select-Object -Last 1
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'The motion runtime did not return a Python interpreter.' }
$taskModel = Join-Path $taskRoot '.local/owned-humanoid/runtime.json'
if ($Retrain -or -not (Test-Path -LiteralPath $taskModel)) {
    # The actual app importer supplies normalized source transforms for this proof.
    try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5173' -TimeoutSec 3 | Out-Null }
    catch { throw 'Start Still with npm run dev before preparing the humanoid training corpus.' }
    & $taskPython (Join-Path $taskRoot 'training/fetch_humanoid_cc0.py')
    if ($LASTEXITCODE -ne 0) { throw 'The author CC0 animation download failed.' }
    Push-Location $taskRoot
    try {
        & node (Join-Path $taskRoot 'training/extract_humanoid.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Animation extraction failed. Install Playwright Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.' }
    } finally { Pop-Location }
    & $taskPython (Join-Path $taskRoot 'training/prepare_humanoid_features.py')
    if ($LASTEXITCODE -ne 0) { throw 'Humanoid feature preparation failed.' }
    $taskTraining = & $taskPython (Join-Path $taskRoot 'training/train_motion_prior.py') --data (Join-Path $taskRoot '.local/owned-humanoid/dataset') --output (Join-Path $taskRoot '.local/owned-humanoid/candidates') --steps 8000 --objective regression --family curvature
    $taskTraining | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'Fresh humanoid training failed.' }
    $taskCandidate = ($taskTraining | Select-Object -Last 1 | ConvertFrom-Json).candidate
    if (-not $taskCandidate) { throw 'Training did not produce a complete candidate.' }
    & $taskPython (Join-Path $taskRoot 'training/register_humanoid.py') --candidate $taskCandidate
    if ($LASTEXITCODE -ne 0) { throw 'Candidate rejected; the previously installed runtime is unchanged.' }
} else {
    Write-Host 'Verified local runtime already installed. Use -Retrain to build a separate candidate.'
}
