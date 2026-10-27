# Wireframe — Plan

Wireframe renders a comp's viewer (with layer paths, handles and other overlays) to an image sequence.
After Effects 2025/2026, Windows only.

## Goals
- Capture only AE's window (no mouse cursor, no other apps), with no fixed delays: wait until the viewer
  has actually redrawn.
- One long-running capture process instead of one process launch per frame.
- Zoom the viewer so the comp is as large as the screen allows.

## Decisions
- Output size: **largest that fits on screen** (no tiling; slightly under 1080p is fine).
- Modes: **composite** (comp + overlays) and **overlays-only with alpha**.
- Platform: **Windows only**.

## Phase 0 results (verified 2026-10-24 on AE 26.5, 2576x1096 window, 96 DPI)
- `PrintWindow(hwnd, PW_RENDERFULLCONTENT)` on the AfterFX.exe main window captures **only AE**,
  including the GPU viewer, with no mouse cursor. ~30–45 ms per grab. → No need for Windows.Graphics.Capture.
- `app.activeViewer.maximized = true` does what double-clicking the panel tab does. Scriptable.
- `viewer.views[0].options.zoom` is settable. Measured comp size on screen = comp size × zoom, exactly
  (1 comp px = 1 screen px at 100% at 96 DPI). Fit zoom for 2560x1080 in the maximized viewer ≈ 0.836.
- Viewer pasteboard is flat RGB (29,29,29). When the comp fills the viewer there is no pasteboard to
  measure against → calibrate with a temporary marker layer, not pasteboard detection.
- A frame change arrives as **two redraws ~230 ms apart** → capture only after the image is stable.

## Status
- Phases 1–2 built (2026-10-24): `extension/` (panel, `jsx/host.jsx`), `helper/` (C# source, `build.cmd`),
  `tools/install-dev.ps1` (copies to `%APPDATA%\Adobe\CEP\extensions\com.wireframe`).
- Helper tested standalone against AE: find / grab / grabStable / error handling all OK.
  `PrintWindow` costs ~35 ms with the viewer maximized and ~120 ms in a normal multi-panel layout.
- Tested inside AE 26.5 (2026-10-24): Test capture prepared the comp, maximized the viewer, saved a
  stable full-window PNG (3 grabs, 400 ms) and restored the view. Phases 1–2 done.
- Phase 3 done and tested in AE (2026-10-24): 1920×1080 comp → fit 81.79% (viewer 2541×888, height-limited),
  1570×883 crop with all overlays, calibration 2.6 s. Lessons: adding a layer opens Effect Controls, which
  drops the viewer out of maximized mode (re-maximize before every step); solo the marker so zoom steps render
  instantly; per-layer selection costs ~20 ms each (use Edit > Select All / Deselect All).
- Edge "cut" (2026-10-24): the crop matched the comp exactly; what got cut was layer handles/bounding boxes
  centred on the comp boundary. Added "Edge padding" (default 6 px of pasteboard around the comp).
- Phase 4 done and tested in AE (2026-10-24): 255-frame work area of a 240-layer comp in 2m 26s
  (0.57 s/frame). 255 unique frames, no gaps, no consecutive duplicates (so no stale captures), all
  1561×883, edge handles whole.
- Phase 4 details: Render loops the work area / whole comp. Per frame:
  setFrame (frame-exact, tested at 7 frame rates × 200k frames) → grabStable waits for the comp image to
  change, then for it to hold still for the settle time. "Max render wait" caps the wait when a frame looks
  identical to the previous one. Progress shows in an always-on-top box from the helper (the panel is
  hidden while the viewer is maximized). Cancel via that box's button, Esc while AE is active, or the panel button.
  The flow was smoke-tested in Node with a fake AE and a fake helper (full run + cancel).
- Phase 3 details: `extension/js/calibrate.js` + `measure` in the helper
  (`helper/Calibration.cs`). Marker detection was tested on synthetic captures (exact rects, with crossing
  lines and colour-shifted magenta). The fit math was tested in simulation (centred, panned, other zoom anchors).
  Viewer bounds come from a flood-zoom pass because AE's tab strip uses the same grey as the pasteboard.
- Open question: after the first in-AE test, every unlocked layer was still selected. Restore now
  verifies the selection and logs the count, so the next test will show whether the restore is the cause.
- Note: AE runs one script at a time. Outside scripts sent while the panel's JSX is busy trigger an
  "attempt to run a second script" warning. Keep all AE calls during a render inside the panel.

- 2026-10-25: video export (Phase 5) and alpha mode (Phase 6) dropped by request. The panel UI was redone:
  the main view has only the comp info, a round Render button (the "eye", which becomes a progress ring
  and cancel while rendering) and a status line; everything else is under Settings. `tools/preview.html`
  previews the panel in a browser with fake AE and helper responses (serve the project folder over http).

- 2026-10-25: compact one-row panel + Settings in a separate Modeless window (`settings.html`), confirmed
  working in AE. Shared state: `%APPDATA%\Wireframe\settings.json` and `log.txt` (js/store.js);
  the windows talk via CEP events (settingsChanged, settingsOpened, busy, command).

- 2026-10-25: renamed to "Wireframe" (menu, windows, progress box, calibration layer, undo names).
  New default: renders go to a "Wireframe" folder next to the .aep, falling back to the chosen folder if the
  project was never saved.

- 2026-10-26: CEP drops events with an empty extensionId, and hands string data back already decoded;
  both fixed in js/store.js (Test / Restore from the Settings window work). New: Title/Action Safe is
  hidden while rendering. Scripting can't reach it, so calibration detects its mirrored line pairs over the
  marker. The helper's `sendKey` then presses the user's binding (read from the active aeks file, mapped
  through the keyboard layout), the change is kept only if the lines disappear, and it's toggled back on
  restore (flag `safeZonesToggled` in the crash-recovery file). Calibration debug images are no longer saved.

- 2026-10-26: "Show Layer Controls" is also a blind toggle. If controls were already off, the calibration
  toggle turned them on and handles covered the marker (fill 0.76 → error). Calibration now tries both
  states and keeps the one with the clearer marker. The fill check is loosened to 0.5, and a failing
  capture is saved to %APPDATA%\Wireframe\last-calibration-failure.png.

- 2026-10-26: Title/Action Safe pressed the wrong key. AE's shortcut-file names are misleading: plain '
  ("TitleActionGridRotate") toggles the safe zones; Shift+' ("TitleActionSafeToggle") toggles the grid.
  Verified by pressing both through the helper on a non-US keyboard layout. The panel now reads
  TitleActionGridRotate. The helper sends left-hand modifiers with real scan codes and borrows the
  foreground thread's input to activate AE. Activation still fails when AE isn't foreground and the
  run was triggered from outside AE (e.g. CDP); a click in the panel makes AE foreground.

- 2026-10-26: restyled: white, black ink, blue #004dff / red #ce1517, square corners, 2px rules,
  Funnel Display, 800-weight uppercase buttons. The render button is a square block that fills blue
  bottom-up while rendering and turns red (Cancel) on hover.
- 2026-10-26: switched to the dark version of that system (black ground, white ink and rules, checked
  boxes in blue). All colours come from the tokens in css/panel.css.
- 2026-10-26: Settings fits its window. Two-column grid (640 wide, ~530 tall). CEP ignores
  resizeContent / resizeTo for Modeless windows, so settings.js emits 'fitSettings' and the panel's helper
  resizes the AE-owned PLUGPLUG_UI_NATIVE_WINDOW_CLASS_NAME window (matched by client size) with
  SetWindowPos. AE caps the window at the manifest Size unless MaxSize is given (added). A closed
  Settings window is only hidden; the panel emits 'settingsShown' on reopen so it re-fits. Manifest
  geometry is read at AE startup. Confirmed in AE after a restart.
- 2026-10-26 (0.2.0): prepared for sharing. IDs are now com.wireframe.*, the host global is
  WireframeHost, the helper is wireframe-cap.exe and data lives in %APPDATA%\Wireframe (copied once from
  the old CyclopsRedo folder; install-dev.ps1 removes the old com.cyclopsredo install). Helper requests
  time out (a hung helper is killed and restarted), TIFFs are LZW-compressed, the font is bundled, and
  Settings shows Test / Restore results and has Reset. tools/package.ps1 builds the zip to share.
- 2026-10-26: tested 0.2.0 in AE 26.5 (255-frame render, 0.43 s/frame, view restored; Test one frame from
  Settings). tools/package.ps1 now also signs a .zxp with ZXPSignCmd 4.1.3 and a self-signed certificate
  (timestamped via DigiCert). Signing material lives in %APPDATA%\Wireframe\signing, outside the project.
  Not yet tried: installing the .zxp with debug mode off.
- 2026-10-26 (0.2.1): slow frames were saved half-drawn. AE draws layer controls for the new time at once
  and the frame later, so the outlines moving counted as "the frame changed" and a render slower than
  stableMs was caught as new outlines over the old picture. Render now hides layer controls while each
  frame renders, shows them for the capture, and hides them again (grabStable's new untilHash returns as
  soon as the clean frame is back). Only when calibration knows the controls were showing; otherwise the
  old single wait.
- 2026-10-26 (0.2.2): the per-frame toggle brought AE to the front every frame (Show Layer Controls via
  app.executeCommand activates AE; confirmed by watching the foreground window). Now two passes, one
  toggle each: pass 1 with controls hidden renders every frame and keeps 48 px tile hashes of it
  (grabStable tilesSave); pass 2 with controls shown captures, waiting until no tile that differs between
  this frame and the previous one still shows the previous one (tilesExpect/tilesStale). Frames whose
  content doesn't change need no render wait in pass 2. untilHash is gone.
- 2026-10-26 (0.2.3): back to the 0.2.1 per-frame toggle (single pass; AE comes to the front each frame).
  Render first shows a reminder bar to RAM-preview the range so frames are cached and each step is quick;
  Settings > "Remind me to cache the frames first" (cacheReminder) turns it off. Tile hashing removed.
  AE 26.5 menu commands found: "Play Current Preview" (10314) and "Cache Frames When Idle" (10550); there
  is no "Cache Work Area in Background" any more, and no way to read when caching has finished.
- 2026-10-26: a reported ~5 s freeze on closing Settings was AE Auto-Save writing the 31 MB project to
  Google Drive (2.6 s stall logged exactly when an auto-save file was written), not Wireframe.
- 2026-10-26 (0.2.4): the progress box can be dragged (anywhere but Cancel: WM_NCHITTEST -> HTCAPTION, the
  label passes hits through; no activation, so AE keeps focus) and stays where it's dropped while the
  helper runs. The cache reminder is a modal ScriptUI dialog in AE (Render / Cancel / Don't remind me
  again) instead of a bar in the panel; Settings refills itself on settingsChanged so its checkbox follows.

## Architecture
- **CEP panel** (HTML/JS, Node enabled): UI, frame loop, file output, talks to the helper.
- **JSX** (plain source, not JSXBIN): saves and restores AE state, sets time/zoom/maximize, adds/removes the marker layer.
- **wireframe-cap.exe**: C# compiled with Windows' built-in `csc.exe` (.NET Framework 4.8, ships with Win10/11,
  so nothing else to install). Long-running, JSON lines over stdin/stdout:
  `find` → hwnd/rect/dpi, `grab {rect}` → hash, `grabStable {rect, settleMs, timeoutMs}` → png path,
  `quit`. Writes PNGs itself (System.Drawing), so pixels never pass through CEP.
- **ffmpeg** (already installed) for optional video encode.

## Phases
1. **Skeleton**: CEP manifest (AEFT 25+), panel UI, `PlayerDebugMode` dev install script, JSX state
   snapshot/restore in `try/finally` (time, zoom, maximized, fast preview, resolution, selection,
   checkerboard, autosave). Settings: format, mode, range, output folder, quality.
2. **Capture helper**: build `wireframe-cap.exe` with csc, JSON protocol, PrintWindow grab + crop + PNG.
   Stability check: grab every ~40 ms until K identical crops in a row (K≈3), with a minimum wait and timeout.
3. **Calibration + auto-fit**: maximize viewer → add a marker solid (pure magenta, full comp, corner
   fiducials) → grab → locate the exact comp rect → compute fit zoom (`min(vw/cw, vh/ch)` / dpiScale, small
   margin) → set zoom → re-detect the rect → remove the marker. Check the rect again every N frames.
4. **Frame loop**: for each frame, set the time and grab when stable, and log any frames that timed out.
   Show progress and an ETA, and support cancel. Restore AE state at the end.
5. **Composite output**: PNG/JPG/TIFF sequence → optional ffmpeg (H.264 MP4 / ProRes) → optional import into the project.
6. **Overlay + alpha mode**: per frame, two grabs: with layer controls on and off (toggle with the
   "Show Layer Controls" menu command via `app.executeCommand`). Alpha = per-pixel difference, colour = the "on" pass.
   Output PNG with alpha / ProRes 4444. Fallback idea: Wireframe fast preview on a key-coloured comp background.
7. **Polish**: presets, completion sound, reveal folder, packaging as a ZXP or simple installer.

## Risks / to verify
- HiDPI (125/150%) displays: zoom-to-screen-pixel ratio and PrintWindow scaling. Test on a scaled display.
- Exact command id / name for toggling layer controls in AE 26.
- AE redraw differences with GPU off or heavy comps (the stability timeout covers this).
