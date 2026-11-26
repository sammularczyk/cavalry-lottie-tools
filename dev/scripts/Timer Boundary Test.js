// Timer Boundary Test
//
// ONE QUESTION: for a render issued from an api.Timer callback that fires
// AFTER the click handler has returned, does a duplicator re-evaluate its
// per-copy sample time (shapeTimeOffset driver)?
//
// YES -> the Lottie Optimiser's two-click timing measurement can become one
//        click: prepare, return, measure from a Timer, export.
// NO  -> two clicks are structural and only the dialog wording can help.
//
// The decoder used here is a copy of duplicatorCompRefs.js offsetFromWidth,
// because that is the function that decides whether a measurement is real.
//
// HOW TO USE
//   1. Make the comp with the comp-reference duplicator the ACTIVE comp
//      (e.g. Repeated_Duplicator_Fib).
//   2. Scripts > Lottie Tools > Timer Boundary Test.
//   3. Click "Run both tests".
//   4. Tell me what the result file says (the window writes the path), or just
//      paste the console output.
//
// Nothing in your comp is modified. The test builds a throwaway comp holding a
// deep duplicate of the duplicator, renders inside it, and deletes it after.
//
// This file lives in dev/scripts/ because `npm run release` wipes dev/build/.
// It is copied into dev/build/ by hand when you want it in the menu.

ui.setTitle('Timer Boundary Test');

var OUT = api.getTempFolder() + '/dcr-boundary-result.txt';

function rm(path) {
	try {
		if (api.filePathExists(path)) api.deleteFilePath(path);
	} catch (e) {}
}

function log(msg) {
	try {
		var prev = api.filePathExists(OUT) ? api.readFromFile(OUT) : '';
		api.writeToFile(OUT, prev + msg + '\n', true);
	} catch (e) {}
}

// --- helpers copied from duplicatorCompRefs.js ------------------------------

function inputSources(layerId, slot) {
	var nodes = null;
	var attr = slot || 'shapes';
	try {
		nodes = JSON.parse([].concat(api.serialise([layerId], false)).join(''));
	} catch (e) {
		return [];
	}
	var prefix = layerId + '.' + attr + '.';
	var out = [];
	((nodes && nodes.connections) || []).forEach(function (c) {
		var to = String(c.to);
		if (to.indexOf(prefix) !== 0) return;
		out.push({ at: parseInt(to.slice(prefix.length), 10) || 0, from: String(c.from).replace(/\.id$/, '') });
	});
	out.sort(function (a, b) {
		return a.at - b.at;
	});
	return out.map(function (o) {
		return o.from;
	});
}

function compRefDuplicators(comp) {
	var out = [];
	var kids = api.getChildren(comp) || [];
	for (var i = 0; i < kids.length; i++) {
		var id = kids[i];
		if (api.getLayerType(id) !== 'duplicator') continue;
		var sources = inputSources(id);
		if (!sources.length) continue;
		var hasRef = false;
		for (var s = 0; s < sources.length; s++) {
			if (api.getLayerType(sources[s]) === 'compositionReference') {
				hasRef = true;
				break;
			}
		}
		if (hasRef) out.push(id);
	}
	return out;
}

function spanX(v) {
	var lo = Infinity,
		hi = -Infinity;
	for (var i = 0; i < v.length; i++) {
		if (v[i][0] < lo) lo = v[i][0];
		if (v[i][0] > hi) hi = v[i][0];
	}
	return hi - lo;
}

function widthSeries(ks) {
	var out = [];
	if (ks.a === 1 && Array.isArray(ks.k)) {
		for (var i = 0; i < ks.k.length; i++) {
			var kf = ks.k[i];
			if (!kf.s || !kf.s[0] || !kf.s[0].v) return null;
			out.push({ t: kf.t, w: spanX(kf.s[0].v) });
		}
	} else if (ks.k && ks.k.v) {
		out.push({ t: 0, w: spanX(ks.k.v) });
	} else return null;
	return out.length ? out : null;
}

var median = function (a) {
	var s = a.slice().sort(function (x, y) {
		return x - y;
	});
	return s[(s.length - 1) >> 1];
};

// Offset in frames from the baked width sweep. Interior frames give the offset
// directly: w(t) = clamp(t + off, 0, last) * 100/last.
function offsetFromWidth(ws, last) {
	if (!ws) return null;
	var mid = ws
		.filter(function (f) {
			return f.w > 0.5 && f.w < 99.5;
		})
		.map(function (f) {
			return (f.w * last) / 100 - f.t;
		});
	if (mid.length) return Math.round(median(mid) * 100) / 100;
	if (ws[0].w > 99.5) return Math.round(last * 100) / 100;
	var rise = ws.filter(function (f) {
		return f.w > 0.5;
	})[0];
	if (rise) return Math.round(-rise.t * 100) / 100;
	return null;
}

// --- build / measure / clean ----------------------------------------------

function buildProbe() {
	var comp = api.getActiveComp();
	if (!comp) throw new Error('no active comp');
	var dups = compRefDuplicators(comp);
	if (!dups.length) {
		throw new Error('no duplicator fed by a composition reference in "' + api.getNiceName(comp) + '" - make that comp active first');
	}
	var cfg = {};
	['resolution', 'fps', 'startFrame', 'endFrame', 'playbackStart', 'playbackEnd'].forEach(function (a) {
		try {
			cfg[a] = api.get(comp, a);
		} catch (e) {}
	});
	var start = Number(cfg.startFrame) || 0;
	var last = (Number(cfg.endFrame) || start) - start;
	if (!last) throw new Error('the comp has no frame range to sample');

	var probe = api.createComp('dcr-boundary-probe');
	api.set(probe, cfg);
	api.setActiveComp(probe);
	var probes = [];
	dups.forEach(function (dup) {
		var copy = api.duplicate(dup, true);
		if (!copy || !api.layerExists(copy)) throw new Error('could not duplicate ' + dup);
		api.parent(copy, probe);
		// the sampler is parented to the COMP, never to the duplicator: a sampler
		// inside the duplicator breaks its bake completely
		var rect = api.primitive('rectangle', 'dcr-boundary-sampler');
		if (!rect || !api.layerExists(rect)) throw new Error('could not create the sampler shape');
		api.parent(rect, probe);
		api.set(rect, { 'generator.dimensions.x': 0, 'generator.dimensions.y': 2 });
		api.keyframe(rect, start, { 'generator.dimensions.x': 0 });
		api.keyframe(rect, start + last, { 'generator.dimensions.x': 100 });
		var keys = [];
		try { keys = api.getKeyframeIdsForAttribute(rect, 'generator.dimensions.x') || []; } catch (e) { keys = []; }
		if (keys.length !== 2) throw new Error('the sampler did not keep its two keyframes');
		inputSources(copy).forEach(function (src) {
			try {
				api.disconnect(src, 'id', copy, 'shapes.0');
			} catch (e) {}
		});
		api.connect(rect, 'id', copy, 'shapes');
		probes.push({ src: dup, copy: copy });
	});
	api.setActiveComp(comp);
	return { comp: comp, probe: probe, start: start, last: last, probes: probes };
}

function measure(state, label) {
	var dir = api.getTempFolder() + '/dcr-boundary-run';
	if (!api.isDirectory(dir)) api.makeFolder(dir);
	rm(dir + '/export.json');
	var rq = api.addRenderQueueItem(state.probe);
	try {
		api.setGenerator(rq, 'generator', 'renderLottie');
		api.set(rq, { filePath: dir, fileName: 'export', frameRangeMode: 0 });
		api.setActiveComp(state.probe);
		api.render(rq);
	} finally {
		try {
			api.deleteLayer(rq);
		} catch (e) {}
	}
	var bake = JSON.parse(api.readFromFile(dir + '/export.json'));

	var lines = [label + '  (start=' + state.start + ' last=' + state.last + ')'];
	state.probes.forEach(function (p) {
		var layer = null;
		for (var i = 0; i < (bake.layers || []).length; i++) {
			var L = bake.layers[i];
			if (L.ty === 4 && String(L.mn || '').indexOf(p.copy) === 0) {
				layer = L;
				break;
			}
		}
		var outer = layer && layer.shapes && layer.shapes[0];
		var groups = outer && outer.ty === 'gr' ? outer.it.filter(function (it) { return it.ty === 'gr'; }) : [];
		var series = groups.map(function (g) {
			var sh = (g.it || []).filter(function (it) { return it.ty === 'sh'; })[0];
			return sh && sh.ks ? widthSeries(sh.ks) : null;
		});
		// round before comparing: unrounded widths differ in the last float digit
		// between copies and would report a false "distinct=4" for identical bakes
		var sig = {};
		series.forEach(function (s) {
			sig[
				s
					? JSON.stringify(
							s.map(function (f) {
								return [f.t, Math.round(f.w * 100)];
							})
						)
					: 'null'
			] = true;
		});
		var offs = series.map(function (s) {
			return offsetFromWidth(s, state.last);
		});
		lines.push('  ' + api.getNiceName(p.src) + ': groups=' + groups.length + ' distinct=' + Object.keys(sig).length);
		lines.push('  decoded offsets: ' + JSON.stringify(offs));
		lines.push(
			'  first 6 widths: ' +
				JSON.stringify(
					series.map(function (s) {
						return s
							? s.slice(0, 6).map(function (f) {
									return Math.round(f.w);
								})
							: null;
					})
				)
		);
	});
	rm(dir + '/export.json');
	return lines.join('\n');
}

// Delete only what this script made: the probe comp and anything named
// dcr-boundary-*. A "delete everything new since the start" sweep could destroy
// layers you add while a timer is pending.
function cleanup(state) {
	try {
		if (state && state.probe && api.layerExists(state.probe)) api.deleteLayer(state.probe);
	} catch (e) {}
	try {
		if (state && state.comp) api.setActiveComp(state.comp);
	} catch (e) {}
	try {
		api.getAllSceneLayers().forEach(function (id) {
			var n = api.getNiceName(id) || '';
			if (n.indexOf('dcr-boundary') === 0) {
				try {
					api.deleteLayer(id);
				} catch (e) {}
			}
		});
	} catch (e) {}
}

// --- the UI -----------------------------------------------------------------

var resultLabel = new ui.Label('Not run yet.');

var immediateButton = new ui.Button('Control: measure immediately');
immediateButton.onClick = function () {
	log('=== CONTROL: build and render in one handler ===');
	var state = null;
	try {
		state = buildProbe();
		var txt = measure(state, 'CONTROL');
		log(txt);
		console.log('CONTROL RESULT\n' + txt);
		resultLabel.setText('Control done. See console or ' + OUT);
	} catch (e) {
		log('CONTROL ERROR ' + (e && e.message));
		console.error('CONTROL ERROR ' + (e && e.message));
		resultLabel.setText('Control failed: ' + (e && e.message));
	} finally {
		if (state) cleanup(state);
	}
};

var timerButton = new ui.Button('Test: measure after handler returns');
timerButton.onClick = function () {
	log('=== TIMER: build now, render from a Timer callback ===');
	var state = null;
	try {
		state = buildProbe();
	} catch (e) {
		log('TIMER BUILD ERROR ' + (e && e.message));
		console.error('TIMER BUILD ERROR ' + (e && e.message));
		resultLabel.setText('Build failed: ' + (e && e.message));
		return;
	}
	log('probe built: ' + state.probe + ' copies=' + state.probes.map(function (p) { return p.copy; }).join(','));
	var timer = new api.Timer({
		onTimeout: function () {
			try {
				timer.stop();
			} catch (e) {}
			log('timer fired (handler had already returned)');
			var txt = '';
			try {
				txt = measure(state, 'TIMER');
				log(txt);
				console.log('TIMER RESULT\n' + txt);
			} catch (e) {
				log('TIMER MEASURE ERROR ' + (e && e.message));
				console.error('TIMER MEASURE ERROR ' + (e && e.message));
			}
			cleanup(state);
			log('cleaned up');
			resultLabel.setText('Timer test finished. See console or ' + OUT);
		}
	});
	timer.setRepeating(false);
	timer.setInterval(600); // milliseconds
	timer.start();
	log('timer started, returning from the handler now');
	console.log('Timer started. It renders after this handler returns.');
};

// A third mechanism: the panel's own scene-changed callback. Building the probe
// changes the scene, which fires this AFTER the click handler has returned. If
// the bake differentiates here, the Optimiser can measure without a Timer at all.
var sceneButton = new ui.Button('Test: measure on scene change');
sceneButton.onClick = function () {
	log('=== SCENE CHANGED: build now, render from onSceneChanged ===');
	var state = null;
	try {
		state = buildProbe();
	} catch (e) {
		log('SCENE BUILD ERROR ' + (e && e.message));
		console.error('SCENE BUILD ERROR ' + (e && e.message));
		resultLabel.setText('Build failed: ' + (e && e.message));
		return;
	}
	log('probe built: ' + state.probe);
	var fired = false;
	var obj = {
		onSceneChanged: function () {
			if (fired) return;
			fired = true;
			log('onSceneChanged fired (handler had already returned)');
			var txt = '';
			try {
				txt = measure(state, 'SCENECHANGE');
				log(txt);
				console.log('SCENECHANGE RESULT\n' + txt);
			} catch (e) {
				log('SCENECHANGE MEASURE ERROR ' + (e && e.message));
				console.error('SCENECHANGE MEASURE ERROR ' + (e && e.message));
			}
			cleanup(state);
			log('cleaned up');
			resultLabel.setText('Scene-change test finished. See console or ' + OUT);
			try { ui.removeCallbackObject(obj); } catch (e) {}
		}
	};
	ui.addCallbackObject(obj);
	log('callback registered, returning from the handler now');
	console.log('Registered. It renders when the scene next reports a change.');
};

var bothButton = new ui.Button('Run control + timer');
bothButton.onClick = function () {
	rm(OUT);
	log('Timer Boundary Test run ' + new Date().toString());
	immediateButton.onClick();
	timerButton.onClick();
};

var cleanupButton = new ui.Button('Clean up probe');
cleanupButton.onClick = function () {
	cleanup(null);
	resultLabel.setText('Cleaned up any dcr-boundary layers.');
};

var v = new ui.VLayout();
v.setSpaceBetween(6);
v.add(bothButton);
v.add(immediateButton);
v.add(timerButton);
v.add(sceneButton);
v.add(cleanupButton);
v.add(resultLabel);
ui.add(v);
ui.show();
