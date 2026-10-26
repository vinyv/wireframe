# Builds what you share, in dist\:
#   Wireframe-<version>.zxp  the extension, signed, for an extension manager (no debug mode needed)
#   Wireframe-<version>.zip  the .zxp plus the helper source, the install script and the docs
# Leaves out what only matters on this machine: extension\.debug (opens CEP remote-debug ports),
# Google Drive's desktop.ini files, .claude\ and the browser preview.
#
# Signing uses Adobe's ZXPSignCmd and a self-signed certificate, both kept in %APPDATA%\Wireframe\signing
# (outside the project, so the certificate is never shared). Missing pieces are set up on first run:
# ZXPSignCmd is downloaded from Adobe's CEP-Resources repository and checked against a known hash, and
# a certificate is created with a random password stored encrypted for this Windows user (DPAPI).
# Keep using the same certificate for updates.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

$signing = Join-Path $env:APPDATA 'Wireframe\signing'
$zxpSign = Join-Path $signing 'ZXPSignCmd.exe'
$zxpSignUrl = 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe'
$zxpSignSha256 = 'FFC2223167225CE61D024EB463FC5AD1A1BE16133F99EF334A646F7311916C98'
$cert = Join-Path $signing 'wireframe.p12'
$certPasswordFile = "$cert.password"
$timestampUrl = 'http://timestamp.digicert.com'

function Invoke-Checked([string]$exe, [string[]]$arguments, [string]$what) {
    # Windows PowerShell turns a native tool's stderr into errors, which 'Stop' would make fatal.
    $ErrorActionPreference = 'Continue'
    $output = & $exe @arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "$what failed ($LASTEXITCODE): $output" }
    return $output
}

# ---- signing tool and certificate ---------------------------------------------------------------

New-Item -ItemType Directory -Force $signing | Out-Null
if (-not (Test-Path $zxpSign)) {
    Write-Output "Downloading ZXPSignCmd 4.1.3 from Adobe's CEP-Resources repository..."
    Invoke-WebRequest -Uri $zxpSignUrl -OutFile $zxpSign -UseBasicParsing
}
if ((Get-FileHash $zxpSign -Algorithm SHA256).Hash -ne $zxpSignSha256) {
    Remove-Item $zxpSign
    throw "ZXPSignCmd.exe doesn't match the expected download; deleted it. Check $zxpSignUrl."
}

if (-not (Test-Path $cert)) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $newPassword = [Convert]::ToBase64String($bytes) -replace '[+/=]', 'x'
    # Run from the signing folder: ZXPSignCmd leaves an OpenSSL seed file (.rnd) in the current folder.
    Push-Location $signing
    try {
        Invoke-Checked $zxpSign @('-selfSignedCert', 'XX', 'NA', 'Wireframe', 'Wireframe', $newPassword, $cert, '-validityDays', '3650') 'creating the certificate' | Out-Null
    } finally {
        Pop-Location
    }
    ConvertTo-SecureString $newPassword -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $certPasswordFile -Encoding ascii
    Write-Output "Created a signing certificate at $cert"
}
$securePassword = (Get-Content $certPasswordFile -Raw).Trim() | ConvertTo-SecureString
$certPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword))

# ---- build --------------------------------------------------------------------------------------

& cmd /c "`"$(Join-Path $root 'helper\build.cmd')`""
if ($LASTEXITCODE -ne 0) { throw 'helper build failed' }

$manifest = [xml](Get-Content (Join-Path $root 'extension\CSXS\manifest.xml') -Raw)
$version = $manifest.ExtensionManifest.ExtensionBundleVersion
$name = "Wireframe-$version"
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$stage = Join-Path ([IO.Path]::GetTempPath()) ("wireframe-package-" + [Guid]::NewGuid())
$out = Join-Path $stage $name
$extStage = Join-Path $stage 'extension'
New-Item -ItemType Directory -Force $out | Out-Null
try {
    robocopy (Join-Path $root 'extension') $extStage /E /XF desktop.ini .debug /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

    # ---- .zxp: the signed extension ---------------------------------------------------------------
    $zxp = Join-Path $dist "$name.zxp"
    if (Test-Path $zxp) { Remove-Item $zxp }
    try {
        Invoke-Checked $zxpSign @('-sign', $extStage, $zxp, $cert, $certPassword, '-tsa', $timestampUrl) 'signing' | Out-Null
    } catch {
        # A timestamp keeps the signature valid after the certificate expires; without the timestamp
        # server the package is still signed, just only until then.
        Write-Warning "Timestamp server unreachable, signing without a timestamp: $($_.Exception.Message)"
        if (Test-Path $zxp) { Remove-Item $zxp }
        Invoke-Checked $zxpSign @('-sign', $extStage, $zxp, $cert, $certPassword) 'signing' | Out-Null
    }
    $verify = Invoke-Checked $zxpSign @('-verify', $zxp) 'verifying the signature'
    Write-Output "Signed $zxp ($($verify.Trim()))"

    # ---- .zip: the .zxp, the source and the docs ---------------------------------------------------
    Copy-Item $zxp $out
    robocopy $extStage (Join-Path $out 'extension') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
    robocopy (Join-Path $root 'helper') (Join-Path $out 'helper') /E /XF desktop.ini /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
    New-Item -ItemType Directory -Force (Join-Path $out 'tools') | Out-Null
    Copy-Item (Join-Path $root 'tools\install-dev.ps1') (Join-Path $out 'tools')
    foreach ($f in 'README.md', 'LICENSE', 'PLAN.md') {
        $p = Join-Path $root $f
        if (Test-Path $p) { Copy-Item $p $out }
    }

    $zip = Join-Path $dist "$name.zip"
    if (Test-Path $zip) { Remove-Item $zip }
    Compress-Archive -Path $out -DestinationPath $zip
    Write-Output "Packaged $zip"
} finally {
    Remove-Item -Recurse -Force $stage
}
exit 0
