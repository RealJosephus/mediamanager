param([ValidateSet('contracts','4.9.1.0','latest')][string]$Channel = 'contracts', [switch]$Alternate)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Reference packages must be prepared in GitHub Actions.' }
$root = Join-Path $env:RUNNER_TEMP 'mediamanager-emby-reference'
if ($Alternate) { $root = Join-Path $env:RUNNER_TEMP 'mediamanager-emby-alternate' }
if (Test-Path -LiteralPath $root) { throw 'Emby reference output must be a new directory.' }
$receipts = Join-Path $root 'receipts'
[IO.Directory]::CreateDirectory($receipts) | Out-Null
$url = 'https://github.com/MediaBrowser/Emby.Releases/releases/download/4.10.1.0/embyserver-netcore_4.10.1.0.zip'
$archive = Join-Path $root 'release.zip'
$expected = 'cada885b561eb4dd06fb410d09127b6948c2110662c3bdcd1e653a6cf04b9dce'
$version = '4.10.1.0'
$expectedBytes = 219472907
$assetId = $null
if ($Channel -ne 'contracts') {
    $version = $Channel
    if ($version -eq 'latest') {
        $lines = & gh api --paginate 'repos/MediaBrowser/Emby.Releases/releases?per_page=100' --jq '.[] | select(.draft == false and .published_at != null) | [.published_at,.tag_name] | @tsv'
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve official Emby releases.' }
        $latest = $lines | Where-Object { $_ -match '\s\d+\.\d+\.\d+\.\d+$' } | Sort-Object -Descending | Select-Object -First 1
        if (-not $latest) { throw 'No public server release was found.' }
        $version = ($latest -split '\s+')[1]
    }
    $release = & gh api "repos/MediaBrowser/Emby.Releases/releases/tags/$version" | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $release.draft -or $release.tag_name -cne $version) { throw 'Unexpected official release.' }
    $asset = @($release.assets | Where-Object name -eq "embyserver-netcore_${version}.zip")
    if ($asset.Count -ne 1) { throw 'The selected release has no unique portable server package.' }
    $assetId = $asset[0].id
    $url = $asset[0].browser_download_url
    $expectedBytes = $asset[0].size
    $expected = ([string]$asset[0].digest) -replace '^sha256:', ''
    if ($version -eq '4.9.1.0' -and ($assetId -ne 258289722 -or $expectedBytes -ne 221809123)) { throw 'The fixed Emby release asset changed.' }
    if ($version -eq '4.9.1.0') { $expected = 'f5adde914a45d6a1d7e1a9e4379e3c24a4631d2faecaa098d44c0c7dbc14ea7e' }
    if (-not $expected -and $version -ne '4.9.1.0') { throw 'Missing official release asset digest.' }
}
$receipt = [ordered]@{
    kind = 'official-emby-server'; version = $version; url = $url; assetId = $assetId
    release = "https://github.com/MediaBrowser/Emby.Releases/releases/tag/$version"
    repository = $env:GITHUB_REPOSITORY; commit = $env:GITHUB_SHA
    runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    expectedBytes = $expectedBytes; expectedSha256 = $expected; status = 'started'
    redistribution = 'Only capture observations and provenance are published; the server package and instance are private.'
}
try {
    Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 180
    $receipt.bytes = (Get-Item -LiteralPath $archive).Length
    $receipt.sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($receipt.bytes -ne $receipt.expectedBytes -or ($expected -and $receipt.sha256 -ne $expected)) { throw 'The official Emby package differs from the designated release.' }
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
    $key = if ($Alternate) { 'MEDIAMANAGER_EMBY_ALTERNATE_ROOT' } else { 'MEDIAMANAGER_EMBY_REFERENCE_ROOT' }
    "$key=$root" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
} catch {
    $receipt.status = 'failed'; $receipt.failure = $_.Exception.Message
    throw
} finally {
    [IO.File]::WriteAllText((Join-Path $receipts 'reference-input.json'), ($receipt | ConvertTo-Json -Depth 8) + "`n")
}
