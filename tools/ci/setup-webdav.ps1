$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV -or -not $env:MEDIAMANAGER_VALIDATION_OUTPUT_ROOT) {
    throw 'The isolated WebDAV executable must be provisioned in GitHub Actions.'
}

# Official release ZIP pins: https://downloads.rclone.org/v1.75.2/SHA256SUMS
# The fixture runs this executable as an isolated, authenticated WebDAV server.
$version = '1.75.2'
$platform = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'osx' } elseif ($IsLinux) { 'linux' } else { throw 'Unsupported WebDAV runner OS.' }
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$target = "$platform-$architecture"
$releases = @{
    'linux-x64' = @{ archive = 'linux-amd64'; sha256 = '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702' }
    'windows-x64' = @{ archive = 'windows-amd64'; sha256 = '8a9db2bad1dc79a65b3348fd857069598e2aab7cf4d118b77b1df23055aff818' }
    'osx-x64' = @{ archive = 'osx-amd64'; sha256 = '574e1f31cf1c464e5fb0325cb66fcbdeaf1efa1802bd9b17f13c256fd74b6561' }
    'osx-arm64' = @{ archive = 'osx-arm64'; sha256 = '610ab7d48615135dfc60b763858b11a426a0d3d1160c1bb76fb0ae6011b02edd' }
}
if (-not $releases.ContainsKey($target)) { throw "Unsupported WebDAV runner target: $target" }
$release = $releases[$target]
$root = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'mediamanager-webdav'))
if (Test-Path -LiteralPath $root) { throw 'WebDAV installation requires a new isolated directory.' }
[IO.Directory]::CreateDirectory($root) | Out-Null
$evidence = Join-Path $env:MEDIAMANAGER_VALIDATION_OUTPUT_ROOT 'provisioning'
[IO.Directory]::CreateDirectory($evidence) | Out-Null
$archiveName = "rclone-v$version-$($release.archive)"
$archive = Join-Path $root "$archiveName.zip"
$url = "https://downloads.rclone.org/v$version/$archiveName.zip"
$receipt = [ordered]@{
    schemaVersion = 1; status = 'started'; versionExpected = "rclone v$version"; target = $target
    url = $url; sha256Expected = $release.sha256; started = [DateTimeOffset]::UtcNow.ToString('o')
}
try {
    Write-Output "Downloading fixed WebDAV executable: $url"
    Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 120 -MaximumRetryCount 2 -RetryIntervalSec 2
    $receipt.sha256Actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($receipt.sha256Actual -cne $release.sha256) { throw 'The WebDAV release ZIP SHA256 does not match its repository pin.' }
    $receipt.archiveBytes = (Get-Item -LiteralPath $archive).Length
    Expand-Archive -LiteralPath $archive -DestinationPath $root
    $executable = Join-Path (Join-Path $root $archiveName) $(if ($IsWindows) { 'rclone.exe' } else { 'rclone' })
    $file = Get-Item -LiteralPath $executable -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The WebDAV executable must be an ordinary file.'
    }
    if (-not $IsWindows) {
        & /bin/chmod 755 $executable
        if ($LASTEXITCODE -ne 0) { throw 'Cannot mark the WebDAV executable as executable.' }
    }
    $receipt.executable = $executable
    $receipt.executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $executable
    $start.ArgumentList.Add('version')
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Could not launch the WebDAV executable.' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000)) { $process.Kill($true); $process.WaitForExit(); throw 'WebDAV version verification timed out.' }
        $versionOutput = $stdout.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $evidence 'webdav-version.stdout.txt'), $versionOutput)
        [IO.File]::WriteAllText((Join-Path $evidence 'webdav-version.stderr.txt'), $stderr.GetAwaiter().GetResult())
        $receipt.exitCode = $process.ExitCode
        $receipt.versionActual = ($versionOutput -split '\r?\n')[0]
        if ($process.ExitCode -ne 0 -or $receipt.versionActual -cne $receipt.versionExpected) { throw 'The WebDAV executable version did not match its pinned release.' }
    } finally { $process.Dispose() }
    "MEDIAMANAGER_WEBDAV_EXECUTABLE=$executable" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
    $receipt.status = 'succeeded'
    Write-Output "Verified $($receipt.versionActual) for $target; ZIP SHA256 $($receipt.sha256Actual); executable: $executable"
} catch {
    $receipt.status = 'failed'; $receipt.error = $_.Exception.Message
    throw
} finally {
    $receipt.finished = [DateTimeOffset]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $evidence 'webdav-install.json'), ($receipt | ConvertTo-Json -Depth 5) + "`n")
}
