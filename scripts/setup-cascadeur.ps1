param([string]$InstallPath = (Join-Path $env:LOCALAPPDATA 'Programs/Cascadeur'))
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskInstall = [IO.Path]::GetFullPath($InstallPath)
foreach ($taskFile in @('cascadeur.exe', 'samples/Cascy.casc')) {
    if (-not (Test-Path -LiteralPath (Join-Path $taskInstall $taskFile))) { throw "Missing installed Cascadeur file: $taskFile. Supply -InstallPath for your licensed installation." }
}
$taskEnvironment = Join-Path $taskRoot '.local/cascadeur/.venv'
$taskPython = Join-Path $taskEnvironment 'Scripts/python.exe'
Get-Command uv -ErrorAction Stop | Out-Null
if (-not (Test-Path -LiteralPath $taskPython)) {
    & uv venv --python 3.12 $taskEnvironment
    if ($LASTEXITCODE -ne 0) { throw 'Could not create native adapter environment.' }
}
& uv pip install --python $taskPython numpy==2.2.6 scipy==1.15.3
if ($LASTEXITCODE -ne 0) { throw 'Could not install native adapter dependencies.' }
foreach ($taskProvider in @('cascadeur', 'cascadeur_physics')) {
    $taskPhysics = $taskProvider -eq 'cascadeur_physics'
    $taskFolder = Join-Path $taskRoot $(if ($taskPhysics) { '.local/cascadeur-physics' } else { '.local/cascadeur-proof' })
    New-Item -ItemType Directory -Force -Path $taskFolder | Out-Null
    $taskLimits = @{ maxDuration = 20; humanoidOnly = $true }
    if ($taskPhysics) { $taskLimits.earthGravityOnly = $true; $taskLimits.requiresFloorContact = $true }
    $taskManifest = @{
        python = $taskPython
        requiredFiles = @((Join-Path $taskInstall 'cascadeur.exe'), (Join-Path $taskInstall 'samples/Cascy.casc'), (Join-Path $taskRoot "backend/$taskProvider.py"), (Join-Path $taskRoot 'backend/cascadeur_runtime.py'))
        config = @{ installPath = $taskInstall; bridgeUrl = 'http://127.0.0.1:8765' }
        limits = $taskLimits
        provider = @{ id = $taskProvider; learned = (-not $taskPhysics); name = $(if ($taskPhysics) { 'Cascadeur AutoPhysics' } else { 'Cascadeur AI' }); description = 'Installed licensed native engine; source skeleton and skin preserved.' }
    }
    $taskPending = Join-Path $taskFolder 'runtime.pending.json'
    [IO.File]::WriteAllText($taskPending, ($taskManifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $taskPending -Destination (Join-Path $taskFolder 'runtime.json') -Force
}
Write-Output 'Registered Cascadeur AI and AutoPhysics. Keep the licensed app and its scripting bridge running on 127.0.0.1:8765.'
