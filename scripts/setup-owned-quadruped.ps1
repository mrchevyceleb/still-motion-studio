param([switch]$Retrain)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskPython = & (Join-Path $PSScriptRoot 'setup-owned-runtime.ps1') | Select-Object -Last 1
if (-not (Test-Path -LiteralPath $taskPython)) { throw 'The motion runtime did not return a Python interpreter.' }
$taskModel = Join-Path $taskRoot '.local/quadruped/model/model.safetensors'
if ($Retrain -or -not (Test-Path -LiteralPath $taskModel)) {
    & $taskPython (Join-Path $taskRoot 'training/download_quadruped_data.py')
    if ($LASTEXITCODE -ne 0) { throw 'CC0 animation download failed.' }
    & $taskPython (Join-Path $taskRoot 'training/prepare_quadruped.py')
    if ($LASTEXITCODE -ne 0) { throw 'CC0 animation preparation failed.' }
    & $taskPython (Join-Path $taskRoot 'training/train_motion_prior.py') --data (Join-Path $taskRoot '.local/quadruped/corpus') --output (Join-Path $taskRoot '.local/quadruped/model') --steps 8000
    if ($LASTEXITCODE -ne 0) { throw 'Fresh quadruped model training failed.' }
}
& $taskPython (Join-Path $taskRoot 'training/register_quadruped.py')
if ($LASTEXITCODE -ne 0) { throw 'Quadruped model registration failed.' }
