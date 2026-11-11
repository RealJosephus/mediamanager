param([Parameter(Mandatory)][ValidateSet('start', 'stop')][string]$Mode)

$ErrorActionPreference = 'Stop'
if ((!$IsWindows -and !$IsMacOS) -or $env:GITHUB_ACTIONS -ne 'true') { throw 'The lifecycle database is reserved for Windows and macOS Actions jobs.' }
$root = Join-Path $env:RUNNER_TEMP 'mediamanager-lifecycle-postgres'
$data = Join-Path $root 'data'
$pidFile = Join-Path $data 'postmaster.pid'
$port = 55432
$evidence = $env:MEDIAMANAGER_VALIDATION_OUTPUT_ROOT
$initialFile = Join-Path $evidence 'lifecycle-postgres-before.json'
$binaryDirectory = $env:PGBIN
$executableExtension = if ($IsWindows) { '.exe' } else { '' }
$pathComparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
if ($IsMacOS) {
    $prefix = & brew --prefix postgresql@17
    if ($LASTEXITCODE -ne 0) { throw 'Cannot locate the provisioned PostgreSQL 17 installation.' }
    $binaryDirectory = Join-Path $prefix.Trim() 'bin'
}
$postgres = Join-Path $binaryDirectory ('postgres' + $executableExtension)
$env:PGCONNECT_TIMEOUT = '5'
$env:PGOPTIONS = '-c statement_timeout=5000'

function Invoke-PostgresTool([string]$Executable, [string[]]$ToolArguments) {
    & (Join-Path $binaryDirectory ($Executable + $executableExtension)) @ToolArguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with status $LASTEXITCODE." }
}

function Read-Postmaster {
    $record = @(Get-Content -LiteralPath $pidFile)
    if ($record.Count -lt 4 -or $record[0] -notmatch '^[1-9][0-9]*$' -or [int]$record[3] -ne $port `
        -or ![String]::Equals([IO.Path]::GetFullPath($record[1]), $data, $pathComparison)) { throw 'The lifecycle postmaster receipt differs from its owned directory or port.' }
    $processId = [int]$record[0]
    if ($IsWindows) {
        $server = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId"
        $commandLine = ([string]$server.CommandLine).Replace('/', '\')
        if ($server.ExecutablePath -ine $postgres -or !$commandLine.Contains('"' + $data + '"', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The live process does not own the lifecycle PostgreSQL directory.'
        }
        return [ordered]@{ id = $processId; startedAt = $server.CreationDate.ToUniversalTime().ToString('o') }
    }
    $server = Get-Process -Id $processId -ErrorAction Stop
    try {
        if ($server.ProcessName -cne 'postgres') { throw 'The lifecycle postmaster is not PostgreSQL.' }
        [ordered]@{ id = $processId; startedAt = $server.StartTime.ToUniversalTime().ToString('o') }
    } finally {
        $server.Dispose()
    }
}

function Read-Cluster {
    $sql = @'
SELECT json_build_object(
  'dataDirectory', current_setting('data_directory'), 'port', inet_server_port(),
  'address', host(inet_server_addr()), 'startedAt', pg_postmaster_start_time(),
  'systemIdentifier', (pg_control_system()).system_identifier::text,
  'version', current_setting('server_version_num')::integer,
  'fsync', current_setting('fsync'), 'synchronousCommit', current_setting('synchronous_commit'),
  'fullPageWrites', current_setting('full_page_writes'),
  'databases', (SELECT json_agg(datname ORDER BY datname) FROM pg_database),
  'roles', (SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles),
  'schemas', (SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace),
  'connections', (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid())
)
'@
    $row = Invoke-PostgresTool 'psql' @('-X', '-w', '-A', '-t', '-h', '127.0.0.1', '-p', "$port",
        '-U', 'validation', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', $sql) | ConvertFrom-Json -DateKind String
    if (![String]::Equals([IO.Path]::GetFullPath($row.dataDirectory), $data, $pathComparison) -or $row.port -ne $port -or $row.address -ne '127.0.0.1' `
        -or [Math]::Floor($row.version / 10000) -ne 17 -or $row.fsync -ne 'on' -or $row.synchronousCommit -ne 'on' `
        -or $row.fullPageWrites -ne 'on') { throw 'The lifecycle PostgreSQL endpoint is not the owned durable cluster.' }
    $row
}

function New-Receipt {
    [ordered]@{ candidate = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; job = $env:GITHUB_JOB }
}

if ($Mode -eq 'start') {
    New-Item -ItemType Directory -Path $root | Out-Null
    'owned=true' | Out-File -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8 -Append
    New-Item -ItemType Directory -Path $evidence -Force | Out-Null
    # This server has no external listeners and keeps the normal durability
    # settings. CREATE and DROP still run against the live PostgreSQL server.
    Invoke-PostgresTool 'initdb' @('-D', $data, '--username=validation', '--auth=trust', '--locale=C', '--encoding=UTF8')
    $log = Join-Path $evidence 'lifecycle-postgres.log'
    Invoke-PostgresTool 'pg_ctl' @('-D', $data, '-l', $log, '-o', "-h 127.0.0.1 -p $port", '-w', 'start')
    $receipt = New-Receipt
    $receipt.postmaster = Read-Postmaster
    $receipt.cluster = Read-Cluster
    if ($receipt.cluster.connections -ne 0) { throw 'The new lifecycle cluster has unexpected client connections.' }
    $receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $initialFile -Encoding utf8
    "MEDIAMANAGER_TEST_LIFECYCLE_POSTGRES=postgresql://validation@127.0.0.1:$port/postgres" `
        | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append
    exit
}

$receipt = New-Receipt
$receipt.stopped = $false
$failures = [Collections.Generic.List[string]]::new()
$before = $null
try {
    if (Test-Path -LiteralPath $initialFile -PathType Leaf) {
        $before = Get-Content -Raw -LiteralPath $initialFile | ConvertFrom-Json -DateKind String
    }
    if (!$before -or $before.candidate -cne $receipt.candidate -or $before.runId -ne $receipt.runId `
        -or $before.attempt -ne $receipt.attempt -or $before.job -ne $receipt.job) { throw 'The lifecycle cluster has no matching start receipt.' }
    $receipt.cluster = Read-Cluster
    if (($receipt.cluster | ConvertTo-Json -Depth 8 -Compress) -cne ($before.cluster | ConvertTo-Json -Depth 8 -Compress)) {
        throw 'The lifecycle cluster or its database resources changed during validation.'
    }
} catch { $failures.Add($_.Exception.Message) }
try {
    if (Test-Path -LiteralPath $pidFile -PathType Leaf) {
        $postmaster = Read-Postmaster
        $receipt.postmaster = $postmaster
        if ($before -and ($postmaster.id -ne $before.postmaster.id -or $postmaster.startedAt -ne $before.postmaster.startedAt)) {
            throw 'The lifecycle postmaster changed process identity.'
        }
        Invoke-PostgresTool 'pg_ctl' @('-D', $data, '-m', 'fast', '-w', 'stop')
        $sameProcessRemains = $false
        if ($IsWindows) {
            $remaining = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($postmaster.id)"
            $sameProcessRemains = $remaining -and $remaining.CreationDate.ToUniversalTime().ToString('o') -eq $postmaster.startedAt
        } else {
            $remaining = Get-Process -Id $postmaster.id -ErrorAction SilentlyContinue
            if ($remaining) {
                try { $sameProcessRemains = $remaining.StartTime.ToUniversalTime().ToString('o') -eq $postmaster.startedAt }
                finally { $remaining.Dispose() }
            }
        }
        if ((Test-Path -LiteralPath $pidFile) -or $sameProcessRemains) {
            throw 'The lifecycle postmaster remains after its stop command.'
        }
        $receipt.stopped = $true
    } elseif ($before) { throw 'The lifecycle postmaster exited before cleanup.' }
} catch { $failures.Add($_.Exception.Message) }
$receipt.errors = @($failures)
$receipt.clean = $receipt.stopped -and $failures.Count -eq 0
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'lifecycle-postgres-after.json') -Encoding utf8
if (!$receipt.clean) { throw ('Lifecycle PostgreSQL cleanup failed. ' + ($failures -join ' ')) }
