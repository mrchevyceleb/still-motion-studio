$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskBase = Join-Path $taskRoot '.local/physics-proof'
$taskPython = Join-Path $taskBase '.venv/Scripts/python.exe'
$taskRequirements = Join-Path $taskRoot 'requirements-physics.txt'
$taskBackend = Join-Path $taskRoot 'backend/physics.py'

function Run-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

Get-Command uv -ErrorAction Stop | Out-Null
if (-not (Test-Path -LiteralPath $taskBackend)) { throw "Missing physics backend: $taskBackend" }
New-Item -ItemType Directory -Force -Path $taskBase | Out-Null
if (-not (Test-Path -LiteralPath $taskPython)) {
    Run-Checked uv @('venv', '--python', '3.12', (Join-Path $taskBase '.venv'))
}
Run-Checked uv @('pip', 'install', '--python', $taskPython, '-r', $taskRequirements)

# Check the real solver before publishing readiness. No renderer or GPU is required.
$taskCheck = @'
import importlib.util
import pathlib
import sys
import mujoco
import numpy
import scipy
assert sys.version_info[:2] == (3, 12), "Physics requires Python 3.12; recreate only this local virtual environment."
spec = importlib.util.spec_from_file_location("physics_check", pathlib.Path(sys.argv[1]))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert callable(module.correct_motion)
model = mujoco.MjModel.from_xml_string('<mujoco><option gravity="0 -9.81 0"/><worldbody><body pos="0 1 0"><freejoint/><geom type="sphere" size=".1" mass="1"/></body></worldbody></mujoco>')
data = mujoco.MjData(model)
mujoco.mj_inverse(model, data)
assert abs(float(data.qfrc_inverse[1]) - 9.81) < 1e-6
print(f"Verified MuJoCo {mujoco.__version__}, NumPy {numpy.__version__}, SciPy {scipy.__version__}; gravity inverse dynamics passed.")
'@
$taskCheck | & $taskPython - $taskBackend
if ($LASTEXITCODE -ne 0) { throw "Physics runtime verification failed with exit code $LASTEXITCODE" }

$taskRuntime = [ordered]@{
    python = $taskPython
    requiredFiles = @($taskBackend)
    config = [ordered]@{ maxSeconds = 35; maxIterations = 40; maxSolveFrames = 241 }
    provider = [ordered]@{
        id = 'mujoco'
        name = 'MuJoCo dynamics'
        learned = $false
        description = 'Articulated inverse-dynamics correction with frictional floor contacts, measured residuals, and rejection of regressions. Body inertia and joint cones are approximate.'
    }
}
$taskManifest = Join-Path $taskBase 'runtime.json'
[IO.File]::WriteAllText($taskManifest, ($taskRuntime | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
Write-Host "Physics runtime ready: $taskManifest"
