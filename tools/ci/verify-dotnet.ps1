$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV) {
    throw 'The isolated .NET installation must be verified in GitHub Actions.'
}
$root = [IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'mediamanager-dotnet'))
$comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
if (-not $env:DOTNET_INSTALL_DIR -or -not [string]::Equals([IO.Path]::GetFullPath($env:DOTNET_INSTALL_DIR), $root, $comparison)) {
    throw 'DOTNET_INSTALL_DIR must be the isolated runner installation.'
}
foreach ($directory in @($root, (Join-Path $root 'host'), (Join-Path $root 'shared'), (Join-Path $root 'sdk/10.0.401'), (Join-Path $root 'packs'))) {
    $item = Get-Item -LiteralPath $directory -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The isolated .NET installation requires physical SDK and runtime directories.'
    }
}
$filename = Join-Path $root $(if ($IsWindows) { 'dotnet.exe' } else { 'dotnet' })
$file = Get-Item -LiteralPath $filename -Force
if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The isolated dotnet executable must be an ordinary file.'
}
$selected = (Get-Command dotnet -CommandType Application | Select-Object -First 1).Source
if (-not [string]::Equals([IO.Path]::GetFullPath($selected), $filename, $comparison)) {
    throw 'PATH selected a dotnet executable outside the isolated installation.'
}
# The SDK lazily creates this empty workload metadata directory on first use.
# Prepare it before strict validation binds the entire installation tree.
$metadata = Join-Path $root 'metadata'
New-Item -ItemType Directory -Path $metadata -Force | Out-Null
$metadataItem = Get-Item -LiteralPath $metadata -Force
if (-not $metadataItem.PSIsContainer -or ($metadataItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The SDK metadata directory must be physical.'
}
"MEDIAMANAGER_DOTNET=$filename" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"MEDIAMANAGER_CI_DOTNET_ROOT=$root" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Output "Verified isolated .NET SDK 10.0.401: $filename"
