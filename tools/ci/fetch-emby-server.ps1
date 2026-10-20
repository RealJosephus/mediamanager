$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Reference packages must be prepared in GitHub Actions.' }
$root = Join-Path $env:RUNNER_TEMP 'mediamanager-emby-reference'
if (Test-Path -LiteralPath $root) { throw 'Emby reference output must be a new directory.' }
$receipts = Join-Path $root 'receipts'
[IO.Directory]::CreateDirectory($receipts) | Out-Null
$url = 'https://github.com/MediaBrowser/Emby.Releases/releases/download/4.10.1.0/embyserver-netcore_4.10.1.0.zip'
$archive = Join-Path $root 'release.zip'
$expected = 'cada885b561eb4dd06fb410d09127b6948c2110662c3bdcd1e653a6cf04b9dce'
$receipt = [ordered]@{
    kind = 'official-emby-server'; version = '4.10.1.0'; url = $url
    release = 'https://github.com/MediaBrowser/Emby.Releases/releases/tag/4.10.1.0'
    repository = $env:GITHUB_REPOSITORY; commit = $env:GITHUB_SHA
    runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    expectedBytes = 219472907; expectedSha256 = $expected; status = 'started'
    redistribution = 'Only capture observations and provenance are published; the server package and instance are private.'
}
try {
    Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 180
    $receipt.bytes = (Get-Item -LiteralPath $archive).Length
    $receipt.sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($receipt.bytes -ne $receipt.expectedBytes -or $receipt.sha256 -ne $expected) { throw 'The official Emby package differs from the designated release.' }
    $package = Join-Path $root 'package'
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            $target = [IO.Path]::GetFullPath((Join-Path $package $entry.FullName))
            if (-not $target.StartsWith($package + [IO.Path]::DirectorySeparatorChar, [StringComparison]::Ordinal) -or $entry.FullName.Contains('\')) {
                throw 'Unsafe official archive member.'
            }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive links are not supported.' }
        }
        $receipt.members = $zip.Entries.Count
    } finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $archive -DestinationPath $package
    $receipt.status = 'prepared'
    "MEDIAMANAGER_EMBY_REFERENCE_ROOT=$root" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
} catch {
    $receipt.status = 'failed'; $receipt.failure = $_.Exception.Message
    throw
} finally {
    [IO.File]::WriteAllText((Join-Path $receipts 'reference-input.json'), ($receipt | ConvertTo-Json -Depth 8) + "`n")
}
