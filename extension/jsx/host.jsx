// Wireframe host script (ExtendScript / ES3).
// Every public function returns a JSON string: {"ok":true,"result":...} or {"ok":false,"error":"..."}.

var WireframeHost = (function () {
    var AUTOSAVE_SECTION = 'Auto Save';
    var AUTOSAVE_KEY = 'Enable Auto Save3';

    // ---- tiny JSON (ExtendScript has no reliable built-in) ---------------------------------

    function quote(s) {
        return '"' + String(s).replace(/[\\"\x00-\x1f]/g, function (c) {
            var m = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
            if (m[c]) return m[c];
            var h = c.charCodeAt(0).toString(16);
            return '\\u' + ('0000' + h).slice(-4);
        }) + '"';
    }

    function stringify(v) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'string') return quote(v);
        var parts = [], i;
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
            return '[' + parts.join(',') + ']';
        }
        for (var k in v) {
            if (v.hasOwnProperty(k) && typeof v[k] !== 'function') parts.push(quote(k) + ':' + stringify(v[k]));
        }
        return '{' + parts.join(',') + '}';
    }

    function wrap(fn) {
        return function () {
            try {
                return stringify({ ok: true, result: fn.apply(null, arguments) });
            } catch (e) {
                return stringify({ ok: false, error: String(e && e.message ? e.message : e) + (e && e.line ? ' (line ' + e.line + ')' : '') });
            }
        };
    }

    // ---- helpers ---------------------------------------------------------------------------

    function activeComp() {
        var item = app.project ? app.project.activeItem : null;
        if (!(item instanceof CompItem)) throw new Error('Open a composition and click its viewer or timeline first.');
        return item;
    }

    function compById(id) {
        var item = app.project.itemByID(id);
        if (!(item instanceof CompItem)) throw new Error('Composition ' + id + ' no longer exists.');
        return item;
    }

    // Opens (or focuses) the comp's viewer and returns [viewer, viewOptions].
    function viewerFor(comp) {
        var viewer = comp.openInViewer();
        if (!viewer) viewer = app.activeViewer;
        if (!viewer) throw new Error('Could not open a viewer for ' + comp.name);
        return [viewer, viewer.views[viewer.activeViewIndex].options];
    }

    function compInfo(comp) {
        return {
            id: comp.id,
            name: comp.name,
            width: comp.width,
            height: comp.height,
            pixelAspect: comp.pixelAspect,
            frameRate: comp.frameRate,
            frameDuration: comp.frameDuration,
            duration: comp.duration,
            displayStartTime: comp.displayStartTime,
            workAreaStart: comp.workAreaStart,
            workAreaDuration: comp.workAreaDuration,
            time: comp.time,
            numLayers: comp.numLayers,
            // Folder of the saved .aep, or null for an unsaved project.
            projectFolder: app.project.file ? app.project.file.parent.fsName : null
        };
    }

    function getAutoSave() {
        var type = PREFType.PREF_Type_MACHINE_INDEPENDENT;
        if (!app.preferences.havePref(AUTOSAVE_SECTION, AUTOSAVE_KEY, type)) return null;
        return app.preferences.getPrefAsFloat(AUTOSAVE_SECTION, AUTOSAVE_KEY, type);
    }

    function setAutoSave(value) {
        var type = PREFType.PREF_Type_MACHINE_INDEPENDENT;
        app.preferences.savePrefAsFloat(AUTOSAVE_SECTION, AUTOSAVE_KEY, value, type);
        app.preferences.saveToDisk();
        app.preferences.reload();
    }

    var FAST_PREVIEW = {
        off: FastPreviewType.FP_OFF,
        wireframe: FastPreviewType.FP_WIREFRAME
    };

    // ---- public API ------------------------------------------------------------------------

    function info() {
        var comp = activeComp();
        var res = compInfo(comp);
        var v = app.activeViewer;
        if (v) {
            var o = v.views[v.activeViewIndex].options;
            res.viewer = { maximized: v.maximized, zoom: o.zoom };
        }
        return res;
    }

    // Records everything prepare() changes. Restore with restore(snapshot).
    function snapshot(comp, viewer, opts) {
        var sel = [], i;
        for (i = 1; i <= comp.numLayers; i++) if (comp.layer(i).selected) sel.push(comp.layer(i).id);
        return {
            version: 1,
            created: new Date().getTime(),
            compId: comp.id,
            compName: comp.name,
            time: comp.time,
            resolutionFactor: [comp.resolutionFactor[0], comp.resolutionFactor[1]],
            selectedLayerIds: sel,
            viewer: {
                maximized: viewer.maximized,
                zoom: opts.zoom,
                fastPreview: opts.fastPreview,
                checkerboards: opts.checkerboards,
                exposure: opts.exposure,
                channels: opts.channels
            },
            autoSave: getAutoSave()
        };
    }

    // settings: { fastPreview: 'off'|'wireframe'|'keep', fullResolution: bool, selectAllLayers: bool,
    //             hideCheckerboard: bool, disableAutoSave: bool, maximize: bool }
    function prepare(settings) {
        settings = settings || {};
        var comp = activeComp();
        var vo = viewerFor(comp), viewer = vo[0], opts = vo[1];
        var snap = snapshot(comp, viewer, opts);
        var i;

        if (settings.disableAutoSave && snap.autoSave !== null && snap.autoSave !== 0) setAutoSave(0);
        if (settings.fullResolution) comp.resolutionFactor = [1, 1];
        if (FAST_PREVIEW[settings.fastPreview] !== undefined) opts.fastPreview = FAST_PREVIEW[settings.fastPreview];
        if (settings.hideCheckerboard) opts.checkerboards = false;
        if (settings.selectAllLayers) selectAll(comp);
        if (settings.maximize !== false) viewer.maximized = true;

        return { snapshot: snap, comp: compInfo(comp) };
    }

    // Selection changes cost ~20 ms per layer when done one by one, so big comps use AE's
    // Edit > Select All / Deselect All (one command, acts on the focused comp viewer) and fall back
    // to the loop only if the command didn't take effect.
    function runMenuCommand(comp, name) {
        var id = app.findMenuCommandId(name);
        if (!id) return false;
        viewerFor(comp); // focus the comp's viewer so the command targets its layers
        app.executeCommand(id);
        return true;
    }

    // Layer controls (paths, bounding boxes, null icons) only draw for selected layers.
    function selectAll(comp) {
        var i, unlocked = 0;
        for (i = 1; i <= comp.numLayers; i++) if (!comp.layer(i).locked) unlocked++;
        if (comp.selectedLayers.length >= unlocked) return;
        if (runMenuCommand(comp, 'Select All') && comp.selectedLayers.length >= unlocked) return;
        for (i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (!layer.locked && !layer.selected) {
                try { layer.selected = true; } catch (e) {}
            }
        }
    }

    function deselectAll(comp) {
        if (comp.selectedLayers.length === 0) return;
        if (runMenuCommand(comp, 'Deselect All') && comp.selectedLayers.length === 0) return;
        var sel = comp.selectedLayers;
        for (var i = 0; i < sel.length; i++) sel[i].selected = false;
    }

    // ---- calibration marker ----------------------------------------------------------------

    var MARKER_NAME = '__Wireframe calibration__';

    // View > Show Layer Controls is a toggle with no readable state; we flip it and flip it back.
    function toggleLayerControls() {
        var id = app.findMenuCommandId('Show Layer Controls');
        if (!id) return false;
        app.executeCommand(id);
        return true;
    }

    // Adds a magenta solid over the whole comp so the panel can find the comp on screen.
    // Also clears anything that would change its colour or hide it in the viewer.
    function calibrationStart(compId) {
        var comp = compById(compId);
        var opts = viewerFor(comp)[1];
        var controlsToggled = false, deselected = false;

        opts.fastPreview = FastPreviewType.FP_OFF; // wireframe would draw the solid as an outline
        opts.exposure = 0;
        opts.channels = ChannelType.CHANNEL_RGB;
        // Selected layers draw handles over the marker. Hiding layer controls is one command;
        // deselecting is one call per layer (slow on big comps), so it's only the fallback.
        if (comp.selectedLayers.length) {
            controlsToggled = toggleLayerControls();
            if (!controlsToggled) { deselectAll(comp); deselected = true; }
        }

        app.beginUndoGroup('Wireframe calibration');
        try {
            var marker = comp.layers.addSolid([1, 0, 1], MARKER_NAME, comp.width, comp.height, comp.pixelAspect, comp.duration);
            marker.moveToBeginning();
            // Soloed, AE renders only the marker: every zoom step redraws instantly instead of
            // re-rendering the whole comp (which a stability check could catch half-drawn).
            marker.solo = true;
            marker.selected = false;
        } finally {
            app.endUndoGroup();
        }
        // Adding a layer opens its Effect Controls, which drops the viewer out of maximized mode.
        var viewer = viewerFor(comp)[0];
        viewer.maximized = true;
        return { markerId: marker.id, controlsToggled: controlsToggled, deselected: deselected, maximized: viewer.maximized };
    }

    // Removes the marker (and its solid footage) and undoes what calibrationStart changed.
    // cal is calibrationStart's result.
    function calibrationEnd(compId, cal, settings) {
        settings = settings || {};
        var comp = compById(compId);
        var opts = viewerFor(comp)[1];
        var markerId = cal.markerId;
        var i, removed = false;

        app.beginUndoGroup('Wireframe calibration cleanup');
        try {
            for (i = comp.numLayers; i >= 1; i--) {
                var layer = comp.layer(i);
                if (layer.id === markerId || layer.name === MARKER_NAME) {
                    var src = layer.source;
                    layer.remove();
                    if (src && src.usedIn.length === 0) src.remove();
                    removed = true;
                }
            }
        } finally {
            app.endUndoGroup();
        }

        if (FAST_PREVIEW[settings.fastPreview] !== undefined) opts.fastPreview = FAST_PREVIEW[settings.fastPreview];
        // Always re-apply: adding the marker can change the selection too. selectAll skips selected layers.
        if (settings.selectAllLayers) selectAll(comp);
        var viewer = viewerFor(comp)[0];
        if (!viewer.maximized) viewer.maximized = true; // the capture crop assumes the calibrated layout
        if (cal.controlsToggled) toggleLayerControls(); // last, so a failure above can't double-toggle
        return { removed: removed, maximized: viewer.maximized };
    }

    function restore(snap) {
        if (!snap || !snap.compId) throw new Error('No snapshot to restore.');
        var comp = compById(snap.compId);
        var vo = viewerFor(comp), viewer = vo[0], opts = vo[1];
        var i, problems = [];

        function attempt(label, fn) {
            try { fn(); } catch (e) { problems.push(label + ': ' + e.message); }
        }

        // A crash mid-calibration can leave layer controls hidden; the panel records that in the snapshot.
        if (snap.layerControlsToggled) attempt('layer controls', function () { toggleLayerControls(); });

        var selection = null;
        attempt('selection', function () {
            var keep = {}, expected = 0, actual = 0, layer, want;
            for (i = 0; i < snap.selectedLayerIds.length; i++) keep[snap.selectedLayerIds[i]] = true;
            // Fast path for the common "nothing was selected" case; otherwise only touch layers that differ.
            if (snap.selectedLayerIds.length === 0) deselectAll(comp);
            for (i = 1; i <= comp.numLayers; i++) {
                layer = comp.layer(i);
                want = keep[layer.id] === true;
                if (want) expected++;
                if (layer.selected !== want && !layer.locked) layer.selected = want;
            }
            actual = comp.selectedLayers.length;
            selection = { expected: expected, actual: actual };
            if (actual !== expected) throw new Error(actual + ' layers selected, expected ' + expected);
        });
        attempt('resolution', function () { comp.resolutionFactor = snap.resolutionFactor; });
        attempt('time', function () { comp.time = snap.time; });
        attempt('fast preview', function () { opts.fastPreview = snap.viewer.fastPreview; });
        attempt('checkerboard', function () { opts.checkerboards = snap.viewer.checkerboards; });
        if (snap.viewer.exposure !== undefined) attempt('exposure', function () { opts.exposure = snap.viewer.exposure; });
        if (snap.viewer.channels !== undefined) attempt('channels', function () { opts.channels = snap.viewer.channels; });
        attempt('maximize', function () { viewer.maximized = snap.viewer.maximized; });
        // Zoom last: un-maximizing changes the viewer size but keeps the zoom value.
        attempt('zoom', function () { opts.zoom = snap.viewer.zoom; });
        attempt('auto save', function () {
            if (snap.autoSave !== null && snap.autoSave !== undefined && getAutoSave() !== snap.autoSave) setAutoSave(snap.autoSave);
        });

        return { problems: problems, selection: selection };
    }

    // Gives the comp viewer keyboard focus inside AE, so a viewer shortcut sent next lands on it.
    function focusViewer(compId) {
        var viewer = viewerFor(compById(compId))[0];
        viewer.setActive();
        return { maximized: viewer.maximized };
    }

    // Returns the zoom AE actually applied (it may round). keepMaximized re-maximizes the viewer
    // first if something (a panel opening) took it out of maximized mode.
    function setZoom(compId, zoom, keepMaximized) {
        var vo = viewerFor(compById(compId)), viewer = vo[0], opts = vo[1];
        if (keepMaximized && !viewer.maximized) viewer.maximized = true;
        opts.zoom = zoom;
        return { zoom: opts.zoom, maximized: viewer.maximized };
    }

    function frameAt(comp, time) {
        return Math.floor(time * comp.frameRate + 1e-4);
    }

    // Moves the comp to a frame index (0 = comp start). Returns the time set and the frame AE landed on;
    // nudges forward a hair if float rounding put the time just before the frame boundary.
    function setFrame(compId, frame) {
        var comp = compById(compId);
        var t = frame / comp.frameRate;
        comp.time = t;
        if (frameAt(comp, comp.time) !== frame) comp.time = t + comp.frameDuration * 0.001;
        return { time: comp.time, frame: frameAt(comp, comp.time) };
    }

    return {
        info: wrap(info),
        prepare: wrap(prepare),
        restore: wrap(restore),
        setZoom: wrap(setZoom),
        focusViewer: wrap(focusViewer),
        toggleLayerControls: wrap(function () { return { toggled: toggleLayerControls() }; }),
        calibrationStart: wrap(calibrationStart),
        calibrationEnd: wrap(calibrationEnd),
        setFrame: wrap(setFrame)
    };
})();
