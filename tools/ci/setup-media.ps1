$ErrorActionPreference = 'Stop'
$version = '8.1.3-1'
$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$platform = if ($IsWindows) { 'win' } elseif ($IsMacOS) { 'mac' } elseif ($IsLinux) { 'linux' } else { throw 'Unsupported media tool platform.' }
$suffix = switch ($architecture) { 'X64' { '64' } 'Arm64' { 'arm64' } default { throw "Unsupported media tool architecture: $architecture" } }
$key = $platform + $suffix
$releases = @{
  linux64 = @{ id = 593310067; sha256 = 'b86dc023c64a5a9a410e6e3a938a970460214fae78f31c1553c9f88f1c289b6a' }
  linuxarm64 = @{ id = 593310171; sha256 = '7bc8e8d0986f7f4693f63e9728570f671f07b6e21c05d5465dd7ce461d1631dc' }
  mac64 = @{ id = 593133849; sha256 = 'cb2b5c154d49a6b6bfe29fa6c16510e85dcbf60b805764121a167b093d4bb6fb' }
  macarm64 = @{ id = 593133970; sha256 = '22445d7299742749ad2eeb9ce87963d50def0357e45b3e6c7b69987c8365dbf6' }
  win64 = @{ id = 593290159; sha256 = '3691f8b2d4c39c511b5faff1c8c4687bd782dac823e63ba69f0755f7ce1af9ce' }
  winarm64 = @{ id = 593290145; sha256 = '4118c7046bf3410e342b6cf583ccdae01b940df3c2b3e3f7d329d34569da3283' }
}
$release = $releases[$key]
$asset = if ($IsWindows) { "jellyfin-ffmpeg_${version}_portable_${key}-clang-gpl.zip" } else { "jellyfin-ffmpeg_${version}_portable_${key}-gpl.tar.xz" }
$url = "https://api.github.com/repos/jellyfin/jellyfin-ffmpeg/releases/assets/$($release.id)"
if (-not $env:MEDIAMANAGER_RELEASE_ASSET_TOKEN) { throw 'Release asset downloads require the Actions read token.' }
$token = ConvertTo-SecureString -String $env:MEDIAMANAGER_RELEASE_ASSET_TOKEN -AsPlainText
$root = Join-Path $env:RUNNER_TEMP 'mediamanager-media-tools'
if (Test-Path -LiteralPath $root) { throw 'Media tools require a fresh isolated directory.' }
New-Item -ItemType Directory -Path $root | Out-Null
$archive = Join-Path $root $asset
Invoke-WebRequest -Uri $url -Authentication Bearer -Token $token -Headers @{ Accept = 'application/octet-stream' } -OutFile $archive -TimeoutSec 180 -MaximumRetryCount 2 -RetryIntervalSec 2
$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -cne $release.sha256) { throw 'The media tool archive does not match the pinned release digest.' }
$unpacked = Join-Path $root 'unpacked'
New-Item -ItemType Directory -Path $unpacked | Out-Null
if ($IsWindows) { Expand-Archive -LiteralPath $archive -DestinationPath $unpacked }
else {
  & tar -xJf $archive -C $unpacked
  if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the media tool archive.' }
}
$extension = if ($IsWindows) { '.exe' } else { '' }
$tools = foreach ($name in @('ffmpeg', 'ffprobe')) {
  $executables = @(Get-ChildItem -LiteralPath $unpacked -Recurse -File -Filter "$name$extension")
  if ($executables.Count -ne 1) { throw "Expected exactly one $name executable." }
  $executable = $executables[0].FullName
  $reported = @(& $executable -version 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not $reported[0].ToString().StartsWith("$name version 8.1.3")) { throw "Unexpected $name release." }
  "MEDIAMANAGER_$($name.ToUpperInvariant())=$executable" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  $executables[0].DirectoryName | Out-File -FilePath $env:GITHUB_PATH -Encoding utf8 -Append
  [ordered]@{ name = $name; executable = $executable; sha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant(); version = $reported[0].ToString() }
}
$receipt = Join-Path $env:MEDIAMANAGER_VALIDATION_OUTPUT_ROOT 'provisioning/media-tools.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $receipt) | Out-Null
[ordered]@{ version = $version; platform = $key; assetId = $release.id; url = $url; archiveSha256 = $digest; tools = @($tools) } |
  ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding utf8
