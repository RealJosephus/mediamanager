$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This creates new reference outputs only. No tests, server or oracle are run.
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Native builds must run in GitHub Actions.' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundle = Join-Path $repository 'tests/fixtures/recorded-native'
$output = Join-Path $env:RUNNER_TEMP 'mediamanager-native-build'
if (Test-Path -LiteralPath $output) { throw 'Native build output must be a new isolated directory.' }
$receipts = Join-Path $output 'receipts'
$sourceRoot = Join-Path $output 'source'
$packages = Join-Path $output 'nuget-packages'
$runtime = Join-Path $output 'runtime'
[IO.Directory]::CreateDirectory($receipts) | Out-Null
$env:DOTNET_CLI_HOME = Join-Path $output 'dotnet-home'
$env:NUGET_PACKAGES = $packages
$env:NUGET_HTTP_CACHE_PATH = Join-Path $output 'nuget-http-cache'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$commands = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{
    schemaVersion = 1; status = 'started'; started = [DateTimeOffset]::UtcNow.ToString('o')
    repository = $env:GITHUB_REPOSITORY; commit = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    os = [Runtime.InteropServices.RuntimeInformation]::OSDescription
    architecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    sdkExpected = '10.0.401'; testsExecuted = $false; oracleRecordingsProduced = $false
    historicalBinaryReplacement = $false; commands = $commands
    scope = 'New platform-specific build from the sealed source offer. Output hashes do not replace any historical recording pins.'
}
function Digest([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function Describe([string]$Filename, [string]$Relative) {
    $file = Get-Item -LiteralPath $Filename -Force
    if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $file.PSIsContainer) { throw ('Expected ordinary file: ' + $Relative) }
    [ordered]@{ path = $Relative; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $Filename -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Write-Record([string]$Name, $Value) {
    $filename = Join-Path $receipts $Name
    [IO.File]::WriteAllText($filename, ($Value | ConvertTo-Json -Depth 20) + "`n")
    Describe $filename $Name
}
function Invoke-Dotnet([string]$Name, [string[]]$NativeArguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command dotnet -CommandType Application | Select-Object -First 1).Source
    $start.WorkingDirectory = $sourceRoot
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in $NativeArguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $command = [ordered]@{ executable = $start.FileName; arguments = $NativeArguments; cwd = $sourceRoot; started = [DateTimeOffset]::UtcNow.ToString('o') }
    $commands.Add($command)
    try {
        if (-not $process.Start()) { throw 'Could not launch dotnet.' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        [IO.File]::WriteAllText((Join-Path $receipts ($Name + '.stdout.txt')), $stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText((Join-Path $receipts ($Name + '.stderr.txt')), $stderr.GetAwaiter().GetResult())
        $command.exitCode = $process.ExitCode
        $command.stdout = Describe (Join-Path $receipts ($Name + '.stdout.txt')) ($Name + '.stdout.txt')
        $command.stderr = Describe (Join-Path $receipts ($Name + '.stderr.txt')) ($Name + '.stderr.txt')
        if ($process.ExitCode -ne 0) { throw ('dotnet ' + $Name + ' failed with exit code ' + $process.ExitCode) }
    } finally { $command.finished = [DateTimeOffset]::UtcNow.ToString('o'); $process.Dispose() }
}
function Source-Snapshot {
    $rows = foreach ($entry in $manifest.files) {
        $cursor = $sourceRoot
        foreach ($part in $entry.path.Split('/')) {
            $cursor = Join-Path $cursor $part
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Source path traverses a link.' }
        }
        $row = Describe $cursor $entry.path
        $row.matches = $row.bytes -eq $entry.size -and $row.sha256 -eq $entry.sha256
        $row
    }
    [ordered]@{ files = @($rows); allMatched = @($rows | Where-Object { -not $_.matches }).Count -eq 0 }
}
$failure = $null; $sourceVerified = $false
try {
    $packageFile = Join-Path $bundle 'jellyfin-source-package.json'
    $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
    $archivePath = Join-Path $bundle 'jellyfin-source-208c278b75ab.zip'
    $manifestPath = Join-Path $bundle 'jellyfin-source-manifest.json'
    $archiveIdentity = Describe $archivePath 'jellyfin-source-208c278b75ab.zip'
    $manifestIdentity = Describe $manifestPath 'jellyfin-source-manifest.json'
    if ($archiveIdentity.sha256 -ne '92edc03192499dcdd98439072a6ece32ab839bb1f5bb0c9abbda03284ec9f161' -or
        $manifestIdentity.sha256 -ne '2012abc83017dfd2a107a49b701531a0dad08c763bc721dc75726342002c8f5c' -or
        $archiveIdentity.sha256 -ne $package.archive.sha256 -or $manifestIdentity.sha256 -ne $package.sourceManifest.sha256 -or
        $archiveIdentity.bytes -ne $package.archive.bytes -or $manifestIdentity.bytes -ne $package.sourceManifest.bytes) { throw 'Source package identity mismatch.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.files.Count -ne 2620 -or $manifest.files.Count -ne $package.sourceFiles) { throw 'Source manifest must contain all 2620 files.' }
    $receipt.source = @{ archive = $archiveIdentity; manifest = $manifestIdentity; head = $manifest.head; contentDigest = $manifest.contentDigest; files = $manifest.files.Count }
    $expected = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    foreach ($entry in $manifest.files) {
        if ($entry.path -match '(^|/)(\.|\.\.)(/|$)|[:\\\r\n\x00]|^/|//$' -or $entry.path.Contains('//') -or
            $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.size -lt 0) { throw 'Invalid source manifest member.' }
        $expected.Add('jellyfin-source/' + $entry.path, $entry)
    }
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        if ($archive.Entries.Count -ne $expected.Count) { throw 'Source archive membership mismatch.' }
        foreach ($entry in $archive.Entries) {
            if (-not $expected.ContainsKey($entry.FullName)) { throw 'Unexpected or duplicate source archive member.' }
            $pinned = $expected[$entry.FullName]
            $inputStream = $entry.Open(); $memory = [IO.MemoryStream]::new()
            try { $inputStream.CopyTo($memory); $bytes = $memory.ToArray() } finally { $inputStream.Dispose(); $memory.Dispose() }
            if ($bytes.Length -ne $pinned.size -or (Digest $bytes) -ne $pinned.sha256) { throw ('Source member bytes changed: ' + $pinned.path) }
            $filename = Join-Path $sourceRoot $pinned.path
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($filename)) | Out-Null
            [IO.File]::WriteAllBytes($filename, $bytes)
            $expected.Remove($entry.FullName) | Out-Null
        }
    } finally { $archive.Dispose() }
    if ($expected.Count -ne 0) { throw 'Source archive omitted a manifest member.' }
    $before = Source-Snapshot
    $receipt.sourceBefore = Write-Record 'source-before.json' $before
    if (-not $before.allMatched) { throw 'Extracted source does not match its manifest.' }
    $sourceVerified = $true
    $offer = Join-Path $output 'source-offer'; [IO.Directory]::CreateDirectory($offer) | Out-Null
    foreach ($name in @($archiveIdentity.path, $manifestIdentity.path, 'jellyfin-local-modifications.json', 'LICENSE-Jellyfin.txt')) {
        Copy-Item -LiteralPath (Join-Path $bundle $name) -Destination (Join-Path $offer $name)
    }
    $receipt.sourceOffer = @(Get-ChildItem -LiteralPath $offer -File | Sort-Object Name | ForEach-Object { Describe $_.FullName $_.Name })
    if (($receipt.sourceOffer | Where-Object path -eq 'jellyfin-local-modifications.json').sha256 -ne $package.localModifications.sha256 -or
        ($receipt.sourceOffer | Where-Object path -eq 'LICENSE-Jellyfin.txt').sha256 -ne ($manifest.files | Where-Object path -eq 'LICENSE').sha256) { throw 'Source offer attachments changed.' }
    Invoke-Dotnet 'sdk-version' @('--version')
    $receipt.sdkActual = (Get-Content -LiteralPath (Join-Path $receipts 'sdk-version.stdout.txt') -Raw).Trim()
    if ($receipt.sdkActual -ne $receipt.sdkExpected) { throw 'The selected SDK does not match the pinned version.' }
    Invoke-Dotnet 'sdk-info' @('--info')
    Invoke-Dotnet 'build' @('build', 'Jellyfin.Server/Jellyfin.Server.csproj', '--configuration', 'Release', '--framework', 'net10.0', '--nologo', '--verbosity', 'minimal')
    $built = Join-Path $sourceRoot 'Jellyfin.Server/bin/Release/net10.0'
    if (-not (Test-Path -LiteralPath (Join-Path $built 'jellyfin.dll') -PathType Leaf)) { throw 'Build did not produce the reference runtime.' }
    [IO.Directory]::CreateDirectory($runtime) | Out-Null
    Get-ChildItem -LiteralPath $built -Force | Copy-Item -Destination $runtime -Recurse
    $runtimeRows = @(Get-ChildItem -LiteralPath $runtime -Recurse -File -Force | ForEach-Object {
        Describe $_.FullName ([IO.Path]::GetRelativePath($runtime, $_.FullName).Replace('\', '/'))
    } | Sort-Object { $_.path })
    $receipt.runtimeManifest = Write-Record 'runtime-manifest.json' @{ files = $runtimeRows }
    $receipt.status = 'succeeded'
} catch { $failure = $_; $receipt.status = 'failed'; $receipt.error = $_.Exception.Message }
finally {
    try {
        if ($sourceVerified) {
            $after = Source-Snapshot
            $receipt.sourceAfter = Write-Record 'source-after.json' $after
            $receipt.sourceUnchanged = $after.allMatched -and $receipt.sourceBefore.sha256 -eq $receipt.sourceAfter.sha256
            if (-not $receipt.sourceUnchanged) { throw 'Build changed the sealed source files.' }
        }
    } catch { if (-not $failure) { $failure = $_ }; $receipt.status = 'failed'; $receipt.sourceAuditError = $_.Exception.Message }
    try {
        $packageRows = @(Get-ChildItem -LiteralPath $packages -Filter '*.nupkg' -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
            Describe $_.FullName ([IO.Path]::GetRelativePath($packages, $_.FullName).Replace('\', '/'))
        } | Sort-Object { $_.path })
        $receipt.nugetManifest = Write-Record 'nuget-manifest.json' @{ networkRestoreAllowed = $true; isolatedPackagesDirectory = $packages; packages = $packageRows }
        if ($receipt.status -eq 'succeeded' -and $packageRows.Count -eq 0) { throw 'Successful build did not capture any NuGet packages.' }
    } catch { if (-not $failure) { $failure = $_ }; $receipt.status = 'failed'; $receipt.nugetAuditError = $_.Exception.Message }
    $receipt.finished = [DateTimeOffset]::UtcNow.ToString('o')
    Write-Record 'build-receipt.json' $receipt | Out-Null
}
if ($failure) { throw $failure }
Write-Host ('Native reference runtime and receipts: ' + $output)
