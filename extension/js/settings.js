// Settings window. Edits go straight to the shared settings file; the panel is told so it can update
// the "Work area, N frames" line. Test / Restore are run by the panel, which owns the capture helper.
(function () {
  const $ = (id) => document.getElementById(id);
  const KEYS = Object.keys(Store.DEFAULTS);

  function fill(s) {
    for (const k of KEYS) {
      const el = $(k);
      if (el.type === 'checkbox') el.checked = !!s[k];
      else el.value = s[k];
    }
    syncSegments();
    syncFolder();
  }

  // With "next to the project" on, the folder is only a fallback for unsaved projects.
  function syncFolder() {
    const nextToProject = $('saveNextToProject').checked;
    $('folder-field').classList.toggle('secondary', nextToProject);
    $('folder-hint').classList.toggle('hidden', !nextToProject);
  }

  function read() {
    const s = {};
    for (const k of KEYS) {
      const el = $(k);
      if (el.type === 'checkbox') s[k] = el.checked;
      else if (el.type === 'number') s[k] = clampNumber(el, Store.DEFAULTS[k]);
      else s[k] = el.value;
    }
    return s;
  }

  // Empty or unreadable falls back to the default; anything else is kept inside the field's min/max
  // (0 is a real value, e.g. no edge padding). The field shows what was saved.
  function clampNumber(el, def) {
    let v = el.value.trim() === '' ? NaN : Number(el.value);
    if (!isFinite(v)) v = def;
    if (el.min !== '') v = Math.max(Number(el.min), v);
    if (el.max !== '') v = Math.min(Number(el.max), v);
    el.value = v;
    return v;
  }

  function commit() {
    try {
      Store.save(read());
    } catch (e) {
      return;
    }
    Store.emit('settingsChanged');
  }

  // Segmented controls write into the hidden input named by data-for.
  function syncSegments() {
    document.querySelectorAll('.seg').forEach((seg) => {
      const value = $(seg.dataset.for).value;
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === value)));
    });
  }

  function bindSegments() {
    document.querySelectorAll('.seg').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        $(seg.dataset.for).value = b.dataset.v;
        syncSegments();
        commit();
      });
    });
  }

  // While the log is open, keep it in step with the panel's log file.
  let logTimer = null;
  function showLog() {
    const el = $('log');
    const text = Store.readLog();
    if (el.textContent !== text) {
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      el.textContent = text || 'Nothing logged yet.';
      if (atEnd) el.scrollTop = el.scrollHeight;
    }
  }

  // Size the window to its content so nothing scrolls. CEP ignores resize requests from the page, so
  // the panel's capture helper does it. Too narrow for two columns: widen first, and the resize that
  // follows re-fits the height at the new width.
  const TWO_COLUMNS = 640;
  function fitWindow() {
    const w = window.innerWidth, h = window.innerHeight;
    const pad = parseFloat(getComputedStyle(document.querySelector('.settings')).paddingBottom) || 0;
    const want = [w < 520 ? TWO_COLUMNS : w, Math.ceil($('settings-grid').offsetHeight + pad)];
    if (Math.abs(want[0] - w) > 2 || Math.abs(want[1] - h) > 2) Store.emit('fitSettings', [w, h].concat(want));
  }

  function setBusy(busy) {
    $('test').disabled = !!busy;
    // Restore only has something to do after a render left AE changed.
    $('restore').disabled = !!busy || !Store.hasPending();
  }

  // The panel's status line, repeated here so Test / Restore show their result where they were clicked.
  function showStatus(s) {
    const el = $('tool-status');
    el.textContent = (s && s.msg) || '';
    el.classList.toggle('error', !!(s && s.isError));
    fitWindow();
  }

  function init() {
    fill(Store.load());
    bindSegments();
    document.querySelectorAll('input').forEach((el) => el.addEventListener('change', commit));
    $('saveNextToProject').addEventListener('change', () => { syncFolder(); fitWindow(); });
    $('browse').addEventListener('click', () => {
      const dir = CEP.chooseFolder('Choose output folder', $('outDir').value);
      if (dir) {
        $('outDir').value = dir;
        commit();
      }
    });
    $('test').addEventListener('click', () => Store.emit('command', 'test'));
    $('restore').addEventListener('click', () => Store.emit('command', 'restore'));
    $('reset').addEventListener('click', () => {
      fill(Store.DEFAULTS);
      commit();
    });

    const details = document.querySelector('details');
    details.addEventListener('toggle', () => {
      clearInterval(logTimer);
      if (details.open) {
        showLog();
        $('log').scrollTop = $('log').scrollHeight;
        logTimer = setInterval(showLog, 1000);
      }
      fitWindow();
    });

    // Widths change how text wraps; fonts change line heights.
    window.addEventListener('resize', () => requestAnimationFrame(fitWindow));
    document.fonts.ready.then(fitWindow);
    Store.on('settingsShown', () => {
      setBusy($('test').disabled);
      fitWindow();
    });
    fitWindow();

    Store.on('busy', setBusy);
    Store.on('status', showStatus);
    setBusy(false);
    Store.emit('settingsOpened'); // the panel answers with its busy state
  }

  init();
})();
