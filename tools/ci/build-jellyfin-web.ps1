$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV) {
    throw 'The designated Jellyfin Web must be built in GitHub Actions.'
}
$head = '4c6d87e61c28e15dcb0cfe431ba6c083bb307a0b'
$lockPin = 'bc9b0aaf153d6f8f1abb9c9ff96dc1c3c53e900bd4a8c107d3a348e7e3bcc218'
$output = Join-Path $env:RUNNER_TEMP 'mediamanager-jellyfin-web'
if (Test-Path -LiteralPath $output) { throw 'Jellyfin Web output must be a new isolated directory.' }
$source = Join-Path $output 'source'
$runtime = Join-Path $output 'runtime'
$receipts = Join-Path $output 'receipts'
$offer = Join-Path $output 'source-offer'
$cache = Join-Path $output 'npm-cache'
foreach ($directory in @($source, $runtime, $receipts, $offer, $cache)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
$commands = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{
    schemaVersion = 1; kind = 'jellyfin-web'; status = 'started'; started = [DateTimeOffset]::UtcNow.ToString('o')
    repository = $env:GITHUB_REPOSITORY; commit = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    sourceRepository = 'https://github.com/jellyfin/jellyfin-web.git'; sourceHead = $head; sourceFiles = 1226
    sourceCheckoutLineEndings = 'git core.autocrlf=true with repository attributes; lock bytes match the designated worktree'
    os = [Runtime.InteropServices.RuntimeInformation]::OSDescription; architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    imageVersion = $env:ImageVersion; nodeExpected = 'v24.16.0'; commands = $commands
    sourceUnchanged = $false; webInteractionValidated = $false
}
function Describe([string]$Filename, [string]$Relative) {
    $file = Get-Item -LiteralPath $Filename -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Expected ordinary input: ' + $Relative) }
    [ordered]@{ path = $Relative; bytes = $file.Length; sha256 = (Get-FileHash -LiteralPath $Filename -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Write-Record([string]$Name, $Value) {
    $filename = Join-Path $receipts $Name
    [IO.File]::WriteAllText($filename, ($Value | ConvertTo-Json -Depth 30) + "`n")
    Describe $filename ('receipts/' + $Name)
}
function Actual-File([string]$Filename) {
    $file = Get-Item -LiteralPath $Filename
    if ($file.LinkType) { $file = $file.ResolveLinkTarget($true) }
    # ResolveLinkTarget returns a .NET FileSystemInfo without PowerShell's
    # provider-added PSIsContainer property. Check its actual filesystem type.
    if ($file -isnot [IO.FileInfo] -or -not $file.Exists) { throw 'Tool selection did not resolve to a file.' }
    $file.FullName
}
function Run([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$Seconds = 60) {
    Write-Host "Jellyfin Web: $Name"
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable; $start.WorkingDirectory = $source
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.Environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $start.Environment['GIT_CONFIG_GLOBAL'] = Join-Path $output 'empty-config'
    $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
    $start.Environment['NPM_CONFIG_USERCONFIG'] = Join-Path $output 'empty-config'
    $start.Environment['NPM_CONFIG_CACHE'] = $cache
    $start.Environment['JELLYFIN_VERSION'] = $head
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $stdoutPath = Join-Path $receipts "$Name.stdout.txt"; $stderrPath = Join-Path $receipts "$Name.stderr.txt"
    $stdout = [IO.File]::Create($stdoutPath); $stderr = [IO.File]::Create($stderrPath)
    $record = [ordered]@{ name = $Name; executable = $Executable; arguments = $Arguments; timeoutSeconds = $Seconds; started = [DateTimeOffset]::UtcNow.ToString('o') }
    $commands.Add($record); $started = $false
    try {
        if (-not $process.Start()) { throw ('Cannot start ' + $Name) }
        $started = $true
        $outCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (-not $process.WaitForExit($Seconds * 1000)) { $record.timedOut = $true; $process.Kill($true); $process.WaitForExit() }
        $outCopy.GetAwaiter().GetResult(); $errCopy.GetAwaiter().GetResult()
        $record.exitCode = $process.ExitCode
        if ($record.Contains('timedOut') -or $process.ExitCode -ne 0) { throw ("Jellyfin Web $Name failed; see its command logs.") }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
        $stdout.Dispose(); $stderr.Dispose(); $process.Dispose()
        $record.finished = [DateTimeOffset]::UtcNow.ToString('o')
        $record.stdout = Describe $stdoutPath "receipts/$Name.stdout.txt"
        $record.stderr = Describe $stderrPath "receipts/$Name.stderr.txt"
    }
}
function Tree-Files([string]$Root) {
    @(Get-ChildItem -LiteralPath $Root -Force -Recurse | ForEach-Object {
        if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Unexpected link in build evidence: ' + $_.FullName) }
        if (-not $_.PSIsContainer) { Describe $_.FullName ([IO.Path]::GetRelativePath($Root, $_.FullName).Replace('\', '/')) }
    } | Sort-Object { $_.path })
}
function Source-Snapshot {
    $files = @($sourceNames | ForEach-Object { Describe (Join-Path $source $_) $_ })
    [ordered]@{ head = $head; files = $files }
}
$sourceNames = @(); $failure = $null
try {
    [IO.File]::WriteAllText((Join-Path $output 'empty-config'), '')
    $git = Actual-File ((Get-Command git -CommandType Application | Select-Object -First 1).Source)
    $node = Actual-File ((Get-Command node -CommandType Application | Select-Object -First 1).Source)
    $npm = Actual-File ((Get-Command npm -CommandType Application | Select-Object -First 1).Source)
    if ([IO.Path]::GetExtension($npm) -eq '.cmd') { $npm = Actual-File (Join-Path ([IO.Path]::GetDirectoryName($npm)) 'node_modules/npm/bin/npm-cli.js') }
    if ([IO.Path]::GetFileName($npm) -cne 'npm-cli.js') { throw 'Cannot identify the selected npm CLI implementation.' }
    $npmRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($npm)) '..'))
    $receipt.builder = Describe $PSCommandPath $PSCommandPath
    $receipt.tools = @(@($git, $node, $npm) | ForEach-Object { Describe $_ $_ })
    $receipt.npmToolRoot = $npmRoot
    $receipt.npmToolManifest = Write-Record 'npm-tool-manifest.json' @{ files = (Tree-Files $npmRoot) }
    Run 'git-version' $git @('--version')
    Run 'node-version' $node @('--version')
    Run 'npm-version' $node @($npm, '--version')
    $receipt.nodeActual = (Get-Content -LiteralPath (Join-Path $receipts 'node-version.stdout.txt') -Raw).Trim()
    $receipt.npmActual = (Get-Content -LiteralPath (Join-Path $receipts 'npm-version.stdout.txt') -Raw).Trim()
    if ($receipt.nodeActual -cne $receipt.nodeExpected -or $receipt.npmActual -notmatch '^11\.\d+\.\d+$') { throw 'Expected Node 24.16.0 with npm 11.' }
    Run 'git-init' $git @('init', '--quiet')
    Run 'git-remote' $git @('remote', 'add', 'origin', $receipt.sourceRepository)
    Run 'git-fetch' $git @('fetch', '--depth=1', '--no-tags', 'origin', $head) 180
    Run 'git-checkout' $git @('-c', 'core.autocrlf=true', 'checkout', '--detach', '--force', 'FETCH_HEAD')
    Run 'git-head' $git @('rev-parse', 'HEAD')
    if ((Get-Content -LiteralPath (Join-Path $receipts 'git-head.stdout.txt') -Raw).Trim() -cne $head) { throw 'Unexpected Jellyfin Web commit.' }
    Run 'git-files' $git @('-c', 'core.quotePath=false', 'ls-files')
    $sourceNames = @(Get-Content -LiteralPath (Join-Path $receipts 'git-files.stdout.txt'))
    if ($sourceNames.Count -ne $receipt.sourceFiles) { throw 'Unexpected Jellyfin Web source membership.' }
    foreach ($name in $sourceNames) {
        if ($name -match '(^|/)(\.|\.\.)(/|$)|[:\\\r\n\x00]|^/' -or $name.Contains('//')) { throw 'Unsafe tracked source member.' }
    }
    $receipt.sourceBefore = Write-Record 'source-before.json' (Source-Snapshot)
    $receipt.lock = Describe (Join-Path $source 'package-lock.json') 'package-lock.json'
    if ($receipt.lock.sha256 -cne $lockPin) { throw 'The designated worktree lockfile changed.' }
    $package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
    if ($package.name -cne 'jellyfin-web' -or $package.version -cne '13.0.0' -or $package.license -cne 'GPL-2.0-or-later') { throw 'Unexpected Jellyfin Web package identity.' }
    $receipt.license = $package.license
    $archivePath = Join-Path $offer 'jellyfin-web-source.zip'
    $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
    try { foreach ($name in $sourceNames) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $source $name), $name) | Out-Null } }
    finally { $archive.Dispose() }
    Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $offer 'LICENSE')
    Copy-Item -LiteralPath (Join-Path $receipts 'source-before.json') -Destination (Join-Path $offer 'source-manifest.json')
    $receipt.sourceOffer = @(Tree-Files $offer | ForEach-Object { $_.path = 'source-offer/' + $_.path; $_ })
    Run 'npm-ci' $node @($npm, 'ci', '--no-audit') 600
    # The unmodified upstream production command emits its static assets outside
    # the source tree. Do not apply upstream CI's demo-server config rewrite.
    Run 'build' $node @($npm, 'run', 'build:production', '--', '--output-path', $runtime) 900
    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'index.html') -PathType Leaf)) { throw 'Jellyfin Web build produced no entry page.' }
    if ((Get-FileHash -LiteralPath (Join-Path $runtime 'config.json')).Hash -cne (Get-FileHash -LiteralPath (Join-Path $source 'src/config.json')).Hash) { throw 'The client configuration changed during packaging.' }
    $receipt.runtimeManifest = Write-Record 'runtime-manifest.json' @{ files = (Tree-Files $runtime) }
    $receipt.status = 'succeeded'
} catch { $failure = $_; $receipt.status = 'failed'; $receipt.error = $_.Exception.Message }
finally {
    try {
        if ($sourceNames.Count) {
            $receipt.sourceAfter = Write-Record 'source-after.json' (Source-Snapshot)
            $receipt.sourceUnchanged = $receipt.sourceBefore.sha256 -ceq $receipt.sourceAfter.sha256
            if (-not $receipt.sourceUnchanged) { throw 'The build changed designated source bytes.' }
        }
        $content = Join-Path $cache '_cacache/content-v2'
        if (Test-Path -LiteralPath $content) { $receipt.npmCacheManifest = Write-Record 'npm-cache-manifest.json' @{ integritySource = 'pinned package-lock.json, verified by npm ci'; files = (Tree-Files $content) } }
        if ($receipt.status -eq 'succeeded' -and -not $receipt.Contains('npmCacheManifest')) { throw 'The build did not retain npm content identity.' }
    } catch { if (-not $failure) { $failure = $_ }; $receipt.status = 'failed'; $receipt.auditError = $_.Exception.Message }
    $receipt.finished = [DateTimeOffset]::UtcNow.ToString('o')
    Write-Record 'build-receipt.json' $receipt | Out-Null
}
if ($failure) { throw $failure }
"MEDIAMANAGER_JELLYFIN_WEB_BUILD_ROOT=$output" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"MEDIAMANAGER_JELLYFIN_WEB_ROOT=$runtime" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host ('Designated Jellyfin Web static assets and evidence: ' + $output)
