param(
    [string]$BuildDirectory = 'D:/mediamanager-validation/20261016-native-build-closure'
)
$ErrorActionPreference = 'Stop'
# Source-input preparation only. This script runs no build, oracle or tests.
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundle = Join-Path $repository 'tests/fixtures/recorded-native'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $BuildDirectory 'baseline/source'))
$manifestPath = Join-Path $BuildDirectory 'baseline/manifest.json'
$receiptPath = Join-Path $BuildDirectory 'final-build-receipt.json'
$modificationsPath = Join-Path $BuildDirectory 'designated-localmods-build-binding.json'
$manifestBytes = [IO.File]::ReadAllBytes($manifestPath)
$receiptBytes = [IO.File]::ReadAllBytes($receiptPath)
$modificationBytes = [IO.File]::ReadAllBytes($modificationsPath)
function Digest([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
$manifest = [Text.Encoding]::UTF8.GetString($manifestBytes) | ConvertFrom-Json
$receipt = [Text.Encoding]::UTF8.GetString($receiptBytes) | ConvertFrom-Json
$modifications = [Text.Encoding]::UTF8.GetString($modificationBytes) | ConvertFrom-Json
foreach ($binding in @(
    @{ Bytes = $manifestBytes; Path = $manifestPath },
    @{ Bytes = $modificationBytes; Path = $modificationsPath }
)) {
    $recorded = $receipt.detailedBindings | Where-Object { [IO.Path]::GetFullPath($_.path) -eq [IO.Path]::GetFullPath($binding.Path) }
    if (@($recorded).Count -ne 1 -or (Digest $binding.Bytes) -ne $recorded.sha256 -or $binding.Bytes.Length -ne $recorded.bytes) {
        throw 'Source identity does not match the unchanged final build receipt.'
    }
}
if (-not $receipt.passed -or -not $receipt.fullBuildInputClosure -or $manifest.head -ne $receipt.buildIdentity.head -or
    $manifest.contentDigest -ne $receipt.buildIdentity.contentDigest -or $manifest.files.Count -ne $receipt.copiedSourceFilesVerified) {
    throw 'The source manifest and native build identity do not agree.'
}
$prepared = [Collections.Generic.List[object]]::new()
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$secretMarkers = '(?i)-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bgh[pousr]_[a-z0-9]{32,}\b|\bgithub_pat_[a-z0-9_]{40,}\b|\bAKIA[A-Z0-9]{16}\b|(?:https?|postgres(?:ql)?):\/\/[^\s\/@:]+:[^\s\/@]+@'
$reviewedPlaceholder = 'tests/Jellyfin.Networking.Tests/NetworkParseTests.cs'
foreach ($entry in $manifest.files) {
    if ($entry.path -match '(^|/)(\.git|bin|obj|\.test-input|\.agent-temp)(/|$)' -or
        $entry.path -match '(^|/)(\.env(?:\..*)?|secrets?\.json|credentials?)(/|$)|\.(pfx|pem|key|db|sqlite|sqlite3|dll|exe)$' -or
        $entry.path -match '(^|/)\.\.(/|$)|[:\\\r\n\x00]' -or [IO.Path]::IsPathRooted($entry.path) -or -not $names.Add($entry.path)) {
        throw ('Unexpected or private source path: ' + $entry.path)
    }
    $filename = [IO.Path]::GetFullPath((Join-Path $sourceRoot $entry.path))
    if (-not $filename.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Source path escaped its sealed root.'
    }
    $cursor = $sourceRoot
    foreach ($part in $entry.path.Split('/')) {
        $cursor = Join-Path $cursor $part
        if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Source links are not allowed.' }
    }
    $bytes = [IO.File]::ReadAllBytes($filename)
    if ($bytes.Length -ne $entry.size -or (Digest $bytes) -ne $entry.sha256) { throw ('Sealed source bytes changed: ' + $entry.path) }
    $scanText = [Text.Encoding]::UTF8.GetString($bytes)
    if ($entry.path -eq $reviewedPlaceholder) {
        # Original public test data at an example.com hostname, not a credential.
        $scanText = $scanText.Replace('https://user:password@media.example.com?access_token=secret#fragment', '<reviewed-public-test-placeholder>')
    }
    if ([IO.Path]::GetExtension($entry.path).ToLowerInvariant() -notin @('.png', '.jpg', '.ico', '.zip') -and
        $scanText -match $secretMarkers) {
        throw ('Credential marker requires manual review before packaging: ' + $entry.path)
    }
    $prepared.Add(@{ Path = $entry.path; Bytes = $bytes })
}
foreach ($entry in $modifications.entries) {
    if (-not $names.Contains($entry.path)) { throw ('A designated local modification is absent: ' + $entry.path) }
}
[IO.Directory]::CreateDirectory($bundle) | Out-Null
$archiveName = 'jellyfin-source-' + $manifest.head.Substring(0, 12) + '.zip'
$archivePath = Join-Path $bundle $archiveName
$output = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
    $archive = [IO.Compression.ZipArchive]::new($output, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($source in $prepared) {
            $entry = $archive.CreateEntry('jellyfin-source/' + $source.Path, [IO.Compression.CompressionLevel]::Optimal)
            $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $stream = $entry.Open()
            try { $stream.Write($source.Bytes, 0, $source.Bytes.Length) } finally { $stream.Dispose() }
        }
    } finally { $archive.Dispose() }
} finally { $output.Dispose() }
$archiveBytes = [IO.File]::ReadAllBytes($archivePath)
if ($archiveBytes.Length -ge 100MB) { throw 'Source archive exceeds the intended single-file size limit.' }
$roundTrip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($roundTrip.Entries.Count -ne $manifest.files.Count) { throw 'Source archive membership changed.' }
    $sealed = @{}
    foreach ($entry in $manifest.files) { $sealed['jellyfin-source/' + $entry.path] = $entry }
    foreach ($entry in $roundTrip.Entries) {
        $expected = $sealed[$entry.FullName]
        if ($null -eq $expected) { throw 'Unexpected or duplicate source archive member.' }
        $stream = $entry.Open(); $memory = [IO.MemoryStream]::new()
        try { $stream.CopyTo($memory); $bytes = $memory.ToArray() } finally { $stream.Dispose(); $memory.Dispose() }
        if ($bytes.Length -ne $expected.size -or (Digest $bytes) -ne $expected.sha256) { throw 'Source archive member bytes changed.' }
        $sealed.Remove($entry.FullName)
    }
    if ($sealed.Count -ne 0) { throw 'Source archive omitted manifest members.' }
} finally { $roundTrip.Dispose() }
function Seal([string]$Name, [byte[]]$Bytes) {
    $filename = Join-Path $bundle $Name
    $stream = [IO.File]::Open($filename, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
}
Seal 'jellyfin-source-manifest.json' $manifestBytes
Seal 'jellyfin-local-modifications.json' $modificationBytes
$proof = [ordered]@{
    schemaVersion = 1
    scope = 'Complete 2620-file designated source manifest, including all local modifications, copied byte-for-byte from the receipt-bound build source tree. Original upstream documentation and build helpers are retained. No build or test was executed.'
    archive = @{ path = $archiveName; bytes = $archiveBytes.Length; sha256 = (Digest $archiveBytes); required = $true }
    prefix = 'jellyfin-source/'
    sourceManifest = @{ path = 'jellyfin-source-manifest.json'; bytes = $manifestBytes.Length; sha256 = (Digest $manifestBytes); required = $true }
    localModifications = @{ path = 'jellyfin-local-modifications.json'; bytes = $modificationBytes.Length; sha256 = (Digest $modificationBytes); required = $true }
    license = @{ path = 'LICENSE-Jellyfin.txt'; sha256 = ($manifest.files | Where-Object path -eq 'LICENSE').sha256; required = $true }
    buildReceipt = @{ path = 'objects/' + (Digest $receiptBytes) + '.json'; bytes = $receiptBytes.Length; sha256 = (Digest $receiptBytes); required = $true }
    nativeAssembly = @{ path = 'objects/' + $receipt.buildIdentity.nativeDll.sha256 + '.dll'; bytes = $receipt.buildIdentity.nativeDll.bytes; sha256 = $receipt.buildIdentity.nativeDll.sha256; required = $true }
    head = $manifest.head
    sourceContentDigest = $manifest.contentDigest
    sourceFiles = $manifest.files.Count
    sourceBytes = ($manifest.files | Measure-Object size -Sum).Sum
    localModificationFiles = $modifications.entries.Count
    excludedSourceFiles = @()
    audit = @{ manifestDigestsMatched = $true; archiveMemberDigestsMatched = $true; allLocalModificationsRetained = $true; sourcePathAndCredentialMarkerReview = $true; noInstanceOrBuildOutputInputs = $true }
    reviewedPublicPlaceholder = @{ path = $reviewedPlaceholder; reason = 'Mock configuration uses user/password and secret placeholders at media.example.com to test URL sanitization. Original source bytes are retained.' }
    binaryUse = 'The associated DLL is archived only as recorded evidence. This source offer does not supply SDK, operating-system or NuGet runtime binaries and does not claim a new reproducible build.'
}
Seal 'jellyfin-source-package.json' ([Text.Encoding]::UTF8.GetBytes(($proof | ConvertTo-Json -Depth 10) + "`n"))
[ordered]@{ archive = $archivePath; bytes = $archiveBytes.Length; sha256 = (Digest $archiveBytes); files = $manifest.files.Count; localModifications = $modifications.entries.Count; testsExecuted = $false } | ConvertTo-Json
