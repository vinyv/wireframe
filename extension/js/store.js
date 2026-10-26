// Shared by the panel and the Settings window: settings file, log file, and events between the two.
// Each CEP window has its own browser storage, so settings live in a file both can read.
(function () {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const APPDATA = process.env.APPDATA || os.homedir();
  const DATA_DIR = path.join(APPDATA, 'Wireframe');
  const LEGACY_DATA_DIR = path.join(APPDATA, 'CyclopsRedo'); // the folder's name before 0.2.0
  const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
  const PENDING_FILE = path.join(DATA_DIR, 'pending-restore.json');
  const LOG_FILE = path.join(DATA_DIR, 'log.txt');
  const LOG_MAX_LINES = 400;

  // Bring settings and an unfinished restore over from the old folder, once.
  (function migrate() {
    if (fs.existsSync(DATA_DIR) || !fs.existsSync(LEGACY_DATA_DIR)) return;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      for (const name of ['settings.json', 'pending-restore.json']) {
        const from = path.join(LEGACY_DATA_DIR, name);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DATA_DIR, name));
      }
    } catch (e) {}
  })();

  const DEFAULTS = {
    format: 'png',
    range: 'workArea',
    fastPreview: 'off',
    stableMs: 300,
    maxRenderWait: 1500,
    maxZoom: 100,
    edgePadding: 6,
    revealFolder: true,
    selectAllLayers: true,
    fullResolution: true,
    disableAutoSave: true,
    hideSafeZones: true,
    outDir: path.join(os.homedir(), 'Desktop', 'Wireframe'),
    saveNextToProject: true
  };

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {}
    const s = Object.assign({}, DEFAULTS, saved || {});
    delete s.mode; // dropped option
    return s;
  }

  function save(s) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  }

  // The log is kept in a file so the Settings window can show what the panel did. Lines are appended;
  // every so often the file is cut back to the last LOG_MAX_LINES.
  let appendsSinceTrim = Infinity;
  function appendLog(line) {
    try {
      if (appendsSinceTrim >= 50) {
        appendsSinceTrim = 0;
        let lines = [];
        try {
          lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
        } catch (e) {}
        if (lines.length > LOG_MAX_LINES) fs.writeFileSync(LOG_FILE, lines.slice(-LOG_MAX_LINES).join('\n') + '\n');
      }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(LOG_FILE, line + '\n');
      appendsSinceTrim++;
    } catch (e) {}
  }

  function hasPending() {
    return fs.existsSync(PENDING_FILE);
  }

  function readLog() {
    try {
      return fs.readFileSync(LOG_FILE, 'utf8');
    } catch (e) {
      return '';
    }
  }

  // ---- events between the panel and the Settings window (CEP application-wide events) ----

  const EVENT_PREFIX = 'com.wireframe.';

  // CEP silently drops events whose appId / extensionId aren't the sender's real ones (an empty
  // extensionId never arrives anywhere), so fill them in from the host.
  function emit(name, data) {
    const cep = window.__adobe_cep__;
    let appId = 'AEFT';
    try {
      appId = JSON.parse(cep.getHostEnvironment()).appId || appId;
    } catch (e) {}
    cep.dispatchEvent({
      type: EVENT_PREFIX + name,
      scope: 'APPLICATION',
      appId,
      extensionId: cep.getExtensionId(),
      data: JSON.stringify(data === undefined ? null : data)
    });
  }

  function on(name, fn) {
    window.__adobe_cep__.addEventListener(EVENT_PREFIX + name, (event) => {
      // CEP may hand data back already decoded (a sent '"test"' arrives as 'test'), so keep the raw
      // value when it isn't JSON.
      let data = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {}
      }
      fn(data === undefined ? null : data);
    });
  }

  // Reopening a closed Settings window only shows it again (the page stays loaded), so tell it to
  // re-fit its size once it's on screen.
  function openSettingsWindow() {
    window.__adobe_cep__.requestOpenExtension('com.wireframe.settings', '');
    setTimeout(() => emit('settingsShown'), 300);
  }

  window.Store = { DEFAULTS, DATA_DIR, PENDING_FILE, load, save, appendLog, readLog, hasPending, emit, on, openSettingsWindow };
})();
