// Auto-fit: find the largest viewer zoom at which the whole comp is visible, and where it sits on screen.
//
// With a magenta marker layer over the comp:
//   1. Measure the comp's on-screen rect at two small zooms. Every edge moves linearly with zoom
//      (whatever point AE zooms around, panned or not, any display scaling), so two samples give each
//      edge as a line.
//   2. Use those lines to pick a zoom where the comp must overflow the whole window, and measure there:
//      the marker floods the viewer, so its rect is the viewer area. (The pasteboard grey can't be used:
//      AE's tab strip is the same colour.)
//   3. Take a third sample close to the fit so the final extrapolation is short (1 px rounding at tiny
//      zooms would otherwise cost ~0.5% of size), solve for the largest zoom keeping all four edges inside
//      the viewer, set it, and re-measure to verify.
(function () {
  const EDGE_MARGIN = 2; // px of pasteboard kept around the comp
  const FLOOD_OVERSHOOT = 40; // px the predicted comp must extend past the window on every side
  const MAX_AE_ZOOM = 32;

  const EDGE_KEYS = ['L', 'T', 'R', 'B'];
  const edges = (r) => ({ L: r[0], T: r[1], R: r[0] + r[2], B: r[1] + r[3] });

  // Edge positions as lines in zoom, from two samples {zoom, rect}.
  function edgeModel(a, b) {
    const ea = edges(a.rect), eb = edges(b.rect), dz = b.zoom - a.zoom;
    const slope = {};
    for (const k of EDGE_KEYS) slope[k] = (eb[k] - ea[k]) / dz;
    return {
      slope,
      at: (k, z) => ea[k] + slope[k] * (z - a.zoom),
      // Zoom at which edge k reaches position p (Infinity if it never does).
      reach: (k, p) => (slope[k] === 0 ? Infinity : a.zoom + (p - ea[k]) / slope[k])
    };
  }

  // Largest zoom keeping every edge at least `margin` px inside the viewer.
  function fitZoom(a, b, viewer, margin = EDGE_MARGIN) {
    const m = edgeModel(a, b), v = edges(viewer);
    const limit = (k, bound, mustBeAtLeast) => {
      const s = m.slope[k];
      if (mustBeAtLeast ? s >= 0 : s <= 0) return Infinity; // moving away from that viewer edge
      return m.reach(k, bound);
    };
    return Math.min(
      limit('L', v.L + margin, true),
      limit('T', v.T + margin, true),
      limit('R', v.R - margin, false),
      limit('B', v.B - margin, false)
    );
  }

  // Smallest zoom at which the comp is predicted to overflow the whole window on every side.
  function floodZoom(a, b, winW, winH) {
    const m = edgeModel(a, b);
    if (!(m.slope.L < 0 && m.slope.T < 0 && m.slope.R > 0 && m.slope.B > 0)) return null;
    return Math.max(
      m.reach('L', -FLOOD_OVERSHOOT),
      m.reach('T', -FLOOD_OVERSHOOT),
      m.reach('R', winW + FLOOD_OVERSHOOT),
      m.reach('B', winH + FLOOD_OVERSHOOT)
    );
  }

  // Title/Action Safe draws two nested rectangles: long lines in mirrored pairs (f and 1 - f) on both
  // axes. A single guide or the centre cross doesn't look like that.
  function hasSafeZones(lines) {
    if (!lines) return false;
    const mirrored = (list) => list.some((f) => f > 0.01 && f < 0.3 && list.some((g) => Math.abs(g - (1 - f)) < 0.02));
    return mirrored(lines.h || []) && mirrored(lines.v || []);
  }

  function inside(rect, viewer, margin = 1) {
    const r = edges(rect), v = edges(viewer);
    return r.L >= v.L + margin && r.T >= v.T + margin && r.R <= v.R - margin && r.B <= v.B - margin;
  }

  const pad = (r, p) => [r[0] - p, r[1] - p, r[2] + 2 * p, r[3] + 2 * p];

  // Fully inside the window image (not touching its border), i.e. not clipped by anything.
  function clearOfWindow(rect, imageSize) {
    const r = edges(rect);
    return r.L > 0 && r.T > 0 && r.R < imageSize[0] && r.B < imageSize[1];
  }

  // opts: { helper, comp (from host info), settings, log, onState?, toggleSafeZones? }
  // onState(patch) records view changes a crash would leave behind ({ layerControlsToggled },
  // { safeZonesToggled }). toggleSafeZones() presses AE's Title/Action Safe shortcut.
  // Returns { zoom, rect: [x, y, w, h] window-relative crop (comp + padding), compRect, viewer, controls }. Leaves the viewer at that zoom.
  // controls: 'shown' / 'hidden' = the state of View > Show Layer Controls when it could be told, else 'unknown'.
  async function calibrate({ helper, comp, settings, log, onState, toggleSafeZones }) {
    const stableMs = Math.max(200, settings.stableMs);
    // Pasteboard kept around the comp in the crop: layer handles and bounding boxes on the comp
    // boundary are centred on it, so without padding half of them is cut off.
    const padding = Math.max(0, Math.round(settings.edgePadding || 0));
    let hash = (await helper.request('grab')).hash;
    const cal = await CEP.jsx('calibrationStart', comp.id);
    if (onState) onState({ layerControlsToggled: !!cal.controlsToggled });
    if (!cal.controlsToggled) log('Could not hide layer controls; deselected layers instead.');
    let controls = 'unknown';

    const measureAt = async (label, zoom) => {
      const set = await CEP.jsx('setZoom', comp.id, zoom, true);
      const applied = set.zoom;
      if (!set.maximized) log('  Warning: the viewer is not maximized');
      const failOut = require('path').join(Store.DATA_DIR, 'last-calibration-failure.png');
      let m;
      try {
        m = await helper.request('measure', { prevHash: hash, stableMs, changeTimeoutMs: 2000, timeoutMs: 20000, failOut });
      } catch (e) {
        log('The capture that failed is saved at ' + failOut);
        throw e;
      }
      hash = m.hash;
      log('  ' + label + ' @ ' + (applied * 100).toFixed(2) + '%: comp at ' + m.comp.join(',') + ', ' +
        Math.round(m.fill * 100) + '% clear' + (m.timedOut ? ' (never settled)' : ''));
      return { zoom: applied, rect: m.comp, imageSize: m.imageSize, lines: m.lines, fill: m.fill };
    };

    try {
      // 1. Two small zooms: the whole comp visible, edges unclipped.
      const z1 = Math.min(0.2, 400 / Math.max(comp.width, comp.height));
      let a = await measureAt('small', z1);

      // Show Layer Controls is a blind toggle too: if controls were already off, calibrationStart just
      // turned them on and every selected layer's handles cover the marker. Try the other state and
      // keep whichever leaves the marker clearer.
      if (cal.controlsToggled) {
        await CEP.jsx('toggleLayerControls');
        const other = await measureAt('controls-check', a.zoom);
        if (other.fill > a.fill + 0.005) {
          cal.controlsToggled = false; // back to the user's own state; nothing to undo later
          if (onState) onState({ layerControlsToggled: false });
          log('Layer controls were already hidden; left them that way.');
          controls = 'hidden';
          a = other;
        } else {
          await CEP.jsx('toggleLayerControls');
          controls = 'shown';
          a = await measureAt('small', a.zoom);
        }
      }

      // Title/Action Safe would be captured in every frame. Scripting can't read or set it, so: seen
      // over the marker? Press its shortcut, and keep the change only if the lines really went away.
      if (settings.hideSafeZones && toggleSafeZones && hasSafeZones(a.lines)) {
        try {
          await toggleSafeZones();
          const check = await measureAt('safe-off', a.zoom);
          if (hasSafeZones(check.lines)) {
            await toggleSafeZones(); // the key went somewhere else; undo it
            log('Could not hide Title/Action Safe; it will show in the frames.');
          } else {
            if (onState) onState({ safeZonesToggled: true });
            log('Hid Title/Action Safe for the render.');
            a = check;
          }
        } catch (e) {
          log('Could not hide Title/Action Safe: ' + e.message);
        }
      }

      const b = await measureAt('small2', z1 * 1.6);
      if (!clearOfWindow(a.rect, a.imageSize) || !clearOfWindow(b.rect, b.imageSize)) {
        throw new Error('the comp is cut off even at low zoom; center it in the viewer (double-click the Hand tool)');
      }
      const [winW, winH] = a.imageSize;

      // 2. Flood: zoom until the comp must cover the whole window; the marker rect is then the viewer.
      const zf = floodZoom(a, b, winW, winH);
      if (zf === null) throw new Error('comp did not grow evenly when zooming in; is the viewer visible?');
      if (zf * 1.1 > MAX_AE_ZOOM) throw new Error('comp too small to flood the viewer within AE\'s max zoom');
      const flood = await measureAt('flood', zf * 1.1);
      const viewer = flood.rect;
      if (!inside(a.rect, viewer)) throw new Error('viewer measurement looks wrong (' + viewer.join(',') + ')');
      log('Viewer area ' + viewer[2] + '×' + viewer[3] + ' px at ' + viewer[0] + ',' + viewer[1]);
      if (viewer[2] < winW * 0.6 && viewer[3] < winH * 0.6) {
        log('Warning: the viewer covers only part of the AE window; is it maximized?');
      }

      // 3. Sample near the fit (must be unclipped), then solve from the small sample and this one.
      const rough = fitZoom(a, b, viewer);
      let zc = Math.max(b.zoom * 1.2, rough * 0.92);
      let c = await measureAt('near-fit', zc);
      for (let i = 0; i < 3 && !inside(c.rect, viewer); i++) {
        zc = (b.zoom + zc) / 2;
        c = await measureAt('near-fit', zc);
      }
      const near = inside(c.rect, viewer) ? c : b;
      const model = edgeModel(a, near);
      let zoom = fitZoom(a, near, viewer, padding + EDGE_MARGIN);

      const reserve = 2 * (padding + EDGE_MARGIN);
      const centredFit = Math.min((viewer[2] - reserve) / (c.rect[2] / c.zoom), (viewer[3] - reserve) / (c.rect[3] / c.zoom));
      if (zoom < centredFit * 0.95) {
        log('The comp is off-centre in the viewer, so it fits at ' + (zoom * 100).toFixed(1) + '% instead of ~' +
          (centredFit * 100).toFixed(1) + '%. Double-click the Hand tool to center it for a bigger capture.');
      }
      log('Scale: ' + (c.rect[2] / c.zoom / comp.width).toFixed(3) + ' screen px per comp px at 100%');
      const cap = (settings.maxZoom || 100) / 100;
      if (zoom > cap) {
        log('Fit zoom ' + (zoom * 100).toFixed(1) + '% capped at ' + (cap * 100).toFixed(0) + '% (Max zoom setting).');
        zoom = cap;
      }

      // 4. Set and verify; shrink a little if AE's rounding clipped an edge.
      for (let attempt = 0; attempt < 4; attempt++) {
        const f = await measureAt('fit', zoom);
        const expectedW = model.at('R', f.zoom) - model.at('L', f.zoom);
        const crop = pad(f.rect, padding);
        if (inside(crop, viewer, 0) && Math.abs(f.rect[2] - expectedW) <= 3) {
          log('Fit zoom ' + (f.zoom * 100).toFixed(2) + '% → comp ' + f.rect[2] + '×' + f.rect[3] + ' px' +
            (padding ? ', capture ' + crop[2] + '×' + crop[3] + ' with ' + padding + ' px padding' : ''));
          return { zoom: f.zoom, rect: crop, compRect: f.rect, viewer, controls };
        }
        zoom *= 0.97;
      }
      throw new Error('comp kept getting clipped by the viewer edges at the fitted zoom');
    } finally {
      await CEP.jsx('calibrationEnd', comp.id, cal, {
        fastPreview: settings.fastPreview,
        selectAllLayers: settings.selectAllLayers
      });
      if (onState) onState({ layerControlsToggled: false });
    }
  }

  window.Calibrate = { calibrate, fitZoom, floodZoom, edgeModel, hasSafeZones };
})();
