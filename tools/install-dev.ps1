# Copies the extension into the per-user CEP extensions folder so After Effects loads it.
# Re-run after every change, then close and reopen the panel (Window > Extensions > Wireframe).
# Unsigned extensions need PlayerDebugMode=1 under HKCU\Software\Adobe\CSXS.<n> (see README.md).
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot '..\extension'
$extensions = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dst = Join-Path $extensions 'com.wireframe'

if (-not (Test-Path (Join-Path $src 'bin\wireframe-cap.exe'))) {
    & cmd /c "`"$(Join-Path $PSScriptRoot '..\helper\build.cmd')`""
    if ($LASTEXITCODE -ne 0) { throw 'helper build failed' }
}

New-Item -ItemType Directory -Force $dst | Out-Null

# An open panel keeps the installed helper running, which locks the exe. Stop it; the panel
# starts a fresh one on its next request (reopen the panel anyway to load the new JS).
# cyclops-cap is the helper's name before 0.2.0.
Get-Process wireframe-cap, cyclops-cap -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($extensions, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.Id -Force; $_.WaitForExit(3000) | Out-Null }

# Before 0.2.0 the extension was installed as com.cyclopsredo; remove that copy so AE doesn't list
# two Wireframe panels. Only removed if it really is this extension.
$old = Join-Path $extensions 'com.cyclopsredo'
$oldManifest = Join-Path $old 'CSXS\manifest.xml'
if ((Test-Path $oldManifest) -and (Select-String -Path $oldManifest -Pattern 'ExtensionBundleName="Wireframe"' -Quiet)) {
    Remove-Item -Recurse -Force $old
    Write-Output "Removed the old install at $old"
}

# /R /W: fail fast instead of robocopy's default of a million 30-second retries on a locked file.
robocopy $src $dst /MIR /R:2 /W:1 /XF desktop.ini /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Write-Output "Installed to $dst"
exit 0  # robocopy uses 1-7 for success; don't leak that as a failure
