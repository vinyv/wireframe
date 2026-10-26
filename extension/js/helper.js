// Client for bin/wireframe-cap.exe: one long-running process, JSON lines both ways.
(function () {
  const childProcess = require('child_process');
  const path = require('path');
  const readline = require('readline');

  // How long past a request's own timeoutMs (or this default, for quick commands) to wait for the
  // reply before treating the helper as hung.
  const DEFAULT_TIMEOUT_MS = 30000;
  const TIMEOUT_SLACK_MS = 15000;

  class CaptureHelper {
    constructor(exePath) {
      this.exePath = exePath;
      this.proc = null;
      this.nextId = 1;
      this.pending = new Map();
    }

    get running() {
      return !!this.proc;
    }

    start() {
      if (this.proc) return;
      const proc = childProcess.spawn(this.exePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(line));
      proc.stderr.on('data', (d) => console.warn('[wireframe-cap]', String(d)));
      const fail = (err) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this._rejectAll(err);
      };
      proc.on('error', fail);
      proc.on('exit', (code) => fail(new Error('capture helper exited (' + code + ')')));
      // Writing to a helper that has died (or never started) fails here, not at write().
      proc.stdin.on('error', (e) => fail(new Error('capture helper is not running: ' + e.message)));
    }

    _rejectAll(err) {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    }

    _onLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        console.warn('[wireframe-cap] bad line', line);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'helper error'));
    }

    request(cmd, args) {
      this.start();
      const id = this.nextId++;
      const msg = Object.assign({ id, cmd }, args || {});
      const timeoutMs = (args && args.timeoutMs ? args.timeoutMs : DEFAULT_TIMEOUT_MS) + TIMEOUT_SLACK_MS;
      return new Promise((resolve, reject) => {
        // A helper that stops answering would leave the panel busy forever (and AE unrestored), so
        // give up on it and start a fresh one on the next request.
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('the capture helper stopped responding (' + cmd + ')'));
          this.kill();
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
      });
    }

    stop() {
      if (!this.proc) return;
      const proc = this.proc;
      try {
        proc.stdin.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n');
      } catch (e) {}
      setTimeout(() => {
        try {
          proc.kill();
        } catch (e) {}
      }, 1000);
      this.proc = null;
      this._rejectAll(new Error('capture helper stopped'));
    }

    kill() {
      if (!this.proc) return;
      const proc = this.proc;
      this.proc = null;
      try {
        proc.kill();
      } catch (e) {}
      this._rejectAll(new Error('capture helper was restarted'));
    }
  }

  window.CaptureHelper = CaptureHelper;
  window.defaultHelperPath = () => path.join(CEP.extensionPath(), 'bin', 'wireframe-cap.exe');
})();
