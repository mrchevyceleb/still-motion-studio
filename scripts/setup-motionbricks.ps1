param(
    [string]$DataRoot = '',
    [string]$ModelSource = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
if (-not $DataRoot) { $DataRoot = if ($env:STILL_DATA_ROOT) { $env:STILL_DATA_ROOT } else { $taskRoot } }
$taskData = [IO.Path]::GetFullPath($DataRoot)
$taskEnvironment = Join-Path $taskData '.local/motionbricks/.venv'
$taskPython = Join-Path $taskEnvironment 'Scripts/python.exe'
Get-Command uv -ErrorAction Stop | Out-Null
if (-not (Test-Path -LiteralPath $taskPython)) {
    & uv venv --python 3.10 $taskEnvironment
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the MotionBricks environment.' }
}
& uv pip install --python $taskPython numpy==1.26.4 scipy==1.15.3 onnxruntime==1.23.2
if ($LASTEXITCODE -ne 0) { throw 'Could not install the human motion dependencies.' }
$taskArguments = @((Join-Path $PSScriptRoot 'setup_motionbricks.py'), '--data-root', $taskData)
if ($ModelSource) { $taskArguments += @('--model-source', [IO.Path]::GetFullPath($ModelSource)) }
& $taskPython @taskArguments
if ($LASTEXITCODE -ne 0) { throw 'MotionBricks setup did not finish. Your existing engines were kept.' }
