// Wireframe panel: render button, AE state save/restore, capture helper wiring.
// Settings live in their own window (settings.html); both share js/store.js.
(function () {
  const fs = require('fs');
  const path = require('path');

  const DATA_DIR = Store.DATA_DIR;
  const PENDING_FILE = Store.PENDING_FILE;

  const $ = (id) => document.getElementById(id);
  const helper = new CaptureHelper(defaultHelperPath());
  let busy = false;

  // ---- log -------------------------------------------------------------------------------

  // Detailed log, shown in the Settings window. status() is the one line on the panel.
  function log(msg) {
    Store.appendLog('[' + new Date().toTimeString().slice(0, 8) + '] ' + msg);
  }

  // Also shown in the Settings window, where Test / Restore are clicked.
  function status(msg, isError) {
    $('status').textContent = msg;
    $('status').classList.toggle('error', !!isError);
    if (isError) log('Error: ' + msg);
    Store.emit('status', { msg, isError: !!isError });
  }

  const errorText = (e) => {
    const msg = (e && e.message) || String(e);
    return msg.charAt(0).toUpperCase() + msg.slice(1);
  };

  // Opens a folder in Explorer, or the folder with `file` selected.
  function reveal(folder, file) {
    const args = file ? ['/select,', file] : [folder];
    const proc = require('child_process').spawn('explorer', args, { detached: true, stdio: 'ignore' });
    proc.on('error', (e) => log('Could not open ' + folder + ': ' + e.message));
    proc.unref();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Local time as YYYY-MM-DD_HH-MM-SS, safe for filenames.
  function localStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' +
      p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  }

  // ---- settings (edited in the Settings window) ------------------------------------------

  let settings = Store.load();

  // ---- pending snapshot (survives a crash or a closed panel) -----------------------------

  function savePending(snapshot) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(snapshot, null, 2));
  }

  function readPending() {
    try {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  function clearPending() {
    try {
      fs.unlinkSync(PENDING_FILE);
    } catch (e) {}
    $('restore-banner').classList.add('hidden');
  }

  // ---- Title/Action Safe (a viewer shortcut; scripting can't reach it) ------------------------

  // AE key names in the shortcut file -> the character on the key.
  const KEY_CHARS = {
    SingleQuote: "'", DoubleQuote: '"', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    Semicolon: ';', Colon: ':', Minus: '-', Equal: '=', Plus: '+', LBracket: '[', RBracket: ']',
    Grave: '`', Tilde: '~', Space: ' '
  };

  // The user's binding for Title/Action Safe, read from AE's active shortcut file. Despite the names,
  // "TitleActionGridRotate" (plain ') toggles the safe zones and "TitleActionSafeToggle" (Shift+')
  // toggles the grid (checked in AE 26.5).
  function safeZonesShortcut() {
    let binding = '(SingleQuote)'; // AE's default
    try {
      const env = JSON.parse(window.__adobe_cep__.getHostEnvironment());
      const ver = String(env.appVersion).split('.').slice(0, 2).join('.');
      const dir = path.join(process.env.APPDATA, 'Adobe', 'After Effects', ver);
      const prefs = fs.readFileSync(path.join(dir, 'Adobe After Effects ' + ver + ' Prefs.txt'), 'latin1');
      const fileMatch = /"Shortcut File Location"\s*=\s*"([^"]+)"/.exec(prefs);
      const keys = fs.readFileSync(path.join(dir, 'aeks', fileMatch ? fileMatch[1] : 'After Effects Default.txt'), 'latin1');
      const m = /"TitleActionGridRotate"\s*=\s*"((?:\([^)]*\))*)"/.exec(keys);
      if (m) binding = m[1];
    } catch (e) {
      log('Could not read the shortcut file, assuming \' for Title/Action Safe.');
    }
    const first = /\(([^)]*)\)/.exec(binding);
    if (!first) return null; // no key assigned
    const parts = first[1].split('+');
    const name = parts.pop();
    const uni = /^Ux([0-9A-Fa-f]{4})$/.exec(name);
    const char = uni ? String.fromCharCode(parseInt(uni[1], 16)) : KEY_CHARS[name] || (name.length === 1 ? name.toLowerCase() : null);
    if (!char) return null;
    return { char, shift: parts.includes('Shift'), ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt') };
  }

  async function toggleSafeZones(compId) {
    const key = safeZonesShortcut();
    if (!key) throw new Error('Title/Action Safe has no keyboard shortcut in AE');
    await CEP.jsx('focusViewer', compId);
    await helper.request('sendKey', key);
  }

  async function restoreFrom(snapshot) {
    if (snapshot.safeZonesToggled) {
      try {
        await toggleSafeZones(snapshot.compId);
        await sleep(150);
        log('Title/Action Safe turned back on.');
      } catch (e) {
        status('Title/Action Safe was left off: ' + e.message + '. Press \' in the viewer to show it.', true);
      }
    }
    const res = await CEP.jsx('restore', snapshot);
    if (res.problems.length) status('AE view restored, except: ' + res.problems.join('; '), true);
    else log('AE view restored.');
    if (res.selection) log('Selection: ' + res.selection.actual + ' layer(s) selected, as before.');
    clearPending();
  }

  // ---- AE info ---------------------------------------------------------------------------

  let currentComp = null;

  async function refresh() {
    if (busy) return;
    try {
      currentComp = await CEP.jsx('info');
    } catch (e) {
      currentComp = null;
    }
    const c = currentComp;
    // Long names get cut off in a narrow panel; the tooltips show the full text.
    setText('comp-name', c ? c.name : 'No composition');
    setText('comp-meta', c ? c.width + '×' + c.height + ', ' + +c.frameRate.toFixed(3) + ' fps' : '');
    updatePlan();
  }

  function setText(id, text) {
    $(id).textContent = text;
    $(id).title = text;
  }

  function frameRange(c, range) {
    const fd = c.frameDuration;
    const first = range === 'comp' ? 0 : Math.round(c.workAreaStart / fd);
    const count = Math.round((range === 'comp' ? c.duration : c.workAreaDuration) / fd);
    return { first, count };
  }

  // The line under the eye: what Render will do right now.
  function updatePlan() {
    if (busy) return;
    const c = currentComp;
    $('eye').disabled = !c;
    if (!c) {
      setText('plan', 'Open a comp first');
      return;
    }
    const range = settings.range;
    const { count } = frameRange(c, range);
    setText('plan', (range === 'comp' ? 'Whole comp, ' : 'Work area, ') + count + (count === 1 ? ' frame' : ' frames'));
  }

  // ---- actions ---------------------------------------------------------------------------

  // While busy the eye becomes the cancel button and shows a short progress label; the detail goes
  // on the info line next to it (where "Work area, N frames" sits when idle).
  let eyeLabel = 'Render';
  let eyeHover = false;

  function paintEye() {
    $('eye-label').textContent = busy && eyeHover ? 'Cancel' : eyeLabel;
  }

  function setEye(label, detail) {
    eyeLabel = label;
    paintEye();
    if (busy && detail != null) setText('plan', detail);
  }

  function setBusy(b) {
    busy = b;
    $('eye').classList.toggle('busy', b);
    $('eye').setAttribute('aria-label', b ? 'Cancel render' : 'Render');
    $('restore-pending').disabled = b;
    Store.emit('busy', b);
    if (b) setEye('…', 'Getting the viewer ready');
    else {
      setEye('Render');
      updatePlan();
    }
  }

  function setProgress(done, total, etaSec) {
    $('eye-fill').style.transform = 'scaleY(' + (total ? done / total : 0) + ')';
    if (total) {
      setEye(Math.floor((done / total) * 100) + '%',
        'Frame ' + done + ' of ' + total + (etaSec != null && done ? ', ' + formatDuration(etaSec) + ' left' : ''));
    }
  }

  function formatDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? m + 'm ' + String(s).padStart(2, '0') + 's' : s + 's';
  }

  const safeName = (s) => s.replace(/[\\/:*?"<>|\t\r\n]+/g, '_').trim() || 'comp';

  function prepSettings(s) {
    return {
      fastPreview: s.fastPreview,
      fullResolution: s.fullResolution,
      selectAllLayers: s.selectAllLayers,
      disableAutoSave: s.disableAutoSave,
      hideCheckerboard: true,
      maximize: true
    };
  }

  // Where output goes: a "Wireframe" folder next to the .aep, or the chosen folder when that's off or
  // the project has never been saved (there is no project folder yet).
  function outputDir(s, comp) {
    if (!s.saveNextToProject) return s.outDir;
    if (comp.projectFolder) return path.join(comp.projectFolder, 'Wireframe');
    log('Project not saved yet, so saving to ' + s.outDir + ' instead of next to it.');
    return s.outDir;
  }

  // Prepares AE, auto-fits the comp, runs work(ctx), and always restores AE afterwards.
  // ctx: { s, comp, fit, win, stamp, outDir, onState }
  async function captureSession(work) {
    if (busy) return;
    setBusy(true);
    const s = (settings = Store.load());
    const stamp = localStamp();
    let prepared = null;
    try {
      await helper.request('resetCancel');
      status('');
      prepared = await CEP.jsx('prepare', prepSettings(s));
      savePending(prepared.snapshot);
      log('Prepared "' + prepared.comp.name + '" (viewer maximized).');
      await sleep(400);

      const win = await helper.request('find');
      log('AE window ' + win.size.join('×') + ' @ ' + win.dpi + ' dpi');

      const snapshot = prepared.snapshot;
      const flags = {}; // temporary view changes that need undoing, mirrored to the crash-recovery file
      const outDir = outputDir(s, prepared.comp);
      // Keeps the crash-recovery file in step with temporary view changes.
      const onState = (patch) => savePending(Object.assign({}, snapshot, Object.assign(flags, patch)));
      const t0 = Date.now();
      setEye('…', 'Fitting the comp to the viewer');
      const fit = await Calibrate.calibrate({
        helper,
        comp: prepared.comp,
        settings: s,
        log,
        onState,
        toggleSafeZones: () => toggleSafeZones(prepared.comp.id)
      });
      log('Calibrated in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

      await work({ s, comp: prepared.comp, fit, win, stamp, outDir, onState });
    } catch (e) {
      status(errorText(e), true);
    } finally {
      helper.request('overlay', { hide: true }).catch(() => {});
      if (prepared) {
        try {
          // The pending file is the source of truth: it includes a layer-controls toggle left over
          // if calibration failed before it could undo it.
          await restoreFrom(readPending() || prepared.snapshot);
        } catch (e) {
          status('Could not restore the AE view: ' + errorText(e) + '. Use Settings > Restore AE view.', true);
        }
      }
      setProgress(null);
      setBusy(false);
    }
  }

  // Grabs the current frame cropped to the comp.
  function testCapture() {
    return captureSession(async ({ s, fit, stamp, outDir }) => {
      const out = path.join(outDir, 'wireframe-test-' + stamp + '.' + s.format);
      const r = await helper.request('grabStable', { out, rect: fit.rect, stableMs: s.stableMs });
      log('Saved ' + out + ' ' + r.size.join('×') + ' (' + r.grabs + ' grabs, ' + r.ms + ' ms' + (r.timedOut ? ', TIMED OUT' : '') + ')');
      status('Test frame saved: ' + path.basename(out) + ', ' + r.size.join('×') + '.');
      if (s.revealFolder) reveal(outDir, out);
    });
  }

  // Showing or hiding layer controls redraws an already-rendered frame, so it lands quickly; if the
  // picture hasn't changed by then, there were no controls to draw.
  const CONTROLS_WAIT_MS = 500;

  // Steps through the range frame by frame and saves each one cropped to the comp.
  //
  // AE draws layer controls for the new time at once, but the frame itself can take much longer to
  // render. With controls showing, the first change after a time step is just the outlines moving, and
  // a slow frame would be saved as new outlines over the old picture. So, when the controls' state is
  // known, each frame renders with them hidden (only the finished frame can change the picture) and
  // they're shown just for the capture. Toggling them is a menu command, which brings AE to the front
  // every frame; the cache reminder before a render is there so that's quick.
  function render() {
    return captureSession(async ({ s, comp, fit, stamp, outDir, onState }) => {
      const { first, count } = frameRange(comp, s.range);
      const base = safeName(comp.name);
      const folder = path.join(outDir, base + '_' + stamp);
      fs.mkdirSync(folder, { recursive: true });
      log('Rendering ' + count + ' frames (' + first + '–' + (first + count - 1) + ') to ' + folder);

      const wait = (opts) => helper.request('grabStable', Object.assign({
        rect: fit.rect,
        stableMs: s.stableMs,
        timeoutMs: Math.max(30000, s.maxRenderWait * 4)
      }, opts));
      let hidden = false;
      const setControlsHidden = async (hide) => {
        if (hide === hidden) return;
        if (!(await CEP.jsx('toggleLayerControls')).toggled) throw new Error('could not toggle layer controls');
        hidden = hide;
        onState({ layerControlsToggled: hide });
      };
      const split = fit.controls === 'shown';
      if (fit.controls === 'unknown') log('Layer controls state unknown, so frames that render slowly may be saved before they finish.');

      // Hash of the current picture, so the first frame waits for AE to actually redraw.
      let prevHash;
      if (split) {
        await setControlsHidden(true);
        prevHash = (await wait({ changeTimeoutMs: CONTROLS_WAIT_MS })).hash;
      } else {
        prevHash = (await helper.request('grab', { rect: fit.rect })).hash;
      }
      const slow = [];
      const loopStart = Date.now();
      let done = 0;
      setProgress(0, count);
      status('Rendering at ' + fit.rect[2] + '×' + fit.rect[3] + '. Esc in AE cancels.');

      for (let i = 0; i < count; i++) {
        const frame = first + i;
        const set = await CEP.jsx('setFrame', comp.id, frame);
        if (set.frame !== frame) log('Warning: AE landed on frame ' + set.frame + ' instead of ' + frame);

        const out = path.join(folder, base + '_' + String(frame).padStart(5, '0') + '.' + s.format);
        let r;
        if (split) {
          // Rendered frame first, without controls; then the controls over it, saved; then hide them
          // again and wait for the clean frame to be back on screen before stepping on.
          const clean = await wait({ prevHash, changeTimeoutMs: s.maxRenderWait });
          if (clean.cancel) break;
          await setControlsHidden(false);
          r = await wait({ out, prevHash: clean.hash, changeTimeoutMs: CONTROLS_WAIT_MS });
          await setControlsHidden(true);
          if (r.cancel) break;
          await wait({ prevHash: r.hash, untilHash: clean.hash, changeTimeoutMs: CONTROLS_WAIT_MS });
          prevHash = clean.hash;
          if (clean.timedOut || r.timedOut) slow.push(frame);
        } else {
          r = await wait({ out, prevHash, changeTimeoutMs: s.maxRenderWait });
          if (r.cancel) break;
          prevHash = r.hash;
          if (r.timedOut) slow.push(frame);
        }
        done++;

        const elapsed = (Date.now() - loopStart) / 1000;
        const eta = (elapsed / done) * (count - done);
        setProgress(done, count, eta);
        helper
          .request('overlay', { text: 'Wireframe · frame ' + done + ' / ' + count + ' · ' + formatDuration(eta) + ' left · Esc to cancel' })
          .catch(() => {});
      }

      await setControlsHidden(false);

      const secs = (Date.now() - loopStart) / 1000;
      log('Done: ' + done + ' frames in ' + formatDuration(secs) + ' (' + (done ? (secs / done).toFixed(2) : '0') + ' s/frame)');
      if (slow.length) log('Frames that never settled (check them): ' + slow.join(', '));
      let summary = done < count
        ? 'Cancelled after ' + done + ' of ' + count + ' frames.'
        : 'Rendered ' + done + ' frames in ' + formatDuration(secs) + '.';
      if (slow.length) summary += ' ' + slow.length + (slow.length === 1 ? ' frame' : ' frames') + ' may be half-drawn; see the log.';
      status(summary);
      if (done && s.revealFolder) reveal(folder);
    });
  }

  async function cancel() {
    setEye('…', 'Stopping after this frame');
    try {
      await helper.request('cancel');
    } catch (e) {}
  }

  // Uncached frames make every render step slow (and AE comes to the front each frame), so a render
  // first asks, in a dialog in AE, to RAM-preview the range, unless that's turned off in Settings.
  let asking = false;
  async function onEye() {
    if (busy) return cancel();
    if (asking) return;
    if (Store.load().cacheReminder) {
      asking = true;
      let answer;
      try {
        answer = await CEP.jsx('cacheReminder');
      } catch (e) {
        log('Cache reminder failed: ' + errorText(e));
        answer = { render: true };
      } finally {
        asking = false;
      }
      if (answer.stopReminding) {
        const s = Store.load();
        s.cacheReminder = false;
        Store.save(s);
        Store.emit('settingsChanged');
      }
      if (!answer.render) return;
    }
    render();
  }

  async function manualRestore() {
    const snap = readPending();
    if (!snap) {
      status('Nothing to restore: no render left AE changed.');
      return;
    }
    setBusy(true);
    try {
      await restoreFrom(snap);
      status('AE view restored.');
    } catch (e) {
      status('Could not restore the AE view: ' + errorText(e), true);
    } finally {
      setBusy(false);
    }
  }

  // ---- init ------------------------------------------------------------------------------

  function init() {
    $('open-settings').addEventListener('click', Store.openSettingsWindow);
    $('eye').addEventListener('click', onEye);
    $('eye').addEventListener('mouseenter', () => { eyeHover = true; paintEye(); });
    $('eye').addEventListener('mouseleave', () => { eyeHover = false; paintEye(); });
    // Keep the comp info current without a Refresh button: re-read it when the pointer comes back.
    let lastRefresh = 0;
    const refreshSoon = () => {
      if (Date.now() - lastRefresh < 800) return;
      lastRefresh = Date.now();
      refresh();
    };
    document.body.addEventListener('mouseenter', refreshSoon);
    window.addEventListener('focus', refreshSoon);
    $('restore-pending').addEventListener('click', manualRestore);

    // From the Settings window.
    Store.on('settingsChanged', () => {
      settings = Store.load();
      updatePlan();
    });
    Store.on('settingsOpened', () => Store.emit('busy', busy));
    Store.on('fitSettings', (sizes) => helper.request('resizeWindow', { sizes }).catch(() => {}));
    Store.on('command', (name) => {
      if (busy) return;
      if (name === 'test') testCapture();
      if (name === 'restore') manualRestore();
    });
    window.addEventListener('beforeunload', () => helper.stop());

    if (readPending()) $('restore-banner').classList.remove('hidden');
    // AE evaluates the manifest's ScriptPath once; reload it so a reinstalled host.jsx takes effect
    // when the panel is reopened, without restarting AE.
    const hostPath = path.join(CEP.extensionPath(), 'jsx', 'host.jsx').replace(/\\/g, '/');
    CEP.evalScript('$.evalFile(' + JSON.stringify(hostPath) + ')').then(refresh);
    helper
      .request('ping')
      .then((r) => log('Capture helper ' + r.version + ' ready.'))
      .catch((e) => status('The capture helper did not start: ' + e.message, true));
  }

  init();
})();
