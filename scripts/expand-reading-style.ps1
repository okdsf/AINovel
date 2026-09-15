[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath $destinationPath -PathType Container)) {
  throw 'The reading extension staging directory must already exist.'
}
if (@(Get-ChildItem -LiteralPath $destinationPath -Force).Count) {
  throw 'The reading extension may only be extracted into an empty staging directory.'
}
$root = $destinationPath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  foreach ($entry in $zip.Entries) {
    $total += $entry.Length
    $name = $entry.FullName.Replace('/', '\')
    if ($zip.Entries.Count -gt 10000 -or $total -gt 100MB -or
        [IO.Path]::IsPathRooted($name) -or $name.Contains(':') -or
        ($name.Split('\') -contains '..') -or
        (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
      throw 'The Stylus archive contains an unsafe entry or exceeds extraction limits.'
    }
    $target = [IO.Path]::GetFullPath((Join-Path $destinationPath $name))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not $names.Add($target)) {
      throw 'The Stylus archive contains an escaping or duplicate path.'
    }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($Archive), $destinationPath)
