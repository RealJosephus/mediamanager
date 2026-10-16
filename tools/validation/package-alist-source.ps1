param([string]$SourceDirectory = 'D:/alist')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# File preparation only: no Go command, build, server, oracle or test is executed.
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundle = Join-Path $PSScriptRoot 'fixtures/alist-api-host'
$sourceRoot = [IO.Path]::GetFullPath($SourceDirectory)
$headExpected = '38316357f1a0507e9e8906ed9ec78e8535ba2d1c'
$extra = @('drivers/hf_aggregate/driver.go', 'drivers/hf_aggregate/meta.go')
$modified = @('drivers/all.go') + $extra
$reviewedFile = 'internal/offline_download/qbit/qbit.go'
$reviewedSha256 = '52fe4510033fe49e33a4c3b049a2327fb130eb85bde1e24db11643cddd719267'
function Git-Lines([string[]]$Arguments) {
    $result = & git -c "safe.directory=$sourceRoot" -C $sourceRoot @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read designated AList source identity.' }
    return $result
}
function Digest([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
function Read-Ordinary([string]$Root, [string]$Relative) {
    if ($Relative -match '(^|/)(\.|\.\.)(/|$)|[:\\\r\n\x00]|^/' -or $Relative.Contains('//')) { throw 'Invalid source member path.' }
    $cursor = $Root
    if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Source root must not be a link.' }
    foreach ($part in $Relative.Split('/')) {
        $cursor = Join-Path $cursor $part
        if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Source link rejected: ' + $Relative) }
    }
    if (-not [IO.File]::Exists($cursor)) { throw ('Source member is not a file: ' + $Relative) }
    return ,([IO.File]::ReadAllBytes($cursor))
}
function Seal([string]$Name, [byte[]]$Bytes) {
    $stream = [IO.File]::Open((Join-Path $bundle $Name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $stream.Write($Bytes, 0, $Bytes.Length) } finally { $stream.Dispose() }
    return [ordered]@{ path = $Name; bytes = $Bytes.Length; sha256 = (Digest $Bytes); required = $true }
}
$head = Git-Lines @('rev-parse', 'HEAD')
$dirty = @(Git-Lines @('status', '--porcelain=v1', '--untracked-files=all'))
$expectedDirty = @(' M drivers/all.go', '?? drivers/hf_aggregate/driver.go', '?? drivers/hf_aggregate/meta.go')
if ($head -cne $headExpected -or ($dirty -join "`n") -cne ($expectedDirty -join "`n")) { throw 'AList HEAD or designated local modifications changed.' }
$tracked = @(Git-Lines @('ls-files', '--stage'))
if ($tracked.Count -ne 633) { throw 'The designated AList tree must have exactly 633 tracked files.' }
$sources = [Collections.Generic.List[object]]::new()
foreach ($line in $tracked) {
    if ($line -notmatch '^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$') { throw 'Nonordinary tracked source member.' }
    $sources.Add(@{ path = $Matches[3]; gitMode = $Matches[1]; gitBlob = $Matches[2]; tracked = $true })
}
foreach ($filename in $extra) { $sources.Add(@{ path = $filename; gitMode = '100644'; gitBlob = $null; tracked = $false }) }
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$prepared = [Collections.Generic.List[object]]::new()
$manifestFiles = [Collections.Generic.List[object]]::new()
$secretMarkers = '(?i)-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bgh[pousr]_[a-z0-9]{32,}\b|\bgithub_pat_[a-z0-9_]{40,}\b|\bAKIA[A-Z0-9]{16}\b|\bhf_[a-z0-9]{25,}\b|(?:https?|postgres(?:ql)?):\/\/[^\s\/@:]+:[^\s\/@]+@'
foreach ($entry in ($sources | Sort-Object -Property path -CaseSensitive)) {
    if (-not $names.Add($entry.path)) { throw 'Duplicate or case-colliding source member.' }
    if ($entry.path -match '(^|/)(\.git|node_modules|vendor|data|logs?|tmp|dist)(/|$)|(^|/)(\.env(?:\..*)?|secrets?\.json|credentials?)(/|$)|\.(pfx|pem|key|db|sqlite|sqlite3|dll|exe|ttf|woff2?)$') {
        # internal/bootstrap/data is tracked application source, never instance data.
        if (-not $entry.path.StartsWith('internal/bootstrap/data/', [StringComparison]::Ordinal)) { throw ('Unexpected or private source path: ' + $entry.path) }
    }
    $bytes = Read-Ordinary $sourceRoot $entry.path
    $sha256 = Digest $bytes
    if ([Text.Encoding]::UTF8.GetString($bytes) -match $secretMarkers -and -not ($entry.path -ceq $reviewedFile -and $sha256 -ceq $reviewedSha256)) {
        throw ('Unreviewed credential marker in source member: ' + $entry.path)
    }
    $prepared.Add(@{ path = $entry.path; bytes = $bytes })
    $manifestFiles.Add([ordered]@{ path = $entry.path; bytes = $bytes.Length; sha256 = $sha256; tracked = $entry.tracked; gitMode = $entry.gitMode; gitBlob = $entry.gitBlob; localModification = $entry.path -cin $modified })
}
$archiveName = 'alist-source-38316357f1a0.zip'
$archivePath = Join-Path $bundle $archiveName
$output = [IO.File]::Open($archivePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
    $archive = [IO.Compression.ZipArchive]::new($output, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($source in $prepared) {
            $member = $archive.CreateEntry('alist-source/' + $source.path, [IO.Compression.CompressionLevel]::Optimal)
            $member.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
            $stream = $member.Open()
            try { $stream.Write($source.bytes, 0, $source.bytes.Length) } finally { $stream.Dispose() }
        }
    } finally { $archive.Dispose() }
} finally { $output.Dispose() }
foreach ($entry in $manifestFiles) {
    if ((Digest (Read-Ordinary $sourceRoot $entry.path)) -cne $entry.sha256) { throw ('Source changed during packaging: ' + $entry.path) }
}
if ((Git-Lines @('rev-parse', 'HEAD')) -cne $head -or ((Git-Lines @('status', '--porcelain=v1', '--untracked-files=all')) -join "`n") -cne ($dirty -join "`n")) { throw 'Source state changed during packaging.' }
$archiveBytes = [IO.File]::ReadAllBytes($archivePath)
if ($archiveBytes.Length -ge 100MB) { throw 'Source archive exceeds the size budget.' }
$manifest = [ordered]@{ schemaVersion = 1; head = $head; files = $manifestFiles.ToArray(); originalGoSourceUnchanged = $true; originalFrontendExcluded = $true }
$manifestIdentity = Seal 'source-manifest.json' ([Text.Encoding]::UTF8.GetBytes(($manifest | ConvertTo-Json -Depth 8) + "`n"))
$license = Seal 'LICENSE-AList.txt' (Read-Ordinary $sourceRoot 'LICENSE')
$frontend = Read-Ordinary $bundle 'web/index.html'
$frontendLicense = Read-Ordinary $bundle 'LICENSE-Test-Web.txt'
$sourceBytes = 0
foreach ($entry in $manifestFiles) { $sourceBytes += $entry.bytes }
$package = [ordered]@{
    schemaVersion = 1; kind = 'alist-api-only-test-host'; head = $head
    sourceFiles = $manifestFiles.Count; sourceBytes = $sourceBytes
    sourceArchive = @{ path = $archiveName; bytes = $archiveBytes.Length; sha256 = (Digest $archiveBytes); required = $true }
    sourceManifest = $manifestIdentity; license = $license
    frontend = @{ path = 'web/index.html'; bytes = $frontend.Length; sha256 = (Digest $frontend); required = $true; destination = 'public/dist/index.html'; authoredForThisTestHost = $true }
    frontendLicense = @{ path = 'LICENSE-Test-Web.txt'; bytes = $frontendLicense.Length; sha256 = (Digest $frontendLicense); required = $true }
    localModifications = @($manifestFiles | Where-Object { $_.localModification })
    excluded = @('Original ignored public/dist', '.git', 'instance configuration, databases, logs, HF manifest/token files, binaries and caches')
    reviewedPublicDefault = @{ path = $reviewedFile; sha256 = $reviewedSha256; upstream = 'https://raw.githubusercontent.com/AlistGo/alist/d7aa1608ac2f3834af87b4a81b8f0970b3dadbc0/internal/offline_download/qbit/qbit.go'; rawBytesMatched = $true; valuesPrinted = $false }
    webUiValidated = $false; originalReleaseReproduced = $false; testsExecuted = $false; buildExecuted = $false
}
$packageIdentity = Seal 'package.json' ([Text.Encoding]::UTF8.GetBytes(($package | ConvertTo-Json -Depth 10) + "`n"))
[ordered]@{ sourceFiles = $package.sourceFiles; sourceBytes = $package.sourceBytes; archiveBytes = $archiveBytes.Length; archiveSha256 = $package.sourceArchive.sha256; manifestSha256 = $manifestIdentity.sha256; packageSha256 = $packageIdentity.sha256; frontendSha256 = $package.frontend.sha256; originalFrontendExcluded = $true; testsExecuted = $false } | ConvertTo-Json
