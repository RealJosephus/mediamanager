$ErrorActionPreference = 'Stop'
$instanceRoot = Join-Path $env:RUNNER_TEMP 'mediamanager-native-instance'
$empty = Join-Path $instanceRoot 'empty'
$seeded = Join-Path $instanceRoot 'seeded'
$env:MEDIAMANAGER_VALIDATION_OUTPUT_ROOT = $instanceRoot
node tools/compat/initialize-reference.mjs $empty
if ($LASTEXITCODE -ne 0) { throw 'Native instance initialization failed.' }
node tools/compat/prepare-media-reference.mjs $empty $seeded
if ($LASTEXITCODE -ne 0) { throw 'Controlled native media seed preparation failed.' }
"MEDIAMANAGER_NATIVE_INSTANCE_ROOT=$instanceRoot" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"MEDIAMANAGER_TEST_NATIVE_INSTANCE=$(Join-Path $seeded 'instance')" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
