# Wireframe

An After Effects panel that renders what the comp viewer shows — layer paths, handles, bounding boxes,
null icons — to an image sequence (PNG, JPEG or TIFF), one frame at a time.

It maximizes the comp viewer, zooms it so the comp is as large as your screen allows, steps through the
work area (or the whole comp), and saves each frame once AE has finished redrawing it. Afterwards it puts
your view, selection, zoom, resolution and Auto Save setting back the way they were.

**Requirements:** Windows 10 or 11, After Effects 2025 (25.0) or newer.

## Install

### From the signed package (recommended)

1. Install `Wireframe-<version>.zxp` with a ZXP installer, for example
   [Anastasiy's Extension Manager](https://install.anastasiy.com/) or
   [ZXPInstaller](https://aescripts.com/learn/zxp-installer/). The package is signed, so there's no
   need to change any After Effects setting.
2. Restart After Effects and open **Window > Extensions > Wireframe**.

The signature is self-signed: it proves the files weren't changed after packaging, not who made them.
If the panel opens blank, see Adobe's
[known issue](https://github.com/Adobe-CEP/CEP-Resources/blob/master/ZXPSignCMD/KnownIssue2024.md)
(start After Effects once as administrator, or use the manual install below).

### Manual install (for development)

1. **Allow unsigned extensions.** Copied by hand, the panel isn't checked as signed, so CEP must be in
   debug mode. In PowerShell:

   ```powershell
   foreach ($v in 11, 12) {
     $key = "HKCU:\Software\Adobe\CSXS.$v"
     if (-not (Test-Path $key)) { New-Item -Path $key | Out-Null }
     New-ItemProperty -Path $key -Name PlayerDebugMode -Value 1 -PropertyType String -Force | Out-Null
   }
   ```

   This lets After Effects load any unsigned extension, not just this one. (CSXS.11 and .12 cover the
   CEP versions in recent AE releases.)

2. **Copy the extension.** In PowerShell, from this folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\install-dev.ps1
   ```

   This copies `extension\` to `%APPDATA%\Adobe\CEP\extensions\com.wireframe`. If
   `extension\bin\wireframe-cap.exe` is missing, it is built first (see below).

3. Restart After Effects and open **Window > Extensions > Wireframe**.

Use one install method or the other: both install the same extension ID.

## Use

- Open a comp, then click **Render**. Progress and a Cancel button appear in a small box over AE;
  **Esc** in AE also cancels.
- Frames go to a `Wireframe` folder next to the saved project (or to the folder chosen in Settings).
- The settings button opens **Settings**: output format, frame range, preview mode, timing, a
  one-frame test, and the log.
- If AE crashes or the panel is closed mid-render, the panel offers **Restore** the next time it opens.

## The capture helper

`extension\bin\wireframe-cap.exe` grabs AE's window and writes the image files. It's a small C# program,
built from `helper\` with the C# compiler that ships with Windows:

```bat
helper\build.cmd
```

It only looks at After Effects' own window. It reads the keyboard only to notice Esc while AE is in
front, and it presses AE's Title/Action Safe shortcut to hide those guides while rendering (turned back
on afterwards). Some antivirus tools are wary of unsigned programs that do this; building it yourself
from the source avoids trusting a prebuilt file.

## Building a release

```powershell
powershell -ExecutionPolicy Bypass -File tools\package.ps1
```

This writes `dist\Wireframe-<version>.zxp` and `dist\Wireframe-<version>.zip`. The first run downloads
Adobe's ZXPSignCmd (checked against a known hash) and creates a self-signed certificate; both stay in
`%APPDATA%\Wireframe\signing`, with the certificate's password encrypted for your Windows user. Don't
share that folder, and sign every update with the same certificate.

## Files

| Path | What it is |
| --- | --- |
| `extension/` | The CEP extension: panel (`index.html`, `js/main.js`), Settings window, host script (`jsx/host.jsx`) |
| `helper/` | Source of the capture helper |
| `tools/install-dev.ps1` | Installs the extension for the current user |
| `tools/package.ps1` | Builds the signed `.zxp` and a zip to share in `dist\` (leaves out debug and local files) |
| `tools/preview.html` | Previews the panel in a browser with a fake AE (serve the folder over http) |
| `PLAN.md` | Design notes and what was tested |

Settings, the log and crash-recovery state live in `%APPDATA%\Wireframe`.

## Licence

MIT (see `LICENSE`). The panel uses Funnel Display, licensed under the SIL Open Font License
(`extension/fonts/OFL.txt`).
