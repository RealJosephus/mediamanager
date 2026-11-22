param(
    [ValidateSet('contracts','4.9.1.0','latest')][string]$Channel = 'contracts',
    [switch]$Alternate,
    [string]$FreezeMigrationInputs
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Reference packages must be prepared in GitHub Actions.' }
$releaseRepository = 'repos/MediaBrowser/Emby.Releases'
$fixedVersion = '4.9.1.0'
$fixedId = 258289722
$fixedBytes = 221809123
$fixedSha = 'f5adde914a45d6a1d7e1a9e4379e3c24a4631d2faecaa098d44c0c7dbc14ea7e'

function Assert-MigrationInputs($Inputs) {
    if ($Inputs.schema -ne 1 -or $Inputs.runId -cne $env:GITHUB_RUN_ID -or $Inputs.commit -cne $env:GITHUB_SHA) {
        throw 'Emby selection is for a different migration run.'
    }
    foreach ($entry in @($Inputs.latest, $Inputs.fixed)) {
        if ($entry.version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $entry.assetId -le 0 -or
            $entry.bytes -le 0 -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
            $entry.url -cne "https://github.com/MediaBrowser/Emby.Releases/releases/download/$($entry.version)/embyserver-netcore_$($entry.version).zip") {
            throw 'Invalid official Emby asset in the migration selection.'
        }
    }
    if ($Inputs.fixed.version -cne $fixedVersion -or $Inputs.fixed.assetId -ne $fixedId -or
        $Inputs.fixed.bytes -ne $fixedBytes -or $Inputs.fixed.sha256 -cne $fixedSha) {
        throw 'The fixed Emby release asset changed.'
    }
}

function Read-OfficialAsset($Release) {
    $version = $Release.tag_name
    if ($Release.assets.Count -ne 1) { throw "Release $version has no unique portable server package." }
    $asset = $Release.assets[0]
    $sha = ([string]$asset.digest) -replace '^sha256:', ''
    if ($version -eq $fixedVersion) { $sha = $fixedSha }
    return [ordered]@{
        version = $version; assetId = $asset.id; bytes = $asset.size; sha256 = $sha; url = $asset.browser_download_url
        releaseId = $Release.id; publishedAt = $Release.published_at; prerelease = $Release.prerelease
    }
}

if ($FreezeMigrationInputs) {
    if (Test-Path -LiteralPath $FreezeMigrationInputs) {
        $inputs = Get-Content -LiteralPath $FreezeMigrationInputs -Raw | ConvertFrom-Json
    } else {
        # Include all public versions, including prereleases, ordered by the
        # publisher's release timestamp. Take the asset from the same listing.
        $filter = '.[] | select(.draft == false and .published_at != null and (.tag_name | test("^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$"))) | . as $release | {id,tag_name,published_at,prerelease,assets:[.assets[] | select(.name == ("embyserver-netcore_" + $release.tag_name + ".zip")) | {id,size,digest,browser_download_url}]}'
        $lines = & gh api --paginate "$releaseRepository/releases?per_page=100" --jq $filter
        if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve official Emby releases.' }
        $releases = $lines | ForEach-Object { ConvertFrom-Json -InputObject $_ }
        $latest = $releases | Sort-Object -Property @{Expression='published_at';Descending=$true}, @{Expression='id';Descending=$true} |
            Select-Object -First 1
        $fixed = @($releases | Where-Object tag_name -eq $fixedVersion)
        if (-not $latest -or $fixed.Count -ne 1) { throw 'Cannot find the public server releases required for migration.' }
        $inputs = [ordered]@{
            schema = 1; commit = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID
            latest = Read-OfficialAsset $latest
            fixed = Read-OfficialAsset $fixed[0]
        }
    }
    Assert-MigrationInputs $inputs
    $selection = $inputs | ConvertTo-Json -Depth 8 -Compress
    if (-not (Test-Path -LiteralPath $FreezeMigrationInputs)) {
        [IO.File]::WriteAllText($FreezeMigrationInputs, $selection + [Environment]::NewLine)
    }
    "selection=$selection" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append
    return
}

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
    if (-not $env:MEDIAMANAGER_EMBY_INPUTS) { throw 'The migration job requires the frozen Emby selection.' }
    $inputs = $env:MEDIAMANAGER_EMBY_INPUTS | ConvertFrom-Json
    Assert-MigrationInputs $inputs
    $asset = if ($Channel -eq $fixedVersion) { $inputs.fixed } else { $inputs.latest }
    $version = $asset.version
    $assetId = $asset.assetId
    $url = $asset.url
    $expectedBytes = $asset.bytes
    $expected = $asset.sha256
}
$receipt = [ordered]@{
    kind = 'official-emby-server'; version = $version; url = $url; assetId = $assetId
    release = "https://github.com/MediaBrowser/Emby.Releases/releases/tag/$version"
    repository = $env:GITHUB_REPOSITORY; commit = $env:GITHUB_SHA
    runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    expectedBytes = $expectedBytes; expectedSha256 = $expected; status = 'started'
    redistribution = 'Only capture observations and provenance are published; the server package and instance are private.'
}
if ($assetId) {
    $receipt.releaseId = $asset.releaseId
    $receipt.publishedAt = $asset.publishedAt
    $receipt.prerelease = $asset.prerelease
}
try {
    if ($assetId) {
        & gh api -H 'Accept: application/octet-stream' "$releaseRepository/releases/assets/$assetId" > $archive
        if ($LASTEXITCODE -ne 0) { throw 'Cannot download the frozen Emby asset.' }
    } else {
        Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 180
    }
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
