// Minimal bridge to the CEP host (replaces Adobe's CSInterface.js for the few calls we need).
(function () {
  const cep = window.__adobe_cep__;

  function extensionPath() {
    let p = decodeURI(cep.getSystemPath('extension'));
    return p.replace(/^file:\/{2,3}/, '');
  }

  function evalScript(script) {
    return new Promise((resolve) => cep.evalScript(script, resolve));
  }

  // Calls WireframeHost.<fn>(...args) in host.jsx. Host functions return a JSON string {ok, result | error}.
  async function jsx(fn, ...args) {
    const call = 'WireframeHost.' + fn + '(' + args.map((a) => JSON.stringify(a)).join(',') + ')';
    const raw = await evalScript(call);
    let res;
    try {
      res = JSON.parse(raw);
    } catch (e) {
      // CEP answers 'EvalScript error.' when the script threw, and 'undefined' when host.jsx isn't
      // loaded or AE is blocked (usually by an open dialog).
      throw new Error('After Effects did not run the panel\'s ' + fn + ' script (' + raw + '). ' +
        'Close any open dialog in AE and try again; if it keeps happening, reopen the Wireframe panel.');
    }
    if (!res.ok) throw new Error(res.error || 'host call failed: ' + fn);
    return res.result;
  }

  function chooseFolder(title, initial) {
    const r = window.cep.fs.showOpenDialogEx(false, true, title, initial || '');
    return r.err === 0 && r.data && r.data.length ? r.data[0] : null;
  }

  window.CEP = { extensionPath, evalScript, jsx, chooseFolder };
})();
