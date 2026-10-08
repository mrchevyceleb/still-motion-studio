$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskBase = Join-Path $taskRoot '.local/owned-motion'
$taskPython = Join-Path $taskBase '.venv/Scripts/python.exe'
Get-Command uv -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Force -Path $taskBase | Out-Null
if (-not (Test-Path -LiteralPath $taskPython)) {
    & uv venv --python 3.10 (Join-Path $taskBase '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the owned-motion Python environment.' }
}
& uv pip install --python $taskPython torch==2.5.1 --index-url https://download.pytorch.org/whl/cu124
if ($LASTEXITCODE -ne 0) { throw 'Could not install the CUDA inference runtime.' }
& uv pip install --python $taskPython numpy==1.26.4 scipy==1.15.3 safetensors==0.8.0 gdown==6.4.1
if ($LASTEXITCODE -ne 0) { throw 'Could not install motion data dependencies.' }
& $taskPython -c 'import torch; assert torch.cuda.is_available(), "An available NVIDIA CUDA GPU is required."'
if ($LASTEXITCODE -ne 0) { throw 'CUDA validation failed.' }
Write-Output $taskPython
