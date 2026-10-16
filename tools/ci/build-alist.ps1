$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV -or
    $env:MEDIAMANAGER_CI_ALIST_REFERENCE -ne 'true') { throw 'The AList API test host must be built explicitly in GitHub Actions.' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundle = Join-Path $repository 'tools/validation/fixtures/alist-api-host'
$output = Join-Path $env:RUNNER_TEMP 'mediamanager-alist-build'
if (Test-Path -LiteralPath $output) { throw 'AList build output must be a new isolated directory.' }
$sourceRoot = Join-Path $output 'source'
$receipts = Join-Path $output 'receipts'
$runtime = Join-Path $output 'runtime'
$offer = Join-Path $output 'source-offer'
foreach ($directory in @($sourceRoot, $receipts, $runtime, $offer)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
$commands = [Collections.Generic.List[object]]::new()
$receipt = [ordered]@{
    schemaVersion = 1; kind = 'alist-api-only-test-host'; status = 'started'; started = [DateTimeOffset]::UtcNow.ToString('o')
    repository = $env:GITHUB_REPOSITORY; commit = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
    os = [Runtime.InteropServices.RuntimeInformation]::OSDescription; imageVersion = $env:ImageVersion
    architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    goExpected = 'go1.23.1'; commands = $commands; webUiValidated = $false; originalReleaseReproduced = $false
    originalGoSourceUnchanged = $false; testsExecuted = $false
}
function Digest([byte[]]$Bytes) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes)).ToLowerInvariant() }
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
function Run-Program([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$Seconds = 60) {
    Write-Output "AList API host: $Name"
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable; $start.WorkingDirectory = $sourceRoot
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    $stdoutPath = Join-Path $receipts "$Name.stdout.txt"; $stderrPath = Join-Path $receipts "$Name.stderr.txt"
    $stdout = [IO.File]::Create($stdoutPath); $stderr = [IO.File]::Create($stderrPath)
    $record = [ordered]@{ name = $Name; executable = $Executable; arguments = $Arguments; timeoutSeconds = $Seconds; started = [DateTimeOffset]::UtcNow.ToString('o') }
    $commands.Add($record)
    $started = $false
    try {
        if (-not $process.Start()) { throw ('Could not start ' + $Name) }
        $started = $true
        $outCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
        if (-not $process.WaitForExit($Seconds * 1000)) {
            $record.timedOut = $true; $process.Kill($true); $process.WaitForExit()
        }
        $outCopy.GetAwaiter().GetResult(); $errCopy.GetAwaiter().GetResult()
        $record.exitCode = $process.ExitCode
        if ($record.Contains('timedOut')) { throw ('AList ' + $Name + ' timed out; process tree terminated.') }
        if ($process.ExitCode -ne 0) { throw ('AList ' + $Name + ' failed; see bounded command evidence.') }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
        $stdout.Dispose(); $stderr.Dispose(); $process.Dispose()
        $record.finished = [DateTimeOffset]::UtcNow.ToString('o')
        $record.stdout = Describe $stdoutPath "receipts/$Name.stdout.txt"
        $record.stderr = Describe $stderrPath "receipts/$Name.stderr.txt"
    }
}
function Source-Snapshot {
    $members = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $manifest.files) { $members.Add($entry.path) | Out-Null }
    $members.Add($package.frontend.destination) | Out-Null
    $observed = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force)
    foreach ($member in $observed) {
        if (($member.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'AList source tree contains a link.' }
        if (-not $member.PSIsContainer -and -not $members.Remove([IO.Path]::GetRelativePath($sourceRoot, $member.FullName).Replace('\', '/'))) { throw 'AList build introduced an unsealed source file.' }
    }
    if ($members.Count -ne 0) { throw 'AList source tree lost a sealed member.' }
    $rows = foreach ($entry in $manifest.files) {
        $cursor = $sourceRoot
        foreach ($part in $entry.path.Split('/')) {
            $cursor = Join-Path $cursor $part
            if (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'AList source path traverses a link.' }
        }
        $row = Describe $cursor $entry.path
        $row.matches = $row.sha256 -ceq $entry.sha256 -and $row.bytes -eq $entry.bytes
        $row
    }
    $frontend = Describe (Join-Path $sourceRoot $package.frontend.destination) $package.frontend.destination
    $frontend.matches = $frontend.sha256 -ceq $package.frontend.sha256 -and $frontend.bytes -eq $package.frontend.bytes
    [ordered]@{ files = @($rows); frontend = $frontend; allMatched = @($rows | Where-Object { -not $_.matches }).Count -eq 0 -and $frontend.matches }
}
$sourceVerified = $false
try {
    $packageFile = Join-Path $bundle 'package.json'
    $packageIdentity = Describe $packageFile 'package.json'
    if ($packageIdentity.sha256 -cne '6b9631506420acf8873ea7956b896d8ab0864a8b08d8f60338dd9eb2d1498bc3') { throw 'AList source package pin changed.' }
    $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
    if ($package.kind -cne $receipt.kind -or $package.head -cne '38316357f1a0507e9e8906ed9ec78e8535ba2d1c' -or $package.sourceFiles -ne 635) { throw 'Unexpected AList source identity.' }
    $receipt.package = $packageIdentity
    $attachments = @($package.sourceArchive, $package.sourceManifest, $package.license, $package.frontend, $package.frontendLicense)
    foreach ($attachment in $attachments) {
        if ($attachment.path -match '(^|/)(\.|\.\.)(/|$)|[:\\\r\n\x00]|^/' -or $attachment.path.Contains('//')) { throw 'Invalid package attachment path.' }
        $actual = Describe (Join-Path $bundle $attachment.path) $attachment.path
        if ($actual.sha256 -cne $attachment.sha256 -or $actual.bytes -ne $attachment.bytes) { throw ('AList package bytes changed: ' + $attachment.path) }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $bundle $package.sourceManifest.path) -Raw | ConvertFrom-Json
    if ($manifest.files.Count -ne 635 -or $manifest.head -cne $package.head -or -not $manifest.originalFrontendExcluded) { throw 'AList source manifest is incomplete.' }
    $expected = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files) {
        if ($entry.path -match '(^|/)(\.|\.\.)(/|$)|[:\\\r\n\x00]|^/|^public/dist/' -or $entry.path.Contains('//') -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.bytes -lt 0) { throw 'Invalid AList source member.' }
        $expected.Add('alist-source/' + $entry.path, $entry)
    }
    $archive = [IO.Compression.ZipFile]::OpenRead((Join-Path $bundle $package.sourceArchive.path))
    try {
        if ($archive.Entries.Count -ne $expected.Count) { throw 'AList archive membership mismatch.' }
        foreach ($member in $archive.Entries) {
            if (-not $expected.ContainsKey($member.FullName)) { throw 'Unexpected or duplicate AList archive member.' }
            $entry = $expected[$member.FullName]
            if ($member.FullName -cne ('alist-source/' + $entry.path) -or $member.Length -ne $entry.bytes) { throw 'AList archive member identity mismatch.' }
            $inputStream = $member.Open(); $memory = [IO.MemoryStream]::new()
            try { $inputStream.CopyTo($memory); $bytes = $memory.ToArray() } finally { $inputStream.Dispose(); $memory.Dispose() }
            if ((Digest $bytes) -cne $entry.sha256) { throw ('AList source bytes changed: ' + $entry.path) }
            $filename = Join-Path $sourceRoot $entry.path
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($filename)) | Out-Null
            [IO.File]::WriteAllBytes($filename, $bytes)
            $expected.Remove($member.FullName) | Out-Null
        }
    } finally { $archive.Dispose() }
    if ($expected.Count -ne 0) { throw 'AList archive omitted source members.' }
    $web = Join-Path $sourceRoot $package.frontend.destination
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($web)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $bundle $package.frontend.path) -Destination $web
    $before = Source-Snapshot
    $receipt.sourceBefore = Write-Record 'source-before.json' $before
    if (-not $before.allMatched) { throw 'AList extracted input identity mismatch.' }
    $sourceVerified = $true
    foreach ($name in @('package.json', 'README.md') + @($attachments | ForEach-Object { $_.path })) {
        $destination = Join-Path $offer $name
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $bundle $name) -Destination $destination
    }
    $receipt.sourceOffer = @(Get-ChildItem -LiteralPath $offer -Recurse -File | Sort-Object FullName | ForEach-Object {
        Describe $_.FullName ('source-offer/' + [IO.Path]::GetRelativePath($offer, $_.FullName).Replace('\', '/'))
    })
    $platform = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'darwin' } elseif ($IsLinux) { 'linux' } else { throw 'Unsupported AList runner.' }
    $architecture = if ($receipt.architecture -eq 'X64') { 'amd64' } elseif ($receipt.architecture -eq 'Arm64') { 'arm64' } else { throw 'Unsupported AList architecture.' }
    $sdkPins = @{
        'windows-amd64' = '32dedf277c86610e380e1765593edb66876f00223df71690bd6be68ee17675c0'
        'linux-amd64' = '49bbb517cfa9eee677e1e7897f7cf9cfdbcf49e05f61984a2789136de359f9bd'
        'darwin-amd64' = '488d9e4ca3e3ed513ee4edd91bef3a2360c65fa6d6be59cf79640bf840130a58'
        'darwin-arm64' = 'e223795ca340e285a760a6446ce57a74500b30e57469a4109961d36184d3c05a'
    }
    $target = "$platform-$architecture"
    if (-not $sdkPins.ContainsKey($target)) { throw 'No pinned Go SDK for this runner target.' }
    $sdkName = 'go1.23.1.' + $target + $(if ($IsWindows) { '.zip' } else { '.tar.gz' })
    $sdkArchive = Join-Path $output $sdkName
    $url = 'https://go.dev/dl/' + $sdkName
    Write-Output "AList API host: download pinned Go SDK for $target"
    Invoke-WebRequest -Uri $url -OutFile $sdkArchive -TimeoutSec 180 -MaximumRetryCount 2 -RetryIntervalSec 2
    $receipt.sdkArchive = Describe $sdkArchive $sdkName
    if ($receipt.sdkArchive.sha256 -cne $sdkPins[$target]) { throw 'Go SDK archive SHA256 mismatch.' }
    $receipt.sdkUrl = $url
    if ($IsWindows) { Expand-Archive -LiteralPath $sdkArchive -DestinationPath $output }
    else { Run-Program 'extract-sdk' '/usr/bin/tar' @('-xzf', $sdkArchive, '-C', $output) 120 }
    $env:GOROOT = Join-Path $output 'go'
    $go = Join-Path $env:GOROOT $(if ($IsWindows) { 'bin/go.exe' } else { 'bin/go' })
    $env:GOTOOLCHAIN = 'local'; $env:GOENV = 'off'; $env:GOWORK = 'off'
    $env:GOOS = $platform; $env:GOARCH = $architecture; $env:CGO_ENABLED = '1'
    $env:GOFLAGS = '-mod=readonly'; $env:GOPROXY = 'https://proxy.golang.org'; $env:GOSUMDB = 'sum.golang.org'
    $env:GOPRIVATE = ''; $env:GONOPROXY = ''; $env:GONOSUMDB = ''; $env:GOINSECURE = ''
    $env:GOPATH = Join-Path $output 'gopath'; $env:GOMODCACHE = Join-Path $output 'module-cache'; $env:GOCACHE = Join-Path $output 'build-cache'
    $cc = Get-Command $(if ($IsMacOS) { 'clang' } else { 'gcc' }) -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $ccInfo = Get-Item -LiteralPath $cc.Source -Force
    $env:CC = if (($ccInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $ccInfo.ResolveLinkTarget($true).FullName } else { $ccInfo.FullName }
    # Keep the selected compiler's own linker and DLL lookup in the same toolchain.
    $env:PATH = [IO.Path]::GetDirectoryName($env:CC) + [IO.Path]::PathSeparator + $env:PATH
    $receipt.compiler = Describe $env:CC 'compiler'
    $receipt.compiler.filename = $env:CC
    $receipt.goExecutable = Describe $go ('go/bin/' + [IO.Path]::GetFileName($go))
    Run-Program 'compiler-version' $env:CC @('--version')
    Run-Program 'compiler-target' $env:CC @('-dumpmachine')
    if ($IsWindows -and (Get-Content -LiteralPath (Join-Path $receipts 'compiler-target.stdout.txt') -Raw).Trim() -notmatch '^x86_64-w64-mingw32$') { throw 'Windows AList requires a native 64-bit MinGW compiler.' }
    Run-Program 'go-version' $go @('version')
    $receipt.goActual = (Get-Content -LiteralPath (Join-Path $receipts 'go-version.stdout.txt') -Raw).Trim()
    if ($receipt.goActual -cne "go version go1.23.1 $platform/$architecture") { throw 'AList Go toolchain version mismatch.' }
    Run-Program 'go-environment' $go @('env', '-json', 'GOVERSION', 'GOOS', 'GOARCH', 'GOROOT', 'GOTOOLCHAIN', 'CGO_ENABLED', 'CC', 'GOPROXY', 'GOSUMDB', 'GOMODCACHE', 'GOFLAGS', 'GOWORK')
    $executable = Join-Path $runtime $(if ($IsWindows) { 'alist.exe' } else { 'alist' })
    $ldflags = '-X github.com/alist-org/alist/v3/internal/conf.Version=mediamanager-api-test-host -X github.com/alist-org/alist/v3/internal/conf.GitCommit=38316357f1a0507e9e8906ed9ec78e8535ba2d1c-dirty -X github.com/alist-org/alist/v3/internal/conf.GoVersion=go1.23.1 -X github.com/alist-org/alist/v3/internal/conf.WebVersion=controlled-api-only'
    Run-Program 'build' $go @('build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-tags=jsoniter', '-ldflags', $ldflags, '-o', $executable, '.') 1200
    Run-Program 'module-verify' $go @('mod', 'verify') 180
    Run-Program 'dependencies' $go @('list', '-mod=readonly', '-tags=jsoniter', '-deps', '-json', '.') 180
    Run-Program 'binary-modules' $go @('version', '-m', $executable)
    Run-Program 'alist-version' $executable @('version')
    $version = Get-Content -LiteralPath (Join-Path $receipts 'alist-version.stdout.txt') -Raw
    if ($version -notmatch 'mediamanager-api-test-host' -or $version -notmatch 'controlled-api-only' -or $version -notmatch '38316357f1a0507e9e8906ed9ec78e8535ba2d1c-dirty') { throw 'Built AList does not identify the designated API-only source.' }
    $receipt.executable = Describe $executable ('runtime/' + [IO.Path]::GetFileName($executable))
    if ((Describe $env:CC 'compiler').sha256 -cne $receipt.compiler.sha256 -or
        (Describe $go $receipt.goExecutable.path).sha256 -cne $receipt.goExecutable.sha256) { throw 'The selected compiler changed during the AList build.' }
    $receipt.sourceAfter = Write-Record 'source-after.json' (Source-Snapshot)
    if (-not (Get-Content -LiteralPath (Join-Path $receipts 'source-after.json') -Raw | ConvertFrom-Json).allMatched) { throw 'The build changed an original source or controlled frontend input.' }
    $receipt.originalGoSourceUnchanged = $true
    $receipt.status = 'succeeded'
} catch {
    $receipt.status = 'failed'; $receipt.error = $_.Exception.Message
    throw
} finally {
    if ($sourceVerified -and -not $receipt.Contains('sourceAfter')) {
        try { $receipt.sourceAfter = Write-Record 'source-after.json' (Source-Snapshot) } catch { $receipt.sourceAuditError = $_.Exception.Message }
    }
    $receipt.finished = [DateTimeOffset]::UtcNow.ToString('o')
    Write-Record 'build-receipt.json' $receipt | Out-Null
}
# Publish paths only after the complete source, compiler and executable audit.
"MEDIAMANAGER_ALIST_BUILD_ROOT=$output" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"MEDIAMANAGER_ALIST_EXECUTABLE=$executable" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Output 'AList API-only test host ready; original Web UI remains unvalidated.'
