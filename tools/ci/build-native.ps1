$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This creates new reference outputs only. No tests, server or oracle are run.
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Native builds must run in GitHub Actions.' }
if (-not $env:MEDIAMANAGER_DOTNET -or -not $env:MEDIAMANAGER_CI_DOTNET_ROOT) { throw 'Verify the isolated .NET installation before building the native reference.' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundle = Join-Path $repository 'tests/fixtures/recorded-native'
$output = Join-Path $env:RUNNER_TEMP 'mediamanager-native-build'
if (Test-Path -LiteralPath $output) { throw 'Native build output must be a new isolated directory.' }
$receipts = Join-Path $output 'receipts'
$sourceRoot = Join-Path $output 'source'
$packages = Join-Path $output 'nuget-packages'
$nugetConfig = Join-Path $sourceRoot 'nuget.config'
$runtime = Join-Path $output 'runtime'
[IO.Directory]::CreateDirectory($receipts) | Out-Null
$env:DOTNET_CLI_HOME = Join-Path $output 'dotnet-home'
$env:NUGET_PACKAGES = $packages
$env:NUGET_HTTP_CACHE_PATH = Join-Path $output 'nuget-http-cache'
Remove-Item Env:NUGET_FALLBACK_PACKAGES -ErrorAction SilentlyContinue
if (Test-Path Env:NUGET_FALLBACK_PACKAGES) { throw 'NuGet fallback package environment must be absent.' }
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$identityVariables = @('GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_EVENT_NAME',
    'GITHUB_WORKFLOW', 'GITHUB_WORKFLOW_REF', 'GITHUB_WORKFLOW_SHA', 'GITHUB_JOB', 'GITHUB_REF', 'RUNNER_OS', 'RUNNER_ARCH',
    'MEDIAMANAGER_CI_MATRIX_OS', 'MEDIAMANAGER_CI_SHARD', 'MEDIAMANAGER_CI_SHARDS', 'MEDIAMANAGER_CHECKOUT_HEAD', 'MEDIAMANAGER_CHECKOUT_TREE')
foreach ($name in $identityVariables) {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw ('Native build identity is missing ' + $name + '.') }
}
function Git-Revision([string]$Revision) {
    $value = @(& git -C $repository rev-parse --verify $Revision 2>$null)
    if ($LASTEXITCODE -ne 0 -or $value.Count -ne 1) { throw ('Cannot resolve native build checkout revision: ' + $Revision) }
    $value[0].Trim()
}
$checkoutHead = Git-Revision 'HEAD'
$checkoutTree = Git-Revision 'HEAD^{tree}'
if ($checkoutHead -cne $env:GITHUB_SHA -or $checkoutHead -cne $env:MEDIAMANAGER_CHECKOUT_HEAD -or
    $checkoutTree -cne $env:MEDIAMANAGER_CHECKOUT_TREE) { throw 'Native build checkout identity differs from the workflow candidate.' }
$commands = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{
    schemaVersion = 2; status = 'started'; started = [DateTimeOffset]::UtcNow.ToString('o')
    repository = $env:GITHUB_REPOSITORY; commit = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    producer = [ordered]@{ eventName = $env:GITHUB_EVENT_NAME; workflow = $env:GITHUB_WORKFLOW; workflowRef = $env:GITHUB_WORKFLOW_REF
        workflowSha = $env:GITHUB_WORKFLOW_SHA; job = $env:GITHUB_JOB; ref = $env:GITHUB_REF }
    runner = [ordered]@{ os = $env:RUNNER_OS; architecture = $env:RUNNER_ARCH; matrixOs = $env:MEDIAMANAGER_CI_MATRIX_OS
        shard = $env:MEDIAMANAGER_CI_SHARD; shards = $env:MEDIAMANAGER_CI_SHARDS }
    checkout = [ordered]@{ head = $checkoutHead; tree = $checkoutTree }
    sdkExpected = '10.0.401'; testsExecuted = $false; oracleRecordingsProduced = $false
    historicalBinaryReplacement = $false; commands = $commands
    scope = 'New platform-specific build from the sealed source offer. Output hashes do not replace any historical recording pins.'
    evidenceScope = [ordered]@{ sameRunByteVerification = $true; offlineReplaySelfContained = $false
        omittedOfflinePayloads = @('dotnet-sdk-tree', 'nuget-packages-tree')
        statement = 'SDK and NuGet manifests are verified against live same-run roots; manifests without those omitted byte trees are not an offline replay supply.' }
    restoreIsolation = [ordered]@{ packagesRoot = [IO.Path]::GetFullPath($packages); config = $null
        fallbackEnvironmentAbsent = $true; restoreFallbackFolders = ''; restoreAdditionalProjectFallbackFolders = '' }
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
function Tree-Snapshot([string]$Root, [string]$Kind) {
    $absolute = [IO.Path]::GetFullPath($Root)
    $rootItem = Get-Item -LiteralPath $absolute -Force
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('Native ' + $Kind + ' root must be a physical directory.')
    }
    $rows = [Collections.Generic.List[object]]::new()
    foreach ($item in @(Get-ChildItem -LiteralPath $absolute -Force -Recurse)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Native ' + $Kind + ' tree contains a link.') }
        if ($item.PSIsContainer) { continue }
        if (-not ($item -is [IO.FileInfo])) { throw ('Native ' + $Kind + ' tree contains an unsupported entry.') }
        $relative = [IO.Path]::GetRelativePath($absolute, $item.FullName).Replace('\', '/')
        $rows.Add((Describe $item.FullName $relative))
    }
    [ordered]@{ schemaVersion = 1; root = $absolute; kind = $Kind; scope = 'same-run-byte-identity-only'
        files = @($rows | Sort-Object { $_.path }) }
}
function Same-Tree($Left, $Right) {
    ($Left | ConvertTo-Json -Depth 20 -Compress) -ceq ($Right | ConvertTo-Json -Depth 20 -Compress)
}
function Invoke-Dotnet([string]$Name, [string[]]$NativeArguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $env:MEDIAMANAGER_DOTNET
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
    $sourcePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $manifest.files) {
        if ($entry.path -match '(^|/)(\.|\.\.)(/|$)|[:\\\r\n\x00]|^/|//$' -or $entry.path.Contains('//') -or
            $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.size -lt 0) { throw 'Invalid source manifest member.' }
        $expected.Add('jellyfin-source/' + $entry.path, $entry)
        if (-not $sourcePaths.Add([string]$entry.path)) { throw ('Duplicate source manifest member: ' + $entry.path) }
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
    $receipt.restoreIsolation.config = Describe $nugetConfig 'nuget.config'
    $sourceVerified = $true
    $offer = Join-Path $output 'source-offer'; [IO.Directory]::CreateDirectory($offer) | Out-Null
    foreach ($name in @($archiveIdentity.path, $manifestIdentity.path, 'jellyfin-local-modifications.json', 'LICENSE-Jellyfin.txt')) {
        Copy-Item -LiteralPath (Join-Path $bundle $name) -Destination (Join-Path $offer $name)
    }
    $receipt.sourceOffer = @(Get-ChildItem -LiteralPath $offer -File | Sort-Object Name | ForEach-Object { Describe $_.FullName $_.Name })
    if (($receipt.sourceOffer | Where-Object path -eq 'jellyfin-local-modifications.json').sha256 -ne $package.localModifications.sha256 -or
        ($receipt.sourceOffer | Where-Object path -eq 'LICENSE-Jellyfin.txt').sha256 -ne ($manifest.files | Where-Object path -eq 'LICENSE').sha256) { throw 'Source offer attachments changed.' }
    $sdkBefore = Tree-Snapshot $env:MEDIAMANAGER_CI_DOTNET_ROOT 'dotnet-sdk'
    if ($sdkBefore.files.Count -eq 0) { throw 'The isolated .NET SDK tree is empty.' }
    $receipt.sdkBefore = Write-Record 'sdk-before.json' $sdkBefore
    Invoke-Dotnet 'sdk-version' @('--version')
    $receipt.sdkActual = (Get-Content -LiteralPath (Join-Path $receipts 'sdk-version.stdout.txt') -Raw).Trim()
    if ($receipt.sdkActual -ne $receipt.sdkExpected) { throw 'The selected SDK does not match the pinned version.' }
    Invoke-Dotnet 'sdk-info' @('--info')
    Invoke-Dotnet 'restore' @('restore', 'Jellyfin.Server/Jellyfin.Server.csproj', '--packages', $packages,
        '--configfile', $nugetConfig, '-p:RestoreFallbackFolders=', '-p:RestoreAdditionalProjectFallbackFolders=',
        '--nologo', '--verbosity', 'minimal')
    $nugetBeforeBuild = Tree-Snapshot $packages 'nuget-packages'
    if ($nugetBeforeBuild.files.Count -eq 0) { throw 'Successful restore did not capture the complete NuGet package tree.' }
    $receipt.nugetBeforeBuild = Write-Record 'nuget-before-build.json' $nugetBeforeBuild
    Invoke-Dotnet 'build' @('build', 'Jellyfin.Server/Jellyfin.Server.csproj', '--configuration', 'Release', '--framework', 'net10.0',
        '--no-restore', '--output', $runtime, '--nologo', '--verbosity', 'minimal')
    $nugetAfterBuild = Tree-Snapshot $packages 'nuget-packages'
    $receipt.nugetAfterBuild = Write-Record 'nuget-after-build.json' $nugetAfterBuild
    $receipt.nugetUnchangedDuringBuild = Same-Tree $nugetBeforeBuild $nugetAfterBuild
    if (-not $receipt.nugetUnchangedDuringBuild -or $receipt.nugetBeforeBuild.sha256 -cne $receipt.nugetAfterBuild.sha256 -or
        $receipt.nugetBeforeBuild.bytes -ne $receipt.nugetAfterBuild.bytes) { throw 'The no-restore build changed the restored NuGet package tree.' }
    $sdkAfter = Tree-Snapshot $env:MEDIAMANAGER_CI_DOTNET_ROOT 'dotnet-sdk'
    $receipt.sdkAfter = Write-Record 'sdk-after.json' $sdkAfter
    $receipt.sdkUnchanged = Same-Tree $sdkBefore $sdkAfter
    if (-not $receipt.sdkUnchanged -or $receipt.sdkBefore.sha256 -cne $receipt.sdkAfter.sha256 -or
        $receipt.sdkBefore.bytes -ne $receipt.sdkAfter.bytes) { throw 'Native build commands changed the isolated .NET SDK tree.' }
    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'jellyfin.dll') -PathType Leaf)) { throw 'Build did not produce the reference runtime.' }
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
    $receipt.finished = [DateTimeOffset]::UtcNow.ToString('o')
    Write-Record 'build-receipt.json' $receipt | Out-Null
}
if ($failure) { throw $failure }
Write-Host ('Native reference runtime and receipts: ' + $output)
