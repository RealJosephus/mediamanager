$ErrorActionPreference = 'Stop'
$sqliteOutput = Join-Path $env:RUNNER_TEMP 'mediamanager-current-sqlite'
New-Item -ItemType Directory -Path $sqliteOutput | Out-Null
$sqliteRoot = Join-Path $sqliteOutput 'input'
$env:MEDIAMANAGER_VALIDATION_OUTPUT_ROOT = $sqliteOutput
node tools/compat/prepare-current-sqlite.mjs $sqliteRoot
if ($LASTEXITCODE -ne 0) { throw 'Current native SQLite supply failed.' }
"MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE=$(Join-Path $sqliteRoot 'input.db')" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
'MEDIAMANAGER_TEST_CURRENT_NATIVE_SQLITE_MOUNT_CONTRACT_JSON={"mounts":[]}' | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
