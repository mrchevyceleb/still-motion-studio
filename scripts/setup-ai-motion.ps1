$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskBase = Join-Path $taskRoot '.local/ai-motion'
$taskPython = Join-Path $taskBase '.venv/Scripts/python.exe'
$taskSource = Join-Path $taskBase 'molab'
$taskRevision = '669cb9ceec87dcdb9beae81e4aefd8ba63295a6e'

function Run-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

Get-Command uv, git -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Force -Path $taskBase | Out-Null
if (-not (Test-Path -LiteralPath $taskPython)) {
    Run-Checked uv @('venv', '--python', '3.10', (Join-Path $taskBase '.venv'))
}
if (-not (Test-Path -LiteralPath (Join-Path $taskSource '.git'))) {
    Run-Checked git @('clone', '--depth', '1', 'https://github.com/JasonNero/MoLab.git', $taskSource)
}
$taskDirty = & git -C $taskSource status --porcelain
if ($taskDirty) { throw 'The local MoLab checkout has edits. Preserve them before rerunning setup.' }
Run-Checked git @('-C', $taskSource, 'fetch', '--depth', '1', 'origin', $taskRevision)
Run-Checked git @('-C', $taskSource, 'checkout', '--detach', $taskRevision)

Run-Checked uv @('pip', 'install', '--python', $taskPython, 'torch==2.5.1', 'torchvision==0.20.1', '--index-url', 'https://download.pytorch.org/whl/cu124')
Run-Checked uv @('pip', 'install', '--python', $taskPython, 'numpy==1.26.4', 'scipy==1.15.3', 'einops==0.8.2', 'safetensors==0.8.0', 'gdown==6.4.1', 'ftfy==6.3.1', 'regex==2026.9.29', 'tqdm==4.70.1', 'setuptools==80.10.2')
Run-Checked uv @('pip', 'install', '--python', $taskPython, '--no-deps', 'git+https://github.com/openai/CLIP.git@d05afc436d78f1c48dc0dbf8e5980a9d471f35f6')
Run-Checked $taskPython @((Join-Path $taskRoot 'backend/install_model.py'))
