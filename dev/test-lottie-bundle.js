(() => {
  // src/modules/submeshVisibility.js
  function parseIndexList(text) {
    if (typeof text !== "string") return [];
    const out = [];
    String(text).split(",").forEach(function(part) {
      part = part.trim();
      if (!part) return;
      const m = part.match(/^(\d+)\s*:\s*(\d+)$/);
      if (m) {
        const a = parseInt(m[1], 10);
        const b = parseInt(m[2], 10);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
        return;
      }
      const n = parseInt(part, 10);
      if (!isNaN(n)) out.push(n);
    });
    return out;
  }
  function visibilitySequenceMask(seq, count) {
    const mask = new Array(count).fill(0);
    if (count <= 0) return mask;
    const start = clamp01(num(seq.start) / 100);
    const end = clamp01(num(seq.end) / 100);
    const travel = num(seq.travel) || 0;
    const invert = !!seq.invert;
    const a = Math.round(start * count) + Math.floor(travel);
    const b = Math.round(end * count) + Math.floor(travel);
    const offset = Math.min(a, b);
    const width = Math.abs(b - a);
    for (let i = 0; i < count; i++) {
      const rel = ((i - offset) % count + count) % count;
      const visible = rel < width ? 1 : 0;
      mask[i] = invert ? 1 - visible : visible;
    }
    parseIndexList(seq.alwaysOn).forEach(function(n) {
      const i = n - 1;
      if (i >= 0 && i < count) mask[i] = 1;
    });
    parseIndexList(seq.alwaysOff).forEach(function(n) {
      const i = n - 1;
      if (i >= 0 && i < count) mask[i] = 0;
    });
    return mask;
  }
  function num(v) {
    return typeof v === "number" && isFinite(v) ? v : 0;
  }
  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }
  function expressionIsIndexPure(expr) {
    return !/\bctx\s*\.\s*(saveObject|loadObject|hasObject)\b/.test(String(expr || ""));
  }
  function evalIndexExpression(expr, index, count) {
    const ctx = {
      index,
      count,
      positionX: 0,
      positionY: 0,
      attributeId: "",
      layerId: "",
      niceName: ""
    };
    const src = String(expr || "");
    try {
      const fn = new Function("ctx", '"use strict";\nreturn (' + src.replace(/;\s*$/, "") + ");");
      return fn(ctx);
    } catch (e) {
      const fn = new Function("ctx", '"use strict";\n' + src + "\n");
      return fn(ctx);
    }
  }
  function expressionMask(expr, count) {
    if (!expressionIsIndexPure(expr)) return null;
    const mask = new Array(count).fill(0);
    for (let i = 0; i < count; i++) {
      let v;
      try {
        v = evalIndexExpression(expr, i, count);
      } catch (e) {
        return null;
      }
      mask[i] = v ? 1 : 0;
    }
    return mask;
  }
  function maskToOpacityProp(mask, frames) {
    const keys = [];
    for (let f = 0; f < mask.length; f++) {
      keys.push({
        t: frames[f].frame,
        s: [mask[f] ? 100 : 0],
        i: { x: [1], y: [1] },
        o: { x: [0], y: [0] }
      });
    }
    return { a: 1, k: keys };
  }
  function applyMasksToGroups(groups, masksByGroup, frames) {
    let changed = 0;
    groups.forEach(function(g, gi) {
      const mask = masksByGroup[gi];
      if (!mask) return;
      if (mask.length && mask.every(function(v) {
        return v === 1;
      })) return;
      const tr = trOf(g);
      if (!tr) return;
      if (mask.length && mask.every(function(v) {
        return v === 0;
      })) {
        g.hd = true;
        changed++;
        return;
      }
      if (tr.o && tr.o.a === 1) return;
      tr.o = maskToOpacityProp(mask, frames);
      changed++;
    });
    return changed;
  }
  function trOf(g) {
    const it = g.it || [];
    for (let i = 0; i < it.length; i++) if (it[i].ty === "tr") return it[i];
    return null;
  }

  // src/modules/cavalryExport.js
  function compLayers(compId) {
    var out = [];
    var walk = function(id) {
      api.getChildren(id).forEach(function(c) {
        out.push(c);
        walk(c);
      });
    };
    walk(compId);
    return out;
  }
  function shaderArrayPicks(compId, refId) {
    var picks = [];
    compLayers(compId).forEach(function(shape) {
      ;
      ["material", "stroke"].forEach(function(slot) {
        for (var i = 0; api.hasAttribute(shape, slot + ".colorShaders." + i + ".shader"); i++) {
          var path = slot + ".colorShaders." + i + ".shader";
          var arr = (api.getInConnection(shape, path) || "").split(".")[0];
          if (!arr || api.getLayerType(arr) !== "shaderArray") continue;
          var shader = arrayPick(arr, compId, refId);
          if (shader) picks.push({ shape, path, arr, shader });
        }
      });
    });
    return picks;
  }
  function fillShader(shape, compId, refId, slot) {
    var path = (slot || "material") + ".colorShaders.0.shader";
    if (!api.hasAttribute(shape, path)) return null;
    var src = (api.getInConnection(shape, path) || "").split(".")[0];
    if (src && api.getLayerType(src) === "shaderArray") src = arrayPick(src, compId, refId);
    return src || null;
  }
  function arrayPick(arr, compId, refId) {
    if (api.get(arr, "autoIndex")) return null;
    var index = overrideFor(arr, "arrayIndex", compId, refId);
    if (index == null) index = api.get(arr, "arrayIndex");
    return (api.getInConnection(arr, "array." + index) || "").split(".")[0] || null;
  }
  function overrideFor(layer, attr, compId, refId) {
    if (!refId) return null;
    var exposed = (api.getOutConnections(layer, attr) || []).filter(function(c) {
      return c.indexOf(compId + ".overrides.") === 0;
    })[0];
    if (!exposed) return null;
    for (var i = 0; api.hasAttribute(refId, "overrides." + i); i++) {
      var o = "overrides." + i;
      if (api.getInConnection(refId, o + ".attribute") === exposed && api.get(refId, o + ".enabled")) return api.get(refId, o + ".int");
    }
    return null;
  }
  function exportComp(compId, opts) {
    opts = opts || {};
    var dir = api.getTempFolder() + "/lottie-tools-" + (/* @__PURE__ */ new Date()).getTime();
    api.makeFolder(dir);
    var restore = [];
    var rewired = [];
    var rq = null;
    var frame = api.getFrame();
    try {
      shaderArrayPicks(compId, opts.ref).forEach(function(p) {
        api.connect(p.shader, "id", p.shape, p.path, true);
        rewired.push(p);
      });
      if (opts.bakeMode != null) {
        compLayers(compId).forEach(function(id) {
          if (!api.hasAttribute(id, "forceLottieBake")) return;
          var was = api.get(id, "forceLottieBake");
          if (was === opts.bakeMode) return;
          restore.push([id, was]);
          api.set(id, { forceLottieBake: opts.bakeMode });
        });
      }
      rq = api.addRenderQueueItem(compId);
      api.setGenerator(rq, "generator", "renderLottie");
      api.set(rq, { filePath: dir, fileName: "export", frameRangeMode: 0 });
      api.render(rq);
    } finally {
      api.setFrame(frame);
      rewired.forEach(function(p) {
        api.connect(p.arr, "id", p.shape, p.path, true);
      });
      restore.forEach(function(r) {
        try {
          api.set(r[0], { forceLottieBake: r[1] });
        } catch (e) {
        }
      });
      if (rq) {
        try {
          api.deleteLayer(rq);
        } catch (e) {
        }
      }
    }
    var file = dir + "/export.json";
    if (!api.filePathExists(file)) throw new Error("Cavalry did not write a Lottie file (is Lottie export licensed?)");
    var text = api.readFromFile(file);
    var json = JSON.parse(text);
    var compIP = json.ip != null ? json.ip : 1;
    var compOP = json.op != null ? json.op : 1;
    var frameCount = Math.max(0, compOP - compIP);
    var frames = [];
    for (var fi = 0; fi < frameCount; fi++) {
      frames.push({ frame: compIP + fi });
    }
    if (fadeAutoAnimate(compId, json)) text = JSON.stringify(json);
    if (injectVisibilityOpacity(compId, json, frames)) text = JSON.stringify(json);
    if (injectSubMeshVisibility(compId, json, frames)) text = JSON.stringify(json);
    if (cullFalloffHidden(compId, json, frames)) text = JSON.stringify(json);
    if (restructureDuplicators(compId, json, frames, opts)) text = JSON.stringify(json);
    console.log("[restructure] DONE. assets=" + (json.assets ? json.assets.length : 0) + ", layers=" + json.layers.length);
    return { json, text, dir, file, baked: restore.map(function(r) {
      return r[0];
    }) };
  }
  function glyphOpacity(start, prog, mode) {
    var lin = { i: { x: [1], y: [1] }, o: { x: [0], y: [0] } };
    var key = function(t, v, hold) {
      return Object.assign({ t, s: [v] }, hold ? { h: 1 } : lin);
    };
    if (mode === "appear") return { a: 1, k: [key(0, 0, true), key(start, 100, true)] };
    var from = mode === "down" ? 100 : 0;
    var k = [key(0, from, true)];
    prog.forEach(function(p, i) {
      k.push(key(start + i, mode === "down" ? 100 - p : p));
    });
    return { a: 1, k };
  }
  function glyphDelays(text, aa) {
    if (!aa.automatic || aa.offset >= 0 || aa.timing !== 0 || aa.groupByParent || aa.level !== 2 && aa.level !== 3) return null;
    var chars = text.replace(/\s/g, "").length;
    var words = text.split(/\s+/).filter(Boolean);
    var el = [];
    words.forEach(function(w, wi) {
      for (var i = 0; i < w.length; i++) el.push(aa.level === 2 ? wi : el.length);
    });
    var n = aa.level === 2 ? words.length : chars;
    return el.map(function(k) {
      return -aa.offset * (aa.reverse ? n - 1 - k : k) / Math.max(n - 1, 1);
    }).reverse();
  }
  function fadeAutoAnimate(compId, json) {
    var changed = 0;
    var frame = api.getFrame();
    compLayers(compId).forEach(function(id) {
      if (!api.hasAttribute(id, "deformers.0")) return;
      var aa = (api.getInConnection(id, "deformers.0") || "").split(".")[0];
      if (!aa || api.getLayerType(aa) !== "autoAnimate") return;
      var mode = api.get(aa, "opacityMode") === 1 ? "up" : api.get(aa, "opacityMode") === 2 ? "down" : api.get(aa, "visibilityMode") === 1 ? "appear" : null;
      if (!mode) return;
      var attr = api.get(aa, "progressMode") === 1 ? "opacityProgress" : "progress";
      var keys = api.getKeyframeTimes(aa, attr);
      var last = keys.length ? keys[keys.length - 1] : 0;
      var prog = [];
      for (var f = 0; f <= last; f++) {
        api.setFrame(f);
        prog.push(api.get(aa, attr));
      }
      var first = prog.findIndex(function(p) {
        return p > 0;
      });
      if (first < 0) return;
      prog = prog.slice(first);
      var layer = json.layers.filter(function(l) {
        return l.ty === 4 && l.nm === api.getNiceName(id);
      })[0];
      if (!layer) return;
      var text = api.hasAttribute(id, "text") ? (api.get(id, "text") || {}).text : null;
      var delays = typeof text !== "string" ? null : glyphDelays(text, {
        automatic: api.get(aa, "automaticTimeOffset"),
        offset: api.get(aa, "timeOffset"),
        timing: api.get(aa, "timingMode"),
        groupByParent: api.get(aa, "groupByParent"),
        level: api.get(aa, "levelMode"),
        reverse: api.get(aa, "reverseTimeOffset")
      });
      var groups = glyphGroups(layer.shapes);
      if (delays && delays.length !== groups.length) delays = null;
      groups.forEach(function(g, gi) {
        var tr = g.it.filter(function(s) {
          return s.ty === "tr";
        })[0];
        var kf = g.it.filter(function(s) {
          return s.ty === "sh";
        })[0].ks.k;
        if (!tr || tr.o && tr.o.a === 1 || !Array.isArray(kf)) return;
        var start = first + Math.floor(delays ? delays[gi] + 1e-6 : 0);
        if (!delays) {
          var v = function(k) {
            return k.s[0].v[0];
          };
          var base = v(kf[0]);
          var move = kf.filter(function(k) {
            return Math.abs(v(k)[0] - base[0]) + Math.abs(v(k)[1] - base[1]) > 0.01;
          })[0];
          if (!move || move.t < 1) return;
          start = move.t;
        }
        tr.o = glyphOpacity(start, prog, mode);
        changed++;
      });
    });
    api.setFrame(frame);
    return changed;
  }
  function readVisibilityCurves(compId) {
    var map = {};
    var visCurves = {};
    compLayers(compId).forEach(function(id) {
      if (api.getLayerType(id) === "visibilityCurve") {
        visCurves[id] = true;
      }
    });
    compLayers(compId).forEach(function(shape) {
      if (!api.hasAttribute(shape, "on")) return;
      var conn = api.getInConnection(shape, "on") || "";
      if (!conn) return;
      var curveId = conn.split(".")[0];
      if (visCurves[curveId]) {
        map[shape] = curveId;
      }
    });
    return map;
  }
  function getVisibilityValue(curveId, frame) {
    api.setFrame(frame);
    var val = api.get(curveId, "out");
    if (val == null) return 1;
    return Math.round(val) === 1 ? 1 : 0;
  }
  function buildVisibilityMask(compId, frames) {
    var visMap = readVisibilityCurves(compId);
    var masks = {};
    for (var nodeId in visMap) {
      var curveId = visMap[nodeId];
      if (masks[curveId]) continue;
      var mask = [];
      for (var f = 0; f < frames.length; f++) {
        mask.push(getVisibilityValue(curveId, frames[f].frame));
      }
      masks[curveId] = mask;
    }
    return masks;
  }
  function layerNameToNodeId(compId, layerName) {
    var nodes = compLayers(compId);
    for (var i = 0; i < nodes.length; i++) {
      if (api.getNiceName(nodes[i]) === layerName) {
        return nodes[i];
      }
    }
    return null;
  }
  function injectVisibilityOpacity(compId, json, frames) {
    var changed = 0;
    var frame = api.getFrame();
    try {
      var masks = buildVisibilityMask(compId, frames);
      if (!masks || Object.keys(masks).length === 0) return 0;
      json.layers.forEach(function(layer) {
        if (layer.ty !== 4) return;
        var sceneNode = layerNameToNodeId(compId, layer.nm);
        if (!sceneNode) return;
        var visMap = readVisibilityCurves(compId);
        var curveId = visMap[sceneNode];
        if (!curveId || !masks[curveId]) return;
        var mask = masks[curveId];
        if (mask.length === 0) return;
        var items = layer.shapes || [];
        items.forEach(function injectToGroup(group) {
          if (group.ty === "tr") {
            if (!group.o || group.o.a === 0 || group.o.k === 100) {
              var keys = [];
              for (var f = 0; f < mask.length; f++) {
                var val = mask[f] * 100;
                keys.push({
                  t: frames[f].frame,
                  s: [val],
                  i: { x: [1], y: [1] },
                  o: { x: [0], y: [0] }
                });
              }
              group.o = { a: 1, k: keys };
              changed++;
            }
          } else if (group.it && group.it.length) {
            group.it.forEach(injectToGroup);
          }
        });
      });
      compLayers(compId).forEach(function(shape) {
        if (!api.hasAttribute(shape, "on")) return;
        var conn = api.getInConnection(shape, "on") || "";
        if (!conn) return;
        var curveId = conn.split(".")[0];
        if (masks[curveId]) {
          var mask = masks[curveId];
          var alwaysHidden = mask.every(function(v) {
            return v === 0;
          });
          if (alwaysHidden) {
            var niceName = api.getNiceName(shape);
            json.layers.forEach(function(layer) {
              if (layer.ty !== 4) return;
              var items = layer.shapes || [];
              var stack = [items];
              while (stack.length) {
                var parent = stack.pop();
                for (var i = 0; i < parent.length; i++) {
                  var g = parent[i];
                  if (g && g.nm === niceName) {
                    g.hd = true;
                    changed++;
                  }
                  if (g && g.it) stack.push(g.it);
                }
              }
            });
          }
        }
      });
    } finally {
      api.setFrame(frame);
    }
    return changed;
  }
  function subMeshDriverMasks(sm, frames, compId) {
    var count = subMeshCopyCount(sm, compId);
    if (!count) return null;
    var conn = (api.getInConnection(sm, "shapeVisibility") || "").split(".")[0];
    if (!conn) return null;
    var type = api.getLayerType(conn);
    if (type === "visibility") {
      var masks = [];
      for (var i = 0; i < frames.length; i++) {
        api.setFrame(frames[i].frame);
        masks.push(
          visibilitySequenceMask(
            {
              start: api.get(conn, "start"),
              end: api.get(conn, "end"),
              travel: api.get(conn, "travel"),
              invert: api.get(conn, "invert"),
              alwaysOn: api.get(conn, "alwaysOn"),
              alwaysOff: api.get(conn, "alwaysOff")
            },
            count
          )
        );
      }
      return masks;
    }
    if (type === "javaScript") {
      var expr = api.get(conn, "expression");
      var base = expressionMask(expr, count);
      if (!base) {
        console.log("[submesh-vis] subMesh " + sm + ": javascript driver not index-pure \u2014 skipping");
        return null;
      }
      var masks = [];
      for (var j = 0; j < frames.length; j++) masks.push(base);
      return masks;
    }
    console.log("[submesh-vis] subMesh " + sm + ": unknown driver type " + type + " \u2014 skipping");
    return null;
  }
  function subMeshCopyCount(sm, compId) {
    var host = null;
    compLayers(compId).forEach(function(id) {
      if (api.getLayerType(id) !== "duplicator") return;
      for (var i = 0; api.hasAttribute(id, "deformers." + i); i++) {
        if ((api.getInConnection(id, "deformers." + i) || "").split(".")[0] === sm) host = id;
      }
    });
    if (!host) return 0;
    var count = null;
    if (api.hasAttribute(host, "generator.count")) count = api.get(host, "generator.count");
    if (!count && api.hasAttribute(host, "generator.input.count")) count = api.get(host, "generator.input.count");
    if (!count || !count.x || !count.y) return 0;
    return Math.max(1, Math.round(count.x * count.y));
  }
  function injectSubMeshVisibility(compId, json, frames) {
    var frame = api.getFrame();
    var changed = 0;
    try {
      compLayers(compId).forEach(function(id) {
        if (api.getLayerType(id) !== "subMesh") return;
        var masks = subMeshDriverMasks(id, frames, compId);
        if (!masks) return;
        var count = masks[0].length;
        var layer = null;
        var best = null;
        json.layers.forEach(function(L) {
          if (L.ty !== 4) return;
          var groups2 = allCopyGroups(L.shapes);
          if (groups2.length < count) return;
          var d = groups2.length - count;
          if (best === null || d < best) {
            best = d;
            layer = L;
          }
        });
        if (!layer) {
          console.log("[submesh-vis] subMesh " + id + ": no shape layer with " + count + "+ copy groups");
          return;
        }
        var groups = allCopyGroups(layer.shapes).slice(0, count);
        var byIndex = {};
        groups.forEach(function(g, gi) {
          var m = masks.map(function(mask) {
            return mask[gi];
          });
          byIndex[gi] = m;
        });
        changed += applyMasksToGroups(groups, byIndex, frames);
      });
    } finally {
      api.setFrame(frame);
    }
    return changed;
  }
  function allCopyGroups(items, out) {
    out = out || [];
    (items || []).forEach(function(outer) {
      if (outer.ty !== "gr") return;
      (outer.it || []).forEach(function(g) {
        if (g.ty === "gr") out.push(g);
      });
    });
    return out;
  }
  function glyphGroups(items, out) {
    out = out || [];
    (items || []).forEach(function(s) {
      if (s.ty !== "gr") return;
      var sh = s.it.filter(function(c) {
        return c.ty === "sh";
      })[0];
      if (sh && sh.ks && sh.ks.a === 1) out.push(s);
      else glyphGroups(s.it, out);
    });
    return out;
  }
  function graphSamplerFromSerialised(graphAttr) {
    if (!graphAttr || !graphAttr.list || !graphAttr.list.length) return null;
    var pts = graphAttr.list.map(function(entry) {
      var c = entry && entry.compound;
      if (!c || !c.position || !c.position.value) return null;
      return { x: c.position.value.x, y: c.position.value.y };
    }).filter(Boolean);
    if (!pts.length) return null;
    pts.sort(function(a, b) {
      return a.x - b.x;
    });
    return function(x) {
      if (x <= pts[0].x) return pts[0].y;
      if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
      for (var i = 1; i < pts.length; i++) {
        if (x <= pts[i].x) {
          var a = pts[i - 1], b = pts[i];
          var t = (x - a.x) / (b.x - a.x || 1);
          return a.y + (b.y - a.y) * t;
        }
      }
      return pts[pts.length - 1].y;
    };
  }
  function staticFalloffOf(nodeId, slot, frames) {
    var conn = (api.getInConnection(nodeId, slot) || "").split(".")[0];
    if (!conn) return { enabled: true, sampler: null, rect: null };
    if (api.getLayerType(conn) !== "falloff") return null;
    var f = conn;
    if (!api.get(f, "enabled")) return { enabled: false, sampler: null, rect: null };
    var frame = api.getFrame();
    var dynamic = ["strength", "size", "position", "rotation", "seed", "useProbability", "repetitions", "enabled"].some(function(attr) {
      if (!api.hasAttribute(f, attr)) return false;
      var first = null;
      for (var i = 0; i < frames.length; i++) {
        api.setFrame(frames[i].frame);
        var v = JSON.stringify(api.get(f, attr));
        if (first === null) first = v;
        else if (v !== first) return true;
      }
      return false;
    });
    api.setFrame(frame);
    if (dynamic) return null;
    var ser = api.serialise([f], false);
    var graphSampler2 = null;
    try {
      var parsed = JSON.parse(ser);
      var fnode = (parsed.nodes || []).filter(function(n) {
        return n && n.nodeId === f;
      })[0];
      if (fnode) graphSampler2 = graphSamplerFromSerialised(fnode.attributes && fnode.attributes.graph);
    } catch (e) {
    }
    if (graphSampler2 === null) {
      if (api.isAttrDefault(f, "graph")) {
        graphSampler2 = function(x) {
          return 1 - x;
        };
      } else {
        return null;
      }
    }
    var shapeType = api.get(f, "shapeType");
    var size = api.get(f, "size");
    var pos = api.get(f, "position");
    var rot = api.get(f, "rotation");
    if (shapeType !== 1) return null;
    if (rot && (rot.x || rot.y || rot.z)) return null;
    if (!size || !size.x || !size.y) return null;
    return {
      enabled: true,
      sampler: graphSampler2,
      rect: { cx: pos ? pos.x : 0, cy: pos ? pos.y : 0, hw: size.x, hh: size.y }
    };
  }
  function groupCentroids(sh) {
    if (!sh || !sh.ks || !sh.ks.k) return null;
    var paths = sh.ks.a === 1 ? sh.ks.k.map(function(kf) {
      return kf && kf.s && kf.s[0];
    }) : [sh.ks.k];
    if (!paths.length) return null;
    var out = [];
    for (var i = 0; i < paths.length; i++) {
      var v = paths[i] && paths[i].v;
      if (!v || !v.length) return null;
      var cx = 0, cy = 0;
      v.forEach(function(p) {
        cx += p[0];
        cy += p[1];
      });
      out.push([cx / v.length, cy / v.length]);
    }
    return out;
  }
  function falloffValueAt(fo, x, y) {
    var nx = Math.abs(x - fo.rect.cx) / fo.rect.hw;
    var ny = Math.abs(y - fo.rect.cy) / fo.rect.hh;
    var n = Math.max(Math.min(nx, 1), Math.min(ny, 1));
    return fo.sampler(n);
  }
  function cullFalloffHidden(compId, json, frames) {
    var frame = api.getFrame();
    var changed = 0;
    try {
      var sceneLayers = compLayers(compId);
      var hiddenZones = [];
      sceneLayers.forEach(function(id) {
        if (api.getLayerType(id) !== "subMesh") return;
        var src = (api.getInConnection(id, "shapeVisibility") || api.getInConnection(id, "shapeOpacity") || "").split(".")[0];
        if (!src) return;
        if (api.getLayerType(src) !== "value") return;
        if (!api.hasAttribute(src, "falloffs")) return;
        var value = api.get(src, "value");
        if (value !== 1 && value !== 100) return;
        var falloffs = [];
        for (var i = 0; api.hasAttribute(src, "falloffs." + i + ".id"); i++) {
          var fo = staticFalloffOf(src, "falloffs." + i + ".id", frames);
          if (!fo || !fo.enabled) return;
          if (fo.rect) falloffs.push(fo);
        }
        if (!falloffs.length) return;
        hiddenZones.push({ falloffs, subMesh: id });
      });
      if (!hiddenZones.length) return 0;
      json.layers.forEach(function(layer) {
        if (layer.ty !== 4) return;
        var groups = [];
        (function walk(items) {
          (items || []).forEach(function(g) {
            if (g.ty === "gr") {
              groups.push(g);
              walk(g.it);
            }
          });
        })(layer.shapes);
        if (groups.length < 4) return;
        groups.forEach(function(g) {
          if (g.hd) return;
          var sh = null;
          for (var i = 0; i < (g.it || []).length; i++) if (g.it[i].ty === "sh") {
            sh = g.it[i];
            break;
          }
          var cents = groupCentroids(sh);
          if (!cents) return;
          var hidden = false;
          for (var ci = 0; ci < cents.length; ci++) {
            var cx = cents[ci][0], cy = cents[ci][1];
            var zero = true;
            hiddenZones.forEach(function(zone) {
              var product = 1;
              zone.falloffs.forEach(function(fo) {
                product *= falloffValueAt(fo, cx, cy);
              });
              if (product !== 0) zero = false;
            });
            if (!zero) return;
            hidden = true;
          }
          if (hidden) {
            g.hd = true;
            changed++;
          }
        });
      });
      json.layers = json.layers.filter(function(L) {
        if (L.ty !== 0 || !L.refId) return true;
        if (L.parent != null) return true;
        var p = L.ks && L.ks.p;
        if (!p || p.a === 1 || p.x) return true;
        var pk = asArrayK(p.k);
        if (pk.length < 2) return true;
        var anchor = refAnchor(json, L.refId);
        if (!anchor) return true;
        var cx = pk[0] + anchor.x;
        var cy = pk[1] + anchor.y;
        for (var z = 0; z < hiddenZones.length; z++) {
          var product = 1;
          for (var i = 0; i < hiddenZones[z].falloffs.length; i++) product *= falloffValueAt(hiddenZones[z].falloffs[i], cx, cy);
          if (product === 0) {
            changed++;
            return false;
          }
        }
        return true;
      });
    } finally {
      api.setFrame(frame);
    }
    return changed;
  }
  function asArrayK(k) {
    if (Array.isArray(k)) return k;
    if (typeof k === "number") return [k, 0, 0];
    return [];
  }
  function refAnchor(json, refId) {
    var a = (json.assets || []).filter(function(x) {
      return x.id === refId;
    })[0];
    if (!a || !a.layers || a.layers.length !== 1) return null;
    var il = a.layers[0];
    var p = il.ks && il.ks.p;
    if (!p || p.a === 1 || p.x) return null;
    var k = asArrayK(p.k);
    if (k.length < 2) return null;
    return { x: k[0], y: k[1] };
  }
  function restructureDuplicators(compId, json, frames, opts) {
    var changed = 0;
    var saved = 0;
    var frame = api.getFrame();
    try {
      if (!opts.duplicators) return 0;
      var sceneLayers = compLayers(compId);
      console.log("[restructure] compLayers returned " + sceneLayers.length + " items for compId=" + compId);
      var duplicators = sceneLayers.filter(function(id) {
        var t = api.getLayerType(id);
        return t === "duplicator";
      });
      console.log("[restructure] found " + duplicators.length + " duplicators");
      var allTypes = {};
      sceneLayers.forEach(function(id) {
        var t = api.getLayerType(id);
        if (!allTypes[t]) allTypes[t] = 0;
        allTypes[t]++;
      });
      console.log("[restructure] scene layer types: " + JSON.stringify(allTypes));
      var dupInfos = [];
      duplicators.forEach(function(dupId) {
        for (var s = 0; s < 4; s++) {
          var srcConn = null;
          try {
            srcConn = api.getInConnection(dupId, "shapes." + s);
          } catch (e) {
            break;
          }
          if (!srcConn) break;
          if (api.getLayerType(String(srcConn).replace(/\.id$/, "")) === "compositionReference") {
            console.log("[restructure] duplicator " + dupId + " feeds on a composition reference \u2014 left to the precomp pass");
            return;
          }
        }
        var count = null;
        if (api.hasAttribute(dupId, "generator.count")) count = api.get(dupId, "generator.count");
        if (!count) return;
        var xCount = count.x || count["x"] || 0;
        var yCount = count.y || count["y"] || 0;
        var total = xCount * yCount;
        if (total < 4) return;
        console.log("[restructure] duplicator " + dupId + " has count=" + total + ", checking " + json.layers.length + " layers");
        var lottieLayer = null;
        for (var li = 0; li < json.layers.length; li++) {
          if (json.layers[li].ty === 4) {
            var shps = json.layers[li].shapes || [];
            var grpCount = 0;
            for (var si2 = 0; si2 < shps.length; si2++) {
              if (shps[si2].ty === "gr" || shps[si2].ty === "ms") grpCount++;
              var items = shps[si2].it || [];
              for (var ji = 0; ji < items.length; ji++) {
                if (items[ji].ty === "gr" || items[ji].ty === "ms") grpCount++;
              }
            }
            console.log("[restructure]   layer[" + li + "] ty=4 shapes=" + shps.length + " grp=" + grpCount + " match=" + (grpCount >= total - 20 && grpCount <= total + 20));
            if (grpCount >= total - 20 && grpCount <= total + 20) {
              lottieLayer = json.layers[li];
              break;
            }
          }
        }
        if (!lottieLayer) return;
        function allGroups(items2, out) {
          out = out || [];
          (items2 || []).forEach(function(g) {
            if (g.ty === "gr" || g.ty === "ms") {
              out.push(g);
              allGroups(g.it, out);
            }
          });
          return out;
        }
        var animGroups = allGroups(lottieLayer.shapes || []).filter(function(g) {
          var tr = null;
          for (var ii = 0; ii < (g.it || []).length; ii++) {
            if (g.it[ii].ty === "tr") {
              tr = g.it[ii];
              break;
            }
          }
          if (!tr) return false;
          var p = tr.p;
          if (!p) return false;
          if (p.a === 1 && p.k && Array.isArray(p.k) && p.k.length >= 2) return true;
          if (p.a === 0 && p.k && Array.isArray(p.k) && (p.k.length === 2 || p.k.length === 3)) return true;
          return false;
        });
        console.log("[restructure]   ag=" + animGroups.length);
        if (animGroups.length < 10) return;
        dupInfos.push({
          dupId,
          xCount,
          yCount,
          total,
          layer: lottieLayer,
          groups: animGroups
        });
        console.log("[restructure]   pushed dupInfos[" + dupInfos.length + "]: dupId=" + dupId + " groups=" + animGroups.length);
      });
      console.log("[restructure]   processing " + dupInfos.length + " dupInfos");
      for (var di = 0; di < dupInfos.length; di++) {
        try {
          let getGroupOffset = function(g) {
            var tr = null;
            for (var ti = 0; ti < (g.it || []).length; ti++) {
              if (g.it[ti].ty === "tr") {
                tr = g.it[ti];
                break;
              }
            }
            if (!tr) return { x: 0, y: 0 };
            var groupX, groupY;
            if (tr.p && tr.p.a === 0 && tr.p.k && Array.isArray(tr.p.k)) {
              groupX = tr.p.k[0];
              groupY = tr.p.k[1];
            } else if (tr.p && tr.p.k && Array.isArray(tr.p.k) && tr.p.k.length > 0) {
              groupX = tr.p.k[0].s[0];
              groupY = tr.p.k[0].s[1];
            } else {
              return { x: 0, y: 0 };
            }
            return { x: groupX - curveBaseX, y: groupY - curveBaseY };
          };
          var dup = dupInfos[di];
          var layer = dup.layer;
          var groups = dup.groups;
          console.log("[restructure]   dup " + di + ": groups.length=" + groups.length);
          if (groups.length < 4) continue;
          console.log("[restructure]   dup " + di + ": scanning " + groups.length + " groups for srcGroup with sh+fl");
          var srcGroup = null;
          var srcGroupIdx = -1;
          for (var gi = 0; gi < groups.length; gi++) {
            var hasSh = false;
            var hasFl = false;
            var hasG = false;
            for (var si = 0; si < (groups[gi].it || []).length; si++) {
              if (groups[gi].it[si].ty === "sh") hasSh = true;
              if (groups[gi].it[si].ty === "fl") hasFl = true;
              if (groups[gi].it[si].ty === "gr") hasG = true;
            }
            if (hasSh && hasFl) {
              srcGroup = groups[gi];
              srcGroupIdx = gi;
              break;
            }
          }
          console.log("[restructure]   dup " + di + ": srcGroup at index " + srcGroupIdx + " (found=" + (srcGroup !== null) + ")");
          if (!srcGroup) {
            console.log("[restructure]   dup " + di + ": SKIP no srcGroup found");
            continue;
          }
          var srcShape = null;
          var srcFill = null;
          for (var sfi = 0; sfi < (srcGroup.it || []).length; sfi++) {
            if (srcGroup.it[sfi].ty === "sh") srcShape = srcGroup.it[sfi];
            if (srcGroup.it[sfi].ty === "fl") srcFill = srcGroup.it[sfi];
          }
          console.log("[restructure]   dup " + di + ": srcShape=" + (srcShape !== null) + " srcFill=" + (srcFill !== null));
          if (!srcShape) {
            console.log("[restructure]   dup " + di + ": SKIP no sh item in srcGroup");
            continue;
          }
          var srcTr = null;
          for (var sti = 0; sti < (srcGroup.it || []).length; sti++) {
            if (srcGroup.it[sti].ty === "tr") {
              srcTr = srcGroup.it[sti];
              break;
            }
          }
          console.log("[restructure]   dup " + di + ": srcTr found=" + (srcTr !== null));
          if (!srcTr) continue;
          var srcPosKeys = null;
          var srcScaleKeys = null;
          var srcPosStatic = null;
          var srcScaleStatic = null;
          if (srcTr.p && srcTr.p.a === 1 && srcTr.p.k && Array.isArray(srcTr.p.k) && srcTr.p.k.length >= 2) {
            srcPosKeys = srcTr.p.k;
          } else if (srcTr.p && srcTr.p.a === 0 && srcTr.p.k && Array.isArray(srcTr.p.k)) {
            srcPosStatic = srcTr.p.k;
          }
          if (srcTr.s && srcTr.s.a === 1 && srcTr.s.k && Array.isArray(srcTr.s.k) && srcTr.s.k.length >= 2) {
            srcScaleKeys = srcTr.s.k;
          } else if (srcTr.s && srcTr.s.a === 0 && srcTr.s.k && Array.isArray(srcTr.s.k)) {
            srcScaleStatic = srcTr.s.k;
          }
          console.log("[restructure]   dup " + di + ": srcPosKeys=" + (srcPosKeys ? srcPosKeys.length : "null") + ", srcScaleKeys=" + (srcScaleKeys ? srcScaleKeys.length : "null") + ", srcPosStatic=" + (srcPosStatic ? JSON.stringify(srcPosStatic) : "null") + ", srcScaleStatic=" + (srcScaleStatic ? JSON.stringify(srcScaleStatic) : "null"));
          var sharedPosKeys = srcPosKeys;
          var sharedScaleKeys = srcScaleKeys;
          if (!srcPosKeys && !srcScaleKeys) {
            console.log("[restructure]   dup " + di + ": source has no animation, searching animated copies...");
            for (var diag_i = 0; diag_i < Math.min(5, groups.length); diag_i++) {
              var diagTr = null;
              for (var diag_ti = 0; diag_ti < (groups[diag_i].it || []).length; diag_ti++) {
                if (groups[diag_i].it[diag_ti].ty === "tr") {
                  diagTr = groups[diag_i].it[diag_ti];
                  break;
                }
              }
              var diagPA = diagTr && diagTr.p ? diagTr.p.a : "no_p";
              var diagPK = diagTr && diagTr.p && diagTr.p.k ? Array.isArray(diagTr.p.k) ? diagTr.p.k.length : "not_arr" : "no_k";
              console.log("[restructure]   dup " + di + ":   diag[" + diag_i + "] tr.p.a=" + diagPA + " tr.p.k.length=" + diagPK);
            }
            for (var ai = 0; ai < groups.length; ai++) {
              if (groups[ai] === srcGroup) continue;
              var agTr = null;
              for (var ati = 0; ati < (groups[ai].it || []).length; ati++) {
                if (groups[ai].it[ati].ty === "tr") {
                  agTr = groups[ai].it[ati];
                  break;
                }
              }
              if (agTr && agTr.p && agTr.p.a === 1 && agTr.p.k && Array.isArray(agTr.p.k) && agTr.p.k.length >= 2) {
                sharedPosKeys = agTr.p.k;
                console.log("[restructure]   dup " + di + ": extracted sharedPosKeys=" + agTr.p.k.length);
                break;
              }
              if (agTr && agTr.s && agTr.s.a === 1 && agTr.s.k && Array.isArray(agTr.s.k) && agTr.s.k.length >= 2) {
                sharedScaleKeys = agTr.s.k;
                console.log("[restructure]   dup " + di + ": extracted sharedScaleKeys=" + agTr.s.k.length);
                break;
              }
            }
            if (!sharedPosKeys && !sharedScaleKeys) console.log("[restructure]   dup " + di + ": no animated copies found");
          }
          console.log("[restructure]   dup " + di + ": FINAL sharedPosKeys=" + (sharedPosKeys ? sharedPosKeys.length : "null") + ", sharedScaleKeys=" + (sharedScaleKeys ? sharedScaleKeys.length : "null"));
          var numPosKeys = sharedPosKeys ? sharedPosKeys.length : 0;
          var numScaleKeys = sharedScaleKeys ? sharedScaleKeys.length : 0;
          console.log("[restructure]   dup " + di + ": checking line 587: !sharedPosKeys=" + !sharedPosKeys + ", !sharedScaleKeys=" + !sharedScaleKeys + ", !srcPosStatic=" + !srcPosStatic + ", !srcScaleStatic=" + !srcScaleStatic + " => " + (!sharedPosKeys && !sharedScaleKeys && !srcPosStatic && !srcScaleStatic));
          console.log("[restructure]   dup " + di + ": checking line 588: numPosKeys=" + numPosKeys + ", numScaleKeys=" + numScaleKeys + " => " + (numPosKeys === 0 && numScaleKeys === 0));
          if (!sharedPosKeys && !sharedScaleKeys && !srcPosStatic && !srcScaleStatic) {
            console.log("[restructure]   dup " + di + ": SKIP line 587 (no data at all)");
            continue;
          }
          if (numPosKeys === 0 && numScaleKeys === 0) {
            console.log("[restructure]   dup " + di + ": SKIP line 588 (no animation curves)");
            continue;
          }
          var curveBaseX, curveBaseY;
          if (srcPosKeys && srcPosKeys.length > 0) {
            curveBaseX = srcPosKeys[0].s[0];
            curveBaseY = srcPosKeys[0].s[1];
          } else if (sharedPosKeys && sharedPosKeys.length > 0) {
            curveBaseX = 0;
            curveBaseY = 0;
          } else {
            curveBaseX = 0;
            curveBaseY = 0;
          }
          var offsets = groups.map(getGroupOffset);
          if (numPosKeys === 0 && numScaleKeys === 0) {
            console.log("[restructure]   dup " + di + ": SKIP static-only (no animation curves)");
            continue;
          }
          var precompNid = "precomp_dup_" + di;
          console.log("[restructure]   dup " + di + ": creating precomp asset " + precompNid);
          if (!json.assets) json.assets = [];
          var precompPos, precompScale;
          if (srcPosStatic || srcScaleStatic) {
            var shiftedCurve;
            if (sharedPosKeys) {
              shiftedCurve = sharedPosKeys.map(function(k) {
                var nk = {};
                for (var kk in k) nk[kk] = k[kk];
                nk.s = [nk.s[0] - sharedPosKeys[0].s[0], nk.s[1] - sharedPosKeys[0].s[1]];
                return nk;
              });
              precompPos = { a: 1, k: shiftedCurve };
            } else {
              precompPos = { a: 0, k: [0, 0] };
            }
            var shiftedScale;
            if (sharedScaleKeys) {
              shiftedScale = sharedScaleKeys.map(function(k) {
                var nk = {};
                for (var kk in k) nk[kk] = k[kk];
                nk.s = [nk.s[0] - sharedScaleKeys[0].s[0], nk.s[1] - sharedScaleKeys[0].s[1], nk.s[2] - sharedScaleKeys[0].s[2]];
                return nk;
              });
              precompScale = { a: 1, k: shiftedScale };
            } else {
              precompScale = { a: 0, k: [100, 100, 100] };
            }
          } else {
            precompPos = srcTr.p;
            precompScale = srcTr.s;
          }
          var precomp = {
            id: precompNid,
            nm: "Duplicator_" + di + "_precomp",
            ty: 2,
            w: json.w || 1920,
            h: json.h || 1080,
            st: 0,
            sr: 1,
            ip: json.ip != null ? json.ip : 1,
            op: json.op != null ? json.op : 1,
            fr: json.fr || 30,
            bgColor: json.bgColor || [0, 0, 0, 1],
            layers: [
              {
                ind: 1,
                ty: 4,
                nm: "shared",
                ip: precomp.ip,
                op: precomp.op,
                st: 0,
                sr: 1,
                ks: {
                  p: precompPos,
                  s: precompScale,
                  r: { a: 0, k: 0 },
                  o: { a: 0, k: 100 }
                },
                shapes: [
                  {
                    ty: "gr",
                    it: srcFill ? [
                      JSON.parse(JSON.stringify(srcShape)),
                      JSON.parse(JSON.stringify(srcFill)),
                      {
                        ty: "tr",
                        p: { a: 0, k: [0, 0] },
                        a: { a: 0, k: [0, 0] },
                        s: { a: 0, k: [100, 100, 100] },
                        r: { a: 0, k: 0 },
                        o: { a: 0, k: 100 }
                      }
                    ] : [JSON.parse(JSON.stringify(srcShape))]
                  }
                ]
              }
            ]
          };
          json.assets.push(precomp);
          var newLayers = [];
          for (var oi = 0; oi < groups.length; oi++) {
            var off = offsets[oi];
            newLayers.push({
              ind: oi + 1,
              ty: 0,
              // comp layer
              nm: "copy_" + oi,
              ip: json.ip != null ? json.ip : 1,
              op: json.op != null ? json.op : 1,
              st: 0,
              sr: 1,
              refId: precompNid,
              ks: {
                p: { a: 0, k: [off.x, off.y, 0] },
                s: srcTr.s || { a: 0, k: [100, 100, 100] },
                r: { a: 0, k: 0 },
                o: { a: 0, k: 100 }
              }
            });
          }
          console.log("[restructure]   dup " + di + ": searching for shape layer in json.layers (length=" + json.layers.length + ")");
          for (var ni = 0; ni < json.layers.length; ni++) {
            if (json.layers[ni] === layer) {
              console.log("[restructure]   replacing shape layer at index " + ni + " with " + newLayers.length + " precomp refs");
              json.layers.splice(ni, 1);
              for (var nl = 0; nl < newLayers.length; nl++) {
                json.layers.splice(ni + nl, 0, newLayers[nl]);
              }
              console.log("[restructure]   replacement done. json.layers.length=" + json.layers.length + ", assets.length=" + (json.assets ? json.assets.length : 0));
              break;
            }
          }
          saved += (groups.length - 1) * (numPosKeys + numScaleKeys);
          changed++;
        } catch (err) {
          console.log("[restructure]   dup " + di + ": ERROR " + err.message + " \u2014 skipping this duplicator");
        }
      }
      console.log("[restructure]   total changed=" + changed + ", assets=" + (json.assets ? json.assets.length : 0));
      if (changed) {
        if (json.assets && json.assets.length) {
          var usedIds = /* @__PURE__ */ new Set();
          json.layers.forEach(function(L) {
            if (L.refId != null) usedIds.add(L.refId);
          });
          json.assets = json.assets.filter(function(a) {
            return usedIds.has(a.id);
          });
        }
      }
    } finally {
      api.setFrame(frame);
    }
    return saved;
  }

  // src/modules/duplicatorCompRefs.js
  var compOf = (ref) => String(api.getInConnection(ref, "composition") || "").replace(/\.id$/, "");
  function graphSampler(graphAttr) {
    if (!graphAttr || !graphAttr.list || !graphAttr.list.length) return null;
    const pts = graphAttr.list.map((entry) => {
      const c = entry && entry.compound;
      return c && c.position && c.position.value ? { x: c.position.value.x, y: c.position.value.y } : null;
    });
    if (!pts[0]) pts[0] = { x: 0, y: 0 };
    const kept = pts.filter(Boolean).sort((a, b) => a.x - b.x);
    if (!kept.length) return null;
    return (x) => {
      if (x <= kept[0].x) return kept[0].y;
      if (x >= kept[kept.length - 1].x) return kept[kept.length - 1].y;
      for (let i = 1; i < kept.length; i++) {
        if (x <= kept[i].x) {
          const a = kept[i - 1], b = kept[i];
          const t = (x - a.x) / (b.x - a.x || 1);
          return a.y + (b.y - a.y) * t;
        }
      }
      return kept[kept.length - 1].y;
    };
  }
  function timeOffsetsOf(dup, count, warn, name) {
    const frame = api.getFrame();
    try {
      if (!api.hasAttribute(dup, "shapeTimeOffset")) return new Array(count).fill(0);
      if (!api.isAnimatedAttribute || !api.isAnimatedAttribute(dup, "shapeTimeOffset")) {
        const conn = String(api.getInConnection(dup, "shapeTimeOffset") || "").replace(/\.id$/, "");
        if (!conn) return new Array(count).fill(Number(api.get(dup, "shapeTimeOffset")) || 0);
        const type = api.getLayerType(conn);
        if (type === "stagger") {
          let min = Number(api.get(conn, "minimum")) || 0;
          let max = Number(api.get(conn, "maximum")) || 0;
          if (min > max) {
            const t = min;
            min = max;
            max = t;
          }
          const strength = Number(api.get(conn, "strength")) || 0;
          const offset = Number(api.get(conn, "offset")) || 0;
          let sampler = null;
          try {
            const ser = JSON.parse(api.serialise([conn], false));
            const node = (ser.nodes || []).filter((n) => n && n.nodeId === conn)[0];
            if (node) sampler = graphSampler(node.attributes && node.attributes.graph);
          } catch (e) {
          }
          if (!sampler) return null;
          const out = [];
          for (let i = 0; i < count; i++) {
            const g = count > 1 ? i / (count - 1) : 0;
            out.push((min + (max - min) * sampler(g)) * (strength / 100) + offset);
          }
          return out;
        }
        warn("The time offset driver " + (api.getNiceName(conn) || conn) + " on " + name + " is not supported; the copies export with the baked timing");
        return null;
      }
      warn("The time offset on " + name + " is animated; the copies export with the baked timing");
      return null;
    } finally {
      api.setFrame(frame);
    }
  }
  function linearCentres(dup, count, axes) {
    const size = Number(api.get(dup, "generator.size")) || 0;
    const mode = api.get(dup, "generator.distributionMode");
    const step = mode === 1 ? size : count > 1 ? size / (count - 1) : 0;
    const centres = [];
    for (let i = 0; i < count; i++) {
      const c = { x: 0, y: 0 };
      c[axes] = count > 1 ? -size / 2 + i * step : 0;
      centres.push(c);
    }
    return centres;
  }
  function centresOf(dup, count, warn, name) {
    if (api.hasAttribute(dup, "generator.offset")) {
      warn("The grid distribution on " + name + " is not supported yet; it exports as baked shapes");
      return null;
    }
    if (api.hasAttribute(dup, "generator.radius")) {
      warn("The circle distribution on " + name + " is not supported yet; it exports as baked shapes");
      return null;
    }
    if (!api.hasAttribute(dup, "generator.size") || !api.hasAttribute(dup, "generator.count")) {
      warn("The distribution on " + name + " is not supported yet; it exports as baked shapes");
      return null;
    }
    const direction = Number(api.get(dup, "generator.direction")) || 0;
    return linearCentres(dup, count, direction === 1 ? "y" : "x");
  }
  function duplicatorCompRefs(comp, exported, sceneOf, newComp) {
    const warnings = [];
    const frame = api.getFrame();
    try {
      const ids = new Set(compLayers(comp));
      const dups = compLayers(comp).filter((id) => api.getLayerType(id) === "duplicator");
      const made = [];
      for (const dup of dups) {
        try {
          const sources = [];
          for (let s = 0; s < 16; s++) {
            let raw = null;
            try {
              raw = api.getInConnection(dup, "shapes." + s);
            } catch (e) {
              break;
            }
            if (raw == null || raw === "") break;
            sources.push(String(raw).replace(/\.id$/, ""));
          }
          if (!sources.length || sources.some((s) => api.getLayerType(s) !== "compositionReference")) continue;
          const inners = [...new Set(sources.map(compOf))];
          if (inners.some((c) => !c)) continue;
          const name = api.getNiceName(dup) || dup;
          const rawCount = api.get(dup, "generator.count");
          if (rawCount == null) continue;
          const countX = Math.max(1, Math.round(rawCount.x != null ? rawCount.x : rawCount));
          const countY = Math.max(1, Math.round(rawCount.y != null ? rawCount.y : 1));
          const direction = Number(api.get(dup, "generator.direction")) || 0;
          const count = direction === 1 ? countY : countX;
          if (count < 2 || count > 64) continue;
          const centres = centresOf(dup, count, warnings.push.bind(warnings), name);
          if (!centres) continue;
          const offsets = timeOffsetsOf(dup, count, warnings.push.bind(warnings), name);
          const layer = exported.layers.find((L) => L.ty === 4 && sceneOf.get(L) === dup) || exported.layers.find((L) => L.ty === 4 && sceneId(L.mn, ids) === dup);
          if (!layer) continue;
          const sp = api.get(dup, "shapePosition") || { x: 0, y: 0 };
          const ss = api.get(dup, "shapeScale") || { x: 1, y: 1 };
          const sr = Number(api.get(dup, "shapeRotation")) || 0;
          const so = Number(api.get(dup, "shapeOpacity"));
          const shapeStatic = (api.getAnimatedAttributes(dup) || []).filter((a) => a.indexOf("shape") === 0).length === 0;
          const built = inners.map((inner) => newComp(inner, dup));
          const copies = [];
          for (let i = 0; i < count; i++) {
            const src = sources[i % sources.length];
            const inner = compOf(src);
            const asset = built[inners.indexOf(inner)];
            const dx = centres[i].x + (sp.x || 0);
            const dy = -(centres[i].y + (sp.y || 0));
            const L = {
              ind: 0,
              // assigned below
              ty: 0,
              nm: name + "_" + i,
              refId: asset.id,
              w: asset.w,
              h: asset.h,
              ip: layer.ip,
              op: layer.op,
              st: 0,
              sr: 1,
              ks: JSON.parse(JSON.stringify(layer.ks || {}))
            };
            L.ks = L.ks || {};
            L.ks.a = { a: 0, k: [asset.w / 2, asset.h / 2, 0] };
            L.ks.p = addP(L.ks.p, dx, dy);
            if (shapeStatic) {
              if (ss && (ss.x !== 1 || ss.y !== 1)) L.ks.s = mulS(L.ks.s, ss.x * 100, ss.y * 100);
              if (sr) L.ks.r = { a: 0, k: sr };
            }
            if (so != null && so !== 100) L.ks.o = { a: 0, k: so };
            if (offsets) L.st = Math.round(offsets[i] * 100) / 100;
            copies.push(L);
          }
          const at2 = exported.layers.indexOf(layer);
          const base = Math.max(0, ...exported.layers.map((q) => q.ind || 0));
          copies.forEach((q, j) => {
            q.ind = base + 1 + j;
          });
          exported.layers.splice(at2, 1, ...copies);
          sceneOf.delete(layer);
          made.push(dup);
        } catch (err) {
          warnings.push("The duplicator " + (api.getNiceName(dup) || dup) + " could not be exported as precomps (" + err.message + "); it exports as baked shapes");
        }
      }
      return { refs: made.length, warnings };
    } finally {
      api.setFrame(frame);
    }
  }
  function sceneId(mn, ids) {
    if (!mn) return null;
    if (ids.has(mn)) return mn;
    for (let s = mn.slice(0, -1); /#\d+$/.test(s); s = s.slice(0, -1)) if (ids.has(s)) return s;
    return null;
  }
  function addP(p, dx, dy) {
    if (!p) return { a: 0, k: [dx, dy, 0] };
    if (p.a === 0 && !Array.isArray(p.k)) return Object.assign({}, p, { k: [p.k[0] + dx, p.k[1] + dy, 0] });
    if (p.a === 0) return Object.assign({}, p, { k: [p.k[0] + dx, p.k[1] + dy, 0] });
    const add = (v) => [v[0] + dx, v[1] + dy];
    return Object.assign({}, p, {
      k: p.k.map((kf) => Object.assign({}, kf, kf.s ? { s: add(kf.s) } : {}, kf.e ? { e: add(kf.e) } : {}))
    });
  }
  function mulS(s, mx, my) {
    const base = s && s.a === 0 ? s.k : [100, 100, 100];
    return { a: 0, k: [base[0] * mx / 100, base[1] * my / 100, 100] };
  }

  // src/modules/taper.js
  function widthCurve(points) {
    const pts = points.slice().sort((a, b) => a.x - b.x);
    const bez = (a, b, c, d, u) => (1 - u) ** 3 * a + 3 * (1 - u) ** 2 * u * b + 3 * (1 - u) * u * u * c + u ** 3 * d;
    return (X) => {
      if (X <= pts[0].x) return pts[0].y;
      if (X >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
      let j = 0;
      while (X > pts[j + 1].x) j++;
      const p = pts[j], q = pts[j + 1];
      const xs = [p.x, p.x + p.rx, q.x + q.lx, q.x], ys = [p.y, p.y + p.ry, q.y + q.ly, q.y];
      let lo = 0, hi = 1;
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2;
        if (bez(...xs, m) < X) lo = m;
        else hi = m;
      }
      return bez(...ys, (lo + hi) / 2);
    };
  }
  function flatten(shape, steps) {
    const { v, i, o, c } = shape;
    const pts = [v[0]], len = [0];
    const n = c ? v.length : v.length - 1;
    for (let j = 0; j < n; j++) {
      const a = v[j], b = v[(j + 1) % v.length];
      const p1 = [a[0] + o[j][0], a[1] + o[j][1]], p2 = [b[0] + i[(j + 1) % v.length][0], b[1] + i[(j + 1) % v.length][1]];
      for (let k = 1; k <= steps; k++) {
        const u = k / steps, w = [(1 - u) ** 3, 3 * (1 - u) ** 2 * u, 3 * (1 - u) * u * u, u ** 3];
        const q = [0, 1].map((d) => w[0] * a[d] + w[1] * p1[d] + w[2] * p2[d] + w[3] * b[d]);
        const prev = pts[pts.length - 1];
        pts.push(q);
        len.push(len[len.length - 1] + Math.hypot(q[0] - prev[0], q[1] - prev[1]));
      }
    }
    return { pts, len, total: len[len.length - 1] };
  }
  function at(poly, f) {
    const L = Math.min(Math.max(f, 0), 1) * poly.total;
    let j = 1;
    while (j < poly.len.length - 1 && poly.len[j] < L) j++;
    const a = poly.pts[j - 1], b = poly.pts[j], seg = poly.len[j] - poly.len[j - 1] || 1;
    const u = (L - poly.len[j - 1]) / seg;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], d: [(b[0] - a[0]) / d, (b[1] - a[1]) / d] };
  }
  function trimWindows(trim) {
    if (!trim) return [[0, 1]];
    let a = Math.min(trim.start, trim.end), b = Math.max(trim.start, trim.end);
    if (b - a >= 100) return [[0, 1]];
    if (b - a <= 0) return [];
    a = (a + trim.travel) / 100;
    b = (b + trim.travel) / 100;
    const k = Math.floor(a);
    a -= k;
    b -= k;
    return b <= 1 ? [[a, b]] : [[a, 1], [0, b - 1]];
  }
  function smooth(points) {
    const n = points.length;
    const t = points.map((_, j) => {
      const a = points[(j - 1 + n) % n], b = points[(j + 1) % n];
      return [(b[0] - a[0]) / 6, (b[1] - a[1]) / 6];
    });
    return { c: true, v: points, i: t.map(([x, y]) => [-x, -y]), o: t };
  }
  function taperOutlines(shape, width, curve, trim, round, opts = {}) {
    const n = opts.samples || 32, capSteps = opts.capSteps || 6;
    if (!shape || !shape.v || shape.v.length < 2) return [];
    const poly = flatten(shape, opts.flatten || 24);
    if (!(poly.total > 0)) return [];
    const half = (f) => width * Math.max(curve(f), 0) / 2;
    const side = (f, s) => {
      const { p, d } = at(poly, f);
      const h = half(f);
      return [p[0] - d[1] * h * s, p[1] + d[0] * h * s];
    };
    const cap = (f, out2) => {
      const { p, d } = at(poly, f);
      const h = half(f), pts = [];
      for (let k = 1; k < capSteps; k++) {
        const ang = Math.PI / 2 - Math.PI * k / capSteps;
        const along = Math.cos(ang) * h * out2, across = Math.sin(ang) * h * out2;
        pts.push([p[0] + d[0] * along - d[1] * across, p[1] + d[1] * along + d[0] * across]);
      }
      return pts;
    };
    const out = [];
    for (const [a, b] of trimWindows(trim)) {
      const fs = Array.from({ length: n + 1 }, (_, k) => a + (b - a) * k / n);
      if (shape.c && a === 0 && b === 1) {
        out.push(smooth(fs.slice(0, n).map((f) => side(f, 1))), smooth(fs.slice(0, n).map((f) => side(f, -1)).reverse()));
        continue;
      }
      const left = fs.map((f) => side(f, 1)), right = fs.map((f) => side(f, -1)).reverse();
      const blank = () => Array.from({ length: capSteps - 1 }, () => left[0]);
      const endCap = round ? cap(b, 1) : blank().map(() => left[n]);
      const startCap = round ? cap(a, -1) : blank().map(() => right[n]);
      out.push(smooth(left.concat(endCap, right, startCap)));
    }
    return out;
  }
  function emptyLike(shape) {
    const p = shape.v[0];
    return { c: true, v: shape.v.map(() => p.slice()), i: shape.v.map(() => [0, 0]), o: shape.v.map(() => [0, 0]) };
  }

  // src/modules/precomps.js
  var isAnimated = (p) => p && Array.isArray(p.k) && p.k.length && typeof p.k[0] === "object" && "t" in p.k[0];
  var isImageAsset = (a) => a && !a.layers && typeof a.p === "string" && a.p.indexOf("data:") !== 0;
  function sceneId2(mn, ids) {
    if (!mn) return null;
    if (ids.has(mn)) return mn;
    for (let s = mn.slice(0, -1); /#\d+$/.test(s); s = s.slice(0, -1)) if (ids.has(s)) return s;
    return null;
  }
  var compOf2 = (ref) => String(api.getInConnection(ref, "composition") || "").replace(/\.id$/, "");
  function compSize(comp) {
    const r = api.get(comp, "resolution");
    return [r.x, r.y];
  }
  function shift(prop, dx, dy) {
    const add = (v) => {
      const out = (Array.isArray(v) ? v : [v]).slice();
      out[0] = (out[0] || 0) + dx;
      out[1] = (out[1] || 0) + dy;
      return out;
    };
    if (!prop) return { a: 0, k: [dx, dy, 0] };
    if (!isAnimated(prop)) return Object.assign({}, prop, { k: add(prop.k) });
    return Object.assign({}, prop, {
      k: prop.k.map((kf) => Object.assign({}, kf, kf.s ? { s: add(kf.s) } : {}, kf.e ? { e: add(kf.e) } : {}))
    });
  }
  function shiftPosition(p, dx, dy) {
    if (p && p.s) {
      const one = (q, d) => isAnimated(q) ? Object.assign({}, q, { k: q.k.map((kf) => Object.assign({}, kf, { s: [kf.s[0] + d] })) }) : Object.assign({}, q, { k: (Array.isArray(q.k) ? q.k[0] : q.k) + d });
      return Object.assign({}, p, { x: one(p.x, dx), y: one(p.y, dy) });
    }
    return shift(p, dx, dy);
  }
  function shiftMasks(masks, dx, dy) {
    const sh = (s) => Object.assign({}, s, { v: s.v.map((p) => [p[0] + dx, p[1] + dy]) });
    return masks.map((m) => {
      const pt = m.pt;
      if (!pt) return m;
      const k = isAnimated(pt) ? pt.k.map((kf) => Object.assign({}, kf, { s: kf.s.map(sh) })) : sh(pt.k);
      return Object.assign({}, m, { pt: Object.assign({}, pt, { k }) });
    });
  }
  function easeBetween(a, b) {
    const da = api.get(a, "data"), db = api.get(b, "data");
    const ta = api.get(a, "frame"), tb = api.get(b, "frame");
    if (da.interpolation === 2) return { h: 1 };
    if (da.interpolation === 1 || !da.rightBez || !db.leftBez) return { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } };
    const dt = tb - ta || 1, dv = db.numValue - da.numValue;
    const ny = (v, fb) => Math.abs(dv) < 1e-9 ? fb : v / dv;
    return {
      o: { x: [da.rightBez.x / dt], y: [ny(da.rightBez.y, da.rightBez.x / dt)] },
      i: { x: [1 + db.leftBez.x / dt], y: [1 + ny(db.leftBez.y, db.leftBez.x / dt)] }
    };
  }
  function sceneKeys(id, attr, map) {
    const ids = api.getKeyframeIdsForAttribute(id, attr);
    const keys = ids.map((k, j) => {
      const kf = { t: api.get(k, "frame"), s: [map(api.get(k, "data").numValue)] };
      if (j < ids.length - 1) Object.assign(kf, easeBetween(k, ids[j + 1]));
      return kf;
    });
    return keys.length === 1 ? { a: 0, k: keys[0].s[0] } : { a: 1, k: keys };
  }
  function sceneRotationScale(L, id) {
    if (!L.ks) return false;
    const anim = api.getAnimatedAttributes(id) || [];
    const conn = api.getInConnectedAttributes(id) || [];
    const free = (a) => !anim.some((x) => x.indexOf(a) === 0) && !conn.some((x) => x.indexOf(a) === 0);
    let changed = false;
    try {
      if (free("rotation") && !isAnimated(L.ks.r)) {
        const r = -api.get(id, "rotation").z;
        if (Math.abs(((valueAt(L.ks.r, 0) || [0])[0] || 0) - r) > 1e-4) L.ks.r = { a: 0, k: r }, changed = true;
      }
      if (free("scale") && !isAnimated(L.ks.s)) {
        const sc = api.get(id, "scale");
        const want = [sc.x * 100, sc.y * 100, 100];
        const cur = valueAt(L.ks.s, 0) || [100, 100];
        if (Math.abs(cur[0] - want[0]) > 1e-4 || Math.abs(cur[1] - want[1]) > 1e-4) L.ks.s = { a: 0, k: want }, changed = true;
      }
    } catch (e) {
    }
    return changed;
  }
  function lottieRSK(rotDeg, sx, sy, kx, ky) {
    const th = rotDeg * Math.PI / 180, c = Math.cos(th), sn = Math.sin(th);
    const RS = [c * sx, -sn * sy, sn * sx, c * sy];
    const A = [RS[0] + RS[1] * ky, RS[0] * kx + RS[1], RS[2] + RS[3] * ky, RS[2] * kx + RS[3]];
    const L = [A[0], -A[1], -A[2], A[3]];
    const r = Math.atan2(L[2], L[0]), lc = Math.cos(r), ls = Math.sin(r);
    const x2 = lc * L[1] + ls * L[3], y2 = -ls * L[1] + lc * L[3];
    const lsx = Math.hypot(L[0], L[2]);
    return { r: r * 180 / Math.PI, s: [lsx * 100, y2 * 100], sk: Math.atan(-x2 / (y2 || 1e-12)) * 180 / Math.PI };
  }
  function sceneSkew(L, id, range) {
    if (!L.ks || !api.hasAttribute(id, "skew")) return false;
    const keyedOrDriven = (a) => (api.getAnimatedAttributes(id) || []).some((x) => x.indexOf(a) === 0) || drivenAttr(id, a);
    const skew = api.get(id, "skew") || {};
    const moving = keyedOrDriven("skew");
    if (!moving && Math.abs(skew.x || 0) < 1e-6 && Math.abs(skew.y || 0) < 1e-6) return false;
    const at2 = () => {
      const sk = api.get(id, "skew") || {}, sc = api.get(id, "scale") || {};
      return lottieRSK((api.get(id, "rotation") || {}).z || 0, sc.x != null ? sc.x : 1, sc.y != null ? sc.y : 1, sk.x || 0, sk.y || 0);
    };
    L.ks.sa = { a: 0, k: 0 };
    const sc0 = api.get(id, "scale") || {};
    const uniform = !keyedOrDriven("scale") && Math.abs((sc0.x || 1) - (sc0.y || 1)) < 1e-9;
    const deg = (v) => Math.atan(v) * 180 / Math.PI;
    if (uniform && !keyedOrDriven("skew.y") && Math.abs(skew.y || 0) < 1e-6 && !drivenAttr(id, "skew")) {
      const keyed = (api.getAnimatedAttributes(id) || []).indexOf("skew.x") >= 0;
      L.ks.sk = keyed ? sceneKeys(id, "skew.x", deg) : { a: 0, k: deg(skew.x) };
      return true;
    }
    if (!moving && !keyedOrDriven("rotation") && !keyedOrDriven("scale")) {
      const v = at2();
      L.ks.r = { a: 0, k: v.r };
      L.ks.s = { a: 0, k: [v.s[0], v.s[1], 100] };
      L.ks.sk = { a: 0, k: v.sk };
      return true;
    }
    if (!range) return false;
    const [comp, from, to] = range;
    api.setActiveComp(comp);
    const vals = [];
    for (let f = from; f <= to; f++) {
      api.setFrame(f);
      const v = at2();
      if (vals.length) while (v.r - vals[vals.length - 1].r > 180) v.r -= 360;
      if (vals.length) while (v.r - vals[vals.length - 1].r < -180) v.r += 360;
      vals.push(v);
    }
    L.ks.r = frameKeys(vals, from, (v) => [v.r]);
    L.ks.s = frameKeys(vals, from, (v) => [v.s[0], v.s[1], 100]);
    L.ks.sk = frameKeys(vals, from, (v) => [v.sk]);
    for (const f of ["r", "sk"]) if (!L.ks[f].a) L.ks[f] = { a: 0, k: L.ks[f].k[0] };
    return true;
  }
  function sceneFillRule(L, id) {
    if (!L.shapes || !api.hasAttribute(id, "fillRule") || api.get(id, "fillRule") !== 0) return;
    const walk = (items) => items.forEach((it) => it.ty === "fl" || it.ty === "gf" ? it.r = 2 : it.ty === "gr" && walk(it.it || []));
    walk(L.shapes);
  }
  function sceneGradients(L, id, comp, ref) {
    const shader = (slot) => {
      const g = fillShader(id, comp, ref, slot);
      if (!g || api.getLayerType(g) !== "gradientShader" || api.get(g, "screenSpace")) return null;
      return (api.getAnimatedAttributes(g) || []).length ? null : g;
    };
    const bb = api.getBoundingBox(id, false);
    const fill = shader("material"), stroke = shader("stroke");
    if (fill && isLinear(fill)) {
      const { s, e } = linearEnds(fill, bb);
      forItems(L.shapes, "gf", (it) => it.t === 1 && (it.s = { a: 0, k: s }, it.e = { a: 0, k: e }));
    }
    if (fill && api.hasAttribute(fill, "generator.radiusMode") && api.get(fill, "generator.radiusMode") === 1) {
      const off = api.get(fill, "generator.offset"), sc = api.get(fill, "generator.scale"), ratio = api.get(fill, "generator.radiusRatio");
      ellipseGradient(L, {
        c: [bb.centre.x + off.x, -(bb.centre.y + off.y)],
        rx: bb.width / 2 * (sc.x / 100) * ratio,
        ry: bb.height / 2 * (sc.y / 100) * ratio,
        rot: -api.get(fill, "generator.rotation")
        // y-up to y-down
      });
    }
    if (stroke && isLinear(stroke)) {
      const { s, e } = linearEnds(stroke, bb);
      const g = lottieStops(stroke);
      forItems(L.shapes, "st", (it, items, i) => {
        const { c, ...rest } = it;
        items[i] = { ...rest, ty: "gs", t: 1, g, s: { a: 0, k: s }, e: { a: 0, k: e } };
      });
    }
  }
  function sceneOutlinedStroke(L, id, comp, gradients) {
    if (!api.hasStroke(id)) return false;
    const tapered = api.hasAttribute(id, "stroke.taperedWidth") && api.get(id, "stroke.taperedWidth");
    const PAINT = ["st", "gs"];
    let home = null;
    const findHome = (items) => {
      for (const it of items || []) {
        if (home || it.ty !== "gr") continue;
        if ((it.it || []).some((x) => PAINT.includes(x.ty)) && (it.it || []).some((x) => x.ty === "sh" || x.ty === "el")) home = it;
        else findHome(it.it);
      }
    };
    findHome(L.shapes);
    if (!home) return false;
    const paint = home.it.find((x) => PAINT.includes(x.ty));
    if (!tapered && !(gradients && paint.ty === "gs")) return false;
    const paths = home.it.filter((x) => x.ty === "sh" || x.ty === "el");
    if (!paths.length) return false;
    const points = [];
    for (let k = 0; api.hasAttribute(id, "stroke.widthGraph." + k + ".position"); k++) {
      const g = (f) => api.get(id, "stroke.widthGraph." + k + "." + f) || { x: 0, y: 0 };
      const p = g("position"), l = g("left"), r = g("right");
      points.push({ x: p.x, y: p.y, lx: l.x, ly: l.y, rx: r.x, ry: r.y });
    }
    const curve = !tapered ? () => 1 : points.length > 1 ? widthCurve(points) : (x) => x;
    const round = api.get(id, "stroke.capStyle") !== 0;
    const from = Math.max(Math.ceil(L.ip), api.get(comp, "startFrame")), to = Math.min(Math.ceil(L.op) - 1, api.get(comp, "endFrame"));
    if (to < from) return false;
    api.setActiveComp(comp);
    const frames = [];
    for (let f = from; f <= to; f++) {
      api.setFrame(f);
      const width = api.get(id, "stroke.width");
      const trim = api.get(id, "stroke.trim") ? { start: api.get(id, "stroke.trimStart"), end: api.get(id, "stroke.trimEnd"), travel: api.get(id, "stroke.trimTravel") } : null;
      frames.push({ t: f, shapes: paths.flatMap((it) => taperOutlines(it.ty === "el" ? ellipseAt(it, f) : shapeAt(it.ks, f), width, curve, trim, round)) });
    }
    const slots = Math.max(0, ...frames.map((fr) => fr.shapes.length));
    if (!slots) return false;
    const like = [];
    for (const fr of frames) fr.shapes.forEach((sh, k) => like[k] = like[k] || sh);
    const outline = [];
    for (let k = 0; k < slots; k++) {
      const keys = frames.map((fr) => ({ t: fr.t, s: [fr.shapes[k] || emptyLike(like[k])], h: 1 }));
      outline.push({ ty: "sh", ks: keys.length === 1 ? { a: 0, k: keys[0].s[0] } : { a: 1, k: keys } });
    }
    const { c, w, lc, lj, ml, d, ty, ...gradient } = paint;
    const fill = ty === "gs" ? { ...gradient, ty: "gf", r: 1 } : { ty: "fl", c, o: paint.o, r: 1 };
    const hasPaint = (items) => (items || []).some((x) => ["fl", "gf", "st", "gs"].includes(x.ty) || x.ty === "gr" && hasPaint(x.it));
    const strip = (items) => (items || []).filter((it) => !PAINT.includes(it.ty) && it.ty !== "tm").map((it) => it.ty === "gr" ? { ...it, it: strip(it.it) } : it).filter((it) => it.ty !== "gr" || hasPaint(it.it));
    const rest = home.it.filter((x) => !PAINT.includes(x.ty) && x.ty !== "tm");
    const identity = { ty: "tr", p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } };
    home.it = [{ ty: "gr", it: outline.concat([fill, identity]) }].concat(hasPaint(rest) ? rest : rest.filter((x) => x.ty === "tr"));
    L.shapes = strip(L.shapes);
    return true;
  }
  function ellipseAt(el, t) {
    const [w, h] = valueAt(el.s, t), [cx, cy] = valueAt(el.p, t);
    const rx = w / 2, ry = h / 2, K = 0.5523;
    const shape = {
      c: true,
      v: [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]],
      i: [[-rx * K, 0], [0, -ry * K], [rx * K, 0], [0, ry * K]],
      o: [[rx * K, 0], [0, ry * K], [-rx * K, 0], [0, -ry * K]]
    };
    if (el.d !== 3) return shape;
    const r = (a) => [a[0]].concat(a.slice(1).reverse());
    return { c: true, v: r(shape.v), i: r(shape.o), o: r(shape.i) };
  }
  function shapeAt(ks, t) {
    if (!isAnimated(ks)) return Array.isArray(ks.k) ? ks.k[0] : ks.k;
    const k = ks.k;
    if (t <= k[0].t) return k[0].s[0];
    for (let j = 0; j < k.length - 1; j++) {
      const a = k[j], b = k[j + 1];
      if (t >= b.t) continue;
      if (a.h === 1 || !b.s) return a.s[0];
      const u = valueAt({ a: 1, k: [{ t: a.t, s: [0], i: a.i, o: a.o }, { t: b.t, s: [1] }] }, t)[0];
      const A = a.s[0], B = b.s[0];
      const mix = (p, q) => p.map((v, i) => [v[0] + (q[i][0] - v[0]) * u, v[1] + (q[i][1] - v[1]) * u]);
      return A.v.length === B.v.length ? { c: A.c, v: mix(A.v, B.v), i: mix(A.i, B.i), o: mix(A.o, B.o) } : A;
    }
    return k[k.length - 1].s[0];
  }
  var isLinear = (g) => api.hasAttribute(g, "generator.autoSetGradWidth");
  function forItems(items, ty, fn) {
    ;
    (items || []).forEach((it, i) => it.ty === ty ? fn(it, items, i) : it.ty === "gr" && forItems(it.it, ty, fn));
  }
  function linearEnds(g, bb) {
    const off = api.get(g, "generator.offset"), sc = api.get(g, "generator.scale"), rot = api.get(g, "generator.rotation") * Math.PI / 180;
    const dx = Math.cos(rot), dy = Math.sin(rot);
    const len = api.get(g, "generator.autoSetGradWidth") ? Math.abs(bb.width * dx) + Math.abs(bb.height * dy) : bb.width;
    const half = len / 2 * sc, cx = bb.centre.x + off.x, cy = bb.centre.y + off.y;
    return { s: [cx - dx * half, -(cy - dy * half)], e: [cx + dx * half, -(cy + dy * half)] };
  }
  function lottieStops(g) {
    const col = [], alpha = [];
    let p = 0;
    for (; api.hasAttribute(g, "generator.gradient." + p + ".position"); p++) {
      const t = api.get(g, "generator.gradient." + p + ".position"), c = api.get(g, "generator.gradient." + p + ".color");
      col.push(t, c.r / 255, c.g / 255, c.b / 255);
      alpha.push(t, c.a / 255);
    }
    return { p, k: { a: 0, k: col.concat(alpha) } };
  }
  function ellipseGradient(L, g) {
    const cos = Math.cos(g.rot * Math.PI / 180), sin = Math.sin(g.rot * Math.PI / 180);
    const vec = ([x, y]) => [(x * cos + y * sin) * 100 / g.rx, (-x * sin + y * cos) * 100 / g.ry];
    const pt = ([x, y]) => vec([x - g.c[0], y - g.c[1]]);
    const shape = (s) => ({ ...s, v: s.v.map(pt), i: s.i.map(vec), o: s.o.map(vec) });
    const toPath = (it) => {
      if (it.ty === "sh")
        return { ...it, ks: isAnimated(it.ks) ? { ...it.ks, k: it.ks.k.map((k) => ({ ...k, s: k.s && k.s.map(shape), e: k.e && k.e.map(shape) })) } : { ...it.ks, k: shape(it.ks.k) } };
      const [cx, cy] = it.p.k, [w, h] = it.s.k;
      const v = [[cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2], [cx - w / 2, cy - h / 2]];
      if (it.d === 3) v.reverse();
      return { ty: "sh", d: it.d, ks: { a: 0, k: shape({ c: true, v, i: v.map(() => [0, 0]), o: v.map(() => [0, 0]) }) } };
    };
    const fits = (it) => it.ty === "sh" || it.ty === "rc" && !isAnimated(it.p) && !isAnimated(it.s) && !isAnimated(it.r) && !(it.r && [].concat(it.r.k)[0]);
    let n = 0;
    const visit = (items) => {
      for (const gr of items || []) {
        if (gr.ty !== "gr") continue;
        const own = (gr.it || []).filter((it) => it.ty !== "tr");
        const gfs = own.filter((it) => it.ty === "gf");
        if (gfs.length !== 1 || gfs[0].t !== 2 || isAnimated(gfs[0].s) || isAnimated(gfs[0].e) || !own.every((it) => it === gfs[0] || fits(it))) {
          visit(gr.it);
          continue;
        }
        const tr = { ty: "tr", p: { a: 0, k: g.c }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [g.rx, g.ry] }, r: { a: 0, k: g.rot }, o: { a: 0, k: 100 } };
        const inner = { ty: "gr", it: own.filter((it) => it !== gfs[0]).map(toPath).concat([{ ...gfs[0], s: { a: 0, k: [0, 0] }, e: { a: 0, k: [100, 0] } }, tr]) };
        gr.it = [inner].concat(gr.it.filter((it) => it.ty === "tr"));
        n++;
      }
    };
    visit(L.shapes);
    return n > 0;
  }
  function lottieProps(L, attr) {
    const ks = L.ks || {};
    const sub = (ty, f) => {
      const out = [];
      const walk = (items) => (items || []).forEach((it) => it.ty === ty && it[f] ? out.push(it[f]) : it.ty === "gr" && walk(it.it));
      walk(L.shapes);
      return out;
    };
    switch (attr) {
      case "opacity":
        return ks.o ? [ks.o] : [];
      case "position.x":
        return ks.p && ks.p.s ? [ks.p.x] : ks.p ? [ks.p] : [];
      case "position.y":
        return ks.p && ks.p.s ? [ks.p.y] : ks.p ? [ks.p] : [];
      case "rotation.z":
        return ks.r ? [ks.r] : [];
      case "scale.x":
      case "scale.y":
        return ks.s ? [ks.s] : [];
      case "stroke.width":
        return sub("st", "w");
      case "stroke.alpha":
        return sub("st", "o");
      case "material.alpha":
        return sub("fl", "o");
      case "stroke.trimStart":
        return sub("tm", "s");
      case "stroke.trimEnd":
        return sub("tm", "e");
      case "stroke.trimTravel":
        return sub("tm", "o");
      case "generator.cornerRadius":
        return sub("rc", "r");
      case "inputPath":
        return sub("sh", "ks");
      default:
        return [];
    }
  }
  function sceneEases(L, id) {
    let n = 0;
    for (const attr of api.getAnimatedAttributes(id) || []) {
      const ids = api.getKeyframeIdsForAttribute(id, attr);
      for (const p of lottieProps(L, attr).filter(isAnimated)) {
        if (p.k.length !== ids.length || p.k.some((kf, j) => kf.t !== api.get(ids[j], "frame") || kf.s && kf.s.length !== 1)) continue;
        p.k.forEach((kf, j) => {
          if (j === p.k.length - 1 || kf.h === 1) return;
          const e = easeBetween(ids[j], ids[j + 1]);
          if (e.h) return;
          kf.o = e.o;
          kf.i = e.i;
          n++;
        });
      }
    }
    return n;
  }
  function sceneHolds(L, id) {
    let n = 0;
    for (const attr of api.getAnimatedAttributes(id) || []) {
      const props = lottieProps(L, attr).filter(isAnimated);
      if (!props.length) continue;
      const holds = new Set(
        api.getKeyframeIdsForAttribute(id, attr).filter((k) => (api.get(k, "data") || {}).interpolation === 2).map((k) => api.get(k, "frame"))
      );
      if (!holds.size) continue;
      for (const p of props)
        p.k.forEach((kf, j) => {
          if (j === p.k.length - 1 || kf.h === 1 || !holds.has(Math.round(kf.t))) return;
          kf.h = 1;
          delete kf.i;
          delete kf.o;
          n++;
        });
    }
    return n;
  }
  function sourceOf(id, attr) {
    const conn = api.getInConnectedAttributes(id) || [];
    if (conn.indexOf(attr) < 0) return (api.getAnimatedAttributes(id) || []).indexOf(attr) >= 0 ? [id, attr] : null;
    const src = String(api.getInConnection(id, attr) || "");
    const dot = src.indexOf(".");
    if (dot < 0) return null;
    const sid = src.slice(0, dot), sattr = src.slice(dot + 1);
    return (api.getAnimatedAttributes(sid) || []).indexOf(sattr) >= 0 ? [sid, sattr] : null;
  }
  function matchesBake(fresh, baked, from, to, tol, offset) {
    if (!isAnimated(baked) || baked.k.length < 4) return false;
    let d0 = null;
    for (let t = from; t <= to; t++) {
      const a = valueAt(fresh, t), b = valueAt(baked, t);
      if (!a || !b) return false;
      for (let i = 0; i < Math.min(a.length, b.length, 2); i++) {
        let d = a[i] - b[i];
        if (offset) {
          if (d0 === null) d0 = [];
          if (d0[i] === void 0) d0[i] = d;
          d -= d0[i];
        }
        if (Math.abs(d) > tol) return false;
      }
    }
    return true;
  }
  function sceneTransformKeys(L, id) {
    if (!L.ks) return 0;
    const ks = L.ks;
    const range = (p) => [p.k[0].t, p.k[p.k.length - 1].t];
    let n = 0;
    const r = sourceOf(id, "rotation.z");
    if (r && isAnimated(ks.r)) {
      const fresh = sceneKeys(r[0], r[1], (v) => -v);
      const [a, b] = range(ks.r);
      if (matchesBake(fresh, ks.r, a, b, 0.05)) ks.r = fresh, n++;
    }
    const sx = sourceOf(id, "scale.x"), sy = sourceOf(id, "scale.y");
    if ((sx || sy) && isAnimated(ks.s)) {
      const X = sx ? sceneKeys(sx[0], sx[1], (v) => v * 100) : { a: 0, k: api.get(id, "scale").x * 100 };
      const Y = sy ? sceneKeys(sy[0], sy[1], (v) => v * 100) : { a: 0, k: api.get(id, "scale").y * 100 };
      const fresh = combine2(X, Y);
      const [a, b] = range(ks.s);
      if (fresh && matchesBake(fresh, ks.s, a, b, 0.05)) ks.s = fresh, n++;
    }
    if (ks.p && ks.p.s) {
      for (const [axis, sign] of [["x", 1], ["y", -1]]) {
        const src = sourceOf(id, "position." + axis);
        if (!src || !isAnimated(ks.p[axis])) continue;
        const fresh = sceneKeys(src[0], src[1], (v) => sign * v);
        const [a, b] = range(ks.p[axis]);
        if (!matchesBake(fresh, ks.p[axis], a, b, 0.05, true)) continue;
        const off = valueAt(ks.p[axis], a)[0] - valueAt(fresh, a)[0];
        ks.p[axis] = isAnimated(fresh) ? Object.assign({}, fresh, { k: fresh.k.map((kf) => Object.assign({}, kf, { s: [kf.s[0] + off] })) }) : { a: 0, k: fresh.k + off };
        n++;
      }
    }
    return n;
  }
  function sceneSpeedKeys(L, id, comp) {
    const ks = L.ks;
    if (!ks) return 0;
    let n = 0;
    const props = ks.p && ks.p.s ? [["position.x", "x", 1, true], ["position.y", "y", -1, true]] : [];
    for (const [attr, key, sign, offset] of props.concat([["rotation.z", "r", -1, false]])) {
      const owner = key === "r" ? ks : ks.p;
      const prop = owner[key];
      if (!isAnimated(prop)) continue;
      const ids = api.getKeyframeIdsForAttribute(id, attr) || [];
      const speedy = (k) => {
        const d = api.get(k, "data") || {};
        return d.leftSpeed != null || d.rightSpeed != null;
      };
      if (!ids.some(speedy)) continue;
      const from = Math.round(prop.k[0].t), to = Math.round(prop.k[prop.k.length - 1].t);
      const vals = sampleAttr(comp, id, attr, from, to);
      const off = offset ? valueAt(prop, from)[0] - sign * vals[0] : 0;
      if (vals.every((v, j) => Math.abs(valueAt(prop, from + j)[0] - (sign * v + off)) <= 0.05)) continue;
      owner[key] = frameKeys(vals, from, (v) => [sign * v + off]);
      n++;
    }
    return n;
  }
  function combine2(X, Y) {
    const ax = isAnimated(X), ay = isAnimated(Y);
    if (!ax && !ay) return { a: 0, k: [asNum(X), asNum(Y), 100] };
    const times = (ax ? X : Y).k.map((k) => k.t);
    if (ax && ay && (X.k.length !== Y.k.length || X.k.some((k, j) => k.t !== Y.k[j].t))) return null;
    const at2 = (P, j) => isAnimated(P) ? P.k[j] : { s: [asNum(P)] };
    return {
      a: 1,
      k: times.map((t, j) => {
        const x = at2(X, j), y = at2(Y, j);
        const kf = { t, s: [x.s[0], y.s[0], 100] };
        if (j < times.length - 1) {
          if (x.h === 1 || y.h === 1) kf.h = 1;
          else {
            const e = (q, f, d) => q[f] ? q[f][d][0] : f === "o" ? 0 : 1;
            kf.o = { x: [e(x, "o", "x"), e(y, "o", "x"), 0], y: [e(x, "o", "y"), e(y, "o", "y"), 0] };
            kf.i = { x: [e(x, "i", "x"), e(y, "i", "x"), 1], y: [e(x, "i", "y"), e(y, "i", "y"), 1] };
          }
        }
        return kf;
      })
    };
  }
  var asNum = (P) => Array.isArray(P.k) ? P.k[0] : P.k;
  function sceneOpacity(L, id, range) {
    if (!L.ks) return false;
    const animated = (api.getAnimatedAttributes(id) || []).indexOf("opacity") >= 0;
    if (animated) {
      L.ks.o = sceneKeys(id, "opacity", (v2) => v2);
      return true;
    }
    if (drivenAttr(id, "opacity")) {
      if (!range) return false;
      const o = frameKeys(sampleAttr(range[0], id, "opacity", range[1], range[2]), range[1], (v2) => [v2]);
      L.ks.o = o.a ? o : { a: 0, k: o.k[0] };
      return true;
    }
    let v;
    try {
      v = api.get(id, "opacity");
    } catch (e) {
      return false;
    }
    if (typeof v !== "number") return false;
    const cur = (valueAt(L.ks.o, 0) || [100])[0];
    if (isAnimated(L.ks.o) || Math.abs(cur - v) < 1e-6) return false;
    L.ks.o = { a: 0, k: v };
    return true;
  }
  function timeRemap(ref, comp, fps) {
    if ((api.getAnimatedAttributes(ref) || []).indexOf("timeRemapping") < 0) {
      const v = api.get(ref, "timeRemapping");
      return v ? { a: 0, k: toSeconds(v) } : null;
    }
    const ids = api.getKeyframeIdsForAttribute(ref, "timeRemapping");
    const keys = ids.map((id, j) => {
      const kf = { t: api.get(id, "frame"), s: [toSeconds(api.get(id, "data").numValue)] };
      if (j < ids.length - 1) Object.assign(kf, easeBetween(id, ids[j + 1]));
      return kf;
    });
    return keys.length === 1 ? { a: 0, k: keys[0].s[0] } : { a: 1, k: keys };
    function toSeconds(pct) {
      const start = api.get(comp, "startFrame"), end = api.get(comp, "endFrame");
      return (start + pct / 100 * (end - start)) / fps;
    }
  }
  function valueAt(prop, t) {
    if (!prop) return null;
    if (!isAnimated(prop)) return Array.isArray(prop.k) ? prop.k : [prop.k];
    const k = prop.k;
    if (t <= k[0].t) return k[0].s;
    for (let j = 0; j < k.length - 1; j++) {
      const a = k[j], b = k[j + 1];
      if (t >= b.t) continue;
      if (a.h === 1 || !b.s) return a.s;
      const u = (t - a.t) / (b.t - a.t);
      return a.s.map((v, d) => {
        const c = (q, f) => q == null ? f : Array.isArray(q) ? q[d] != null ? q[d] : q[0] : q;
        const ox = c(a.o && a.o.x, 0), oy = c(a.o && a.o.y, 0), ix = c(a.i && a.i.x, 1), iy = c(a.i && a.i.y, 1);
        return v + (b.s[d] - v) * ease(ox, oy, ix, iy, u);
      });
    }
    return k[k.length - 1].s;
  }
  function ease(ox, oy, ix, iy, x) {
    const bz = (p1, p2, t2) => 3 * (1 - t2) * (1 - t2) * t2 * p1 + 3 * (1 - t2) * t2 * t2 * p2 + t2 * t2 * t2;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 30; i++) {
      t = (lo + hi) / 2;
      if (bz(ox, ix, t) < x) lo = t;
      else hi = t;
    }
    return bz(oy, iy, t);
  }
  function layerMatrix(ks, t) {
    const p = ks.p && ks.p.s ? [valueAt(ks.p.x, t)[0], valueAt(ks.p.y, t)[0]] : valueAt(ks.p, t) || [0, 0];
    const a = valueAt(ks.a, t) || [0, 0], s = valueAt(ks.s, t) || [100, 100], r = ((valueAt(ks.r, t) || [0])[0] || 0) * Math.PI / 180, k = Math.tan(((valueAt(ks.sk, t) || [0])[0] || 0) * Math.PI / 180);
    const c = Math.cos(r), sn = Math.sin(r), sx = s[0] / 100, sy = s[1] / 100;
    const m = [c * sx, (-c * k - sn) * sy, sn * sx, (c - sn * k) * sy];
    return [m[0], m[1], m[2], m[3], p[0] - (m[0] * a[0] + m[1] * a[1]), p[1] - (m[2] * a[0] + m[3] * a[1])];
  }
  function padMatteBounds(L) {
    let b = null, sw = 0;
    const grow = (M, x, y) => {
      const q = [M[0] * x + M[1] * y + M[4], M[2] * x + M[3] * y + M[5]];
      b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])] : [q[0], q[1], q[0], q[1]];
    };
    const values = (p) => !p ? [] : isAnimated(p) ? p.k.map((k) => k.s).filter((v) => v !== void 0) : [p.k];
    const walk = (items, M, t) => {
      const tr = items.find((x) => x.ty === "tr");
      if (tr) M = mul(M, layerMatrix(tr, t));
      for (const it of items) {
        if (it.ty === "gr") walk(it.it || [], M, t);
        else if (it.ty === "sh") {
          for (const v of values(it.ks))
            for (const sh of Array.isArray(v) ? v : [v]) if (sh && sh.v) sh.v.forEach((q, i) => (grow(M, q[0], q[1]), grow(M, q[0] + sh.i[i][0], q[1] + sh.i[i][1]), grow(M, q[0] + sh.o[i][0], q[1] + sh.o[i][1])));
        } else if (it.ty === "rc" || it.ty === "el") for (const c of values(it.p)) for (const s of values(it.s)) grow(M, c[0] - s[0] / 2, c[1] - s[1] / 2), grow(M, c[0] + s[0] / 2, c[1] + s[1] / 2);
        else if (it.ty === "st" || it.ty === "gs") sw = Math.max(sw, ...values(it.w).map((w) => (Array.isArray(w) ? w[0] : w) * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]))));
      }
    };
    const keyTimes = /* @__PURE__ */ new Set([0]);
    const collect = (items) => {
      for (const it of items || []) {
        if (it.ty === "gr") collect(it.it);
        if (it.ty !== "tr") continue;
        for (const f of ["p", "a", "s", "r", "sk"]) if (isAnimated(it[f])) it[f].k.forEach((kf, j, k) => (keyTimes.add(kf.t), k[j + 1] && keyTimes.add((kf.t + k[j + 1].t) / 2)));
      }
    };
    collect(L.shapes);
    let all = null, thin = false;
    for (const t of keyTimes) {
      b = null;
      walk(L.shapes || [], [1, 0, 0, 1, 0, 0], t);
      if (!b) continue;
      thin = thin || Math.min(b[2] - b[0], b[3] - b[1]) < 5 * sw;
      all = all ? [Math.min(all[0], b[0]), Math.min(all[1], b[1]), Math.max(all[2], b[2]), Math.max(all[3], b[3])] : b;
    }
    b = all;
    if (!b || !sw || !thin) return false;
    const still = (k) => ({ a: 0, k });
    L.shapes.push({
      ty: "gr",
      nm: "Matte bounds",
      it: [
        { ty: "rc", d: 1, p: still([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]), s: still([b[2] - b[0] + 2 * sw, b[3] - b[1] + 2 * sw]), r: still(0) },
        { ty: "fl", c: still([0, 0, 0, 1]), o: still(0), r: 1 },
        { ty: "tr", p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100) }
      ]
    });
    return true;
  }
  var mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[0] * B[4] + A[1] * B[5] + A[4], A[2] * B[4] + A[3] * B[5] + A[5]];
  function invertApply(M, [x, y]) {
    const det = M[0] * M[3] - M[1] * M[2];
    if (Math.abs(det) < 1e-9) return null;
    const dx = x - M[4], dy = y - M[5];
    return [(M[3] * dx - M[1] * dy) / det, (-M[2] * dx + M[0] * dy) / det];
  }
  var positionAt = (ks, t) => ks.p && ks.p.s ? [valueAt(ks.p.x, t)[0], valueAt(ks.p.y, t)[0]] : valueAt(ks.p, t) || [0, 0];
  function repairPositions(layers, frames, anchorFor, pivotAt) {
    const byInd = new Map(layers.map((L) => [L.ind, L]));
    const done = /* @__PURE__ */ new Set();
    const varying = [];
    let fixed = 0;
    const parentMatrix = (L, t) => {
      let M = [1, 0, 0, 1, 0, 0];
      for (let q = byInd.get(L.parent); q; q = byInd.get(q.parent)) M = mul(layerMatrix(q.ks, t), M);
      return M;
    };
    const visit = (L) => {
      if (done.has(L)) return;
      done.add(L);
      const up = byInd.get(L.parent);
      if (up) visit(up);
      if (!L.ks) return;
      const a = anchorFor(L);
      if (a && !isAnimated(L.ks.a)) {
        const old = valueAt(L.ks.a, 0) || [0, 0, 0];
        L.ks.a = Object.assign({}, L.ks.a || { a: 0 }, { k: [a[0], a[1], old[2] || 0] });
      }
      const world = pivotAt(L);
      if (!world) return;
      const deltas = frames.filter((t) => world[t]).map((t) => {
        const local = invertApply(parentMatrix(L, t), world[t]);
        const p = positionAt(L.ks, t);
        return local && [local[0] - p[0], local[1] - p[1]];
      }).filter(Boolean);
      if (!deltas.length) return;
      if (deltas.some((d) => Math.hypot(d[0] - deltas[0][0], d[1] - deltas[0][1]) > 0.25)) return varying.push(L);
      if (Math.hypot(deltas[0][0], deltas[0][1]) < 0.01) return;
      L.ks.p = shiftPosition(L.ks.p, deltas[0][0], deltas[0][1]);
      fixed++;
    };
    layers.forEach(visit);
    return { fixed, varying, parentMatrix };
  }
  function bakePosition(L, world, parentMatrix) {
    const xs = [], ys = [];
    Object.keys(world).map(Number).sort((a, b) => a - b).forEach((t) => {
      const local = invertApply(parentMatrix(L, t), world[t]);
      if (!local) return;
      const lin = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } };
      xs.push(Object.assign({ t, s: [local[0]] }, lin));
      ys.push(Object.assign({ t, s: [local[1]] }, lin));
    });
    L.ks.p = { s: true, x: { a: 1, k: xs }, y: { a: 1, k: ys } };
  }
  var maskMode = (mode, i) => mode === 1 ? "s" : i === 0 || mode === 0 ? "a" : "i";
  function localShape(contour, M) {
    const v = [], ii = [], oo = [];
    for (const p of contour.points) {
      const q = invertApply(M, p.position);
      if (!q) return null;
      const a = invertApply(M, p.inHandle), b = invertApply(M, p.outHandle);
      v.push(q);
      ii.push([a[0] - q[0], a[1] - q[1]]);
      oo.push([b[0] - q[0], b[1] - q[1]]);
    }
    return { i: ii, o: oo, v, c: !!contour.isClosed };
  }
  var sameShape = (a, b) => a.v.length === b.v.length && ["v", "i", "o"].every((f) => a[f].every((p, k) => Math.abs(p[0] - b[f][k][0]) < 0.01 && Math.abs(p[1] - b[f][k][1]) < 0.01));
  function applyMasks(masks, targets, parentMatrix) {
    let n = 0;
    for (const L of targets) {
      const M = (t) => mul(parentMatrix(L, t), layerMatrix(L.ks, t));
      const out = L.masksProperties ? L.masksProperties.slice() : [];
      masks.forEach((m) => {
        const frames = Object.keys(m.paths).map(Number).sort((a, b) => a - b);
        const contours = m.paths[frames[0]].length;
        for (let c = 0; c < contours; c++) {
          const keys = [];
          for (const t of frames) {
            const sh = m.paths[t][c] && localShape(m.paths[t][c], M(t));
            if (sh) keys.push({ t, s: [sh] });
          }
          if (!keys.length) continue;
          const still = keys.every((k) => sameShape(k.s[0], keys[0].s[0]));
          const pt = still ? { a: 0, k: keys[0].s[0] } : { a: 1, k: keys.map((k, j) => j < keys.length - 1 ? Object.assign(k, { o: { x: 0, y: 0 }, i: { x: 1, y: 1 } }) : k) };
          out.push({ inv: false, mode: maskMode(m.mode, out.length), pt, o: { a: 0, k: 100 }, x: { a: 0, k: 0 }, nm: "Mask" });
          n++;
        }
      });
      if (out.length) {
        L.masksProperties = out;
        L.hasMask = true;
      }
    }
    return n;
  }
  function samplePivots(comp, ids, frames, maskIds) {
    const [w, h] = compSize(comp);
    const toLottie = (p) => [p.x + w / 2, h / 2 - p.y];
    api.setActiveComp(comp);
    if (api.getActiveComp() !== comp) throw new Error("Could not open " + api.getNiceName(comp) + " to check its layers");
    const out = {};
    for (const f of frames) {
      api.setFrame(f);
      for (const id of ids) {
        try {
          ;
          (out[id] = out[id] || {})[f] = toLottie(api.getPivotPosition(id, true));
        } catch (e) {
        }
      }
      for (const id of maskIds || []) {
        try {
          const contours = api.getEditablePath(id, true).map((c) => ({
            isClosed: c.isClosed,
            // points without handles carry no inHandle/outHandle
            points: c.points.map((p) => ({ position: toLottie(p.position), inHandle: toLottie(p.inHandle || p.position), outHandle: toLottie(p.outHandle || p.position) }))
          }));
          (out[id] = out[id] || {})[f] = contours;
        } catch (e) {
        }
      }
    }
    return out;
  }
  function sampleAttr(comp, id, attr, from, to) {
    api.setActiveComp(comp);
    const out = [];
    for (let f = from; f <= to; f++) {
      api.setFrame(f);
      out.push(api.get(id, attr));
    }
    return out;
  }
  function frameKeys(vals, from, map) {
    const k = vals.map((v, j) => {
      const kf = { t: from + j, s: map(v) };
      if (j < vals.length - 1) Object.assign(kf, { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } });
      return kf;
    });
    return k.every((kf) => JSON.stringify(kf.s) === JSON.stringify(k[0].s)) ? { a: 0, k: k[0].s } : { a: 1, k };
  }
  var drivenAttr = (id, attr) => (api.getInConnectedAttributes(id) || []).some((a) => a === attr || a.indexOf(attr + ".") === 0);
  function sceneMasks(id) {
    return api.getInConnectedAttributes(id).filter((a) => /^masks\.\d+\.id$/.test(a)).map((a) => {
      const i = a.split(".")[1];
      let on = true;
      try {
        on = api.get(id, "masks." + i + ".enabled") !== false;
      } catch (e) {
      }
      return on && { id: String(api.getInConnection(id, a)).replace(/\.id$/, ""), mode: api.get(id, "masks." + i + ".mode") };
    }).filter(Boolean);
  }
  var MATTE_TT = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 1, 5: 2 };
  function matteConns(id) {
    if (!api.hasAttribute(id, "matteMode")) return [];
    let mode = 0;
    try {
      mode = api.get(id, "matteMode");
    } catch (e) {
    }
    return api.getInConnectedAttributes(id).filter((a) => /^trackMattes\.\d+\.id$/.test(a)).map((a) => {
      let on = true;
      try {
        on = api.get(id, "trackMattes." + a.split(".")[1] + ".enabled") !== false;
      } catch (e) {
      }
      return on && { id: String(api.getInConnection(id, a)).replace(/\.id$/, ""), mode };
    }).filter(Boolean);
  }
  function planMattes(comp, warn) {
    const jobs = [], unhide = /* @__PURE__ */ new Set();
    for (const id of compLayers(comp)) {
      const ms = matteConns(id);
      if (!ms.length) continue;
      if (api.getLayerType(id) === "group") {
        if (warn) warn("The track matte on group " + api.getNiceName(id) + " does nothing in Cavalry, so it isn\u2019t exported");
        continue;
      }
      jobs.push({ target: id, sources: ms.map((m) => m.id), tt: MATTE_TT[ms[0].mode] || 1 });
      for (const m of ms)
        for (let q = m.id, g = 0; q && q !== comp && g < 64; q = api.getParent(q), g++) {
          try {
            if (api.get(q, "hidden")) unhide.add(q);
          } catch (e) {
          }
        }
    }
    return { jobs, unhide: [...unhide] };
  }
  function sourceShapes(id) {
    const out = api.getLayerType(id) === "group" ? [] : [id];
    for (const k of api.getChildren(id)) {
      let hidden = false;
      try {
        hidden = !!api.get(k, "hidden");
      } catch (e) {
      }
      if (!hidden) out.push(...sourceShapes(k));
    }
    return out;
  }
  var BLUR_SCALE = { "sceneGroup::gaussianBlurFilter": 1, blurFilter: 1 / 0.3 };
  function sceneFilters(id) {
    return (api.getInConnectedAttributes(id) || []).filter((a) => /^filters\.\d+$/.test(a)).map((a) => String(api.getInConnection(id, a)).replace(/\.id$/, "")).map((f) => ({ f, kind: api.getLayerType(f) === "fill" ? "fill" : BLUR_SCALE[api.getLayerType(f)] ? "blur" : null })).filter((x) => x.kind);
  }
  function fillProps(channels, from, to) {
    const at2 = (t) => channels.map((P) => (valueAt(P, t) || [0])[0]);
    const anim = channels.filter(isAnimated);
    if (!anim.length) {
      const v = at2(0);
      return { color: { a: 0, k: [v[0], v[1], v[2], 1] }, opacity: { a: 0, k: v[3] } };
    }
    const ease2 = (kf) => JSON.stringify([kf.h, kf.o, kf.i]);
    const ref = anim[0].k;
    const shared = anim.every((P) => P.k.length === ref.length && P.k.every((kf, j) => kf.t === ref[j].t && ease2(kf) === ease2(ref[j])));
    const frames = shared ? ref : [];
    if (!shared) for (let t = from; t <= to; t++) frames.push({ t, o: { x: [0], y: [0] }, i: { x: [1], y: [1] } });
    const keys = (pick) => frames.map((f, j) => {
      const kf = { t: f.t, s: pick(at2(f.t)) };
      if (j < frames.length - 1) {
        for (const k of ["h", "o", "i"]) if (f[k] !== void 0) kf[k] = f[k];
      }
      return kf;
    });
    const prop = (pick, i) => channels.slice(...i).some(isAnimated) ? { a: 1, k: keys(pick) } : { a: 0, k: pick(at2(0)) };
    const opacity = prop((v) => [v[3]], [3, 4]);
    if (!opacity.a) opacity.k = opacity.k[0];
    return { color: prop((v) => [v[0], v[1], v[2], 1], [0, 3]), opacity };
  }
  function drawingUnder(layers, L) {
    const drawing = (q) => q.ty !== 4 ? q.ty !== 3 : /"ty":"(sh|rc|el|sr)"/.test(JSON.stringify(q.shapes || []));
    const under = (q) => [q].concat(...layers.filter((c) => c.parent === q.ind).map(under));
    return under(L).filter(drawing);
  }
  function fillEffect(color, opacity) {
    const p = (ty, nm, n, v) => ({ ty, nm, mn: "ADBE Fill-000" + n, ix: 0, v });
    const ef = [
      p(10, "Fill Mask", 1, { a: 0, k: 0 }),
      p(7, "All Masks", 7, { a: 0, k: 0 }),
      p(2, "Color", 2, color),
      p(7, "Invert", 6, { a: 0, k: 0 }),
      p(0, "Horizontal Feather", 3, { a: 0, k: 0 }),
      p(0, "Vertical Feather", 4, { a: 0, k: 0 }),
      p(0, "Opacity", 5, opacity)
    ];
    ef.forEach((e, i) => e.ix = i + 1);
    return { ty: 21, nm: "Fill", np: 9, mn: "ADBE Fill", ix: 1, en: 1, ef };
  }
  function blurEffect(blurriness, dims) {
    const p = (ty, nm, n, v) => ({ ty, nm, mn: "ADBE Gaussian Blur 2-000" + n, ix: n, v });
    const ef = [p(0, "Blurriness", 1, blurriness), p(7, "Blur Dimensions", 2, { a: 0, k: dims }), p(7, "Repeat Edge Pixels", 3, { a: 0, k: 0 })];
    return { ty: 29, nm: "Gaussian Blur", np: 5, mn: "ADBE Gaussian Blur 2", ix: 1, en: 1, ef };
  }
  function staticSingleKeys(node) {
    let n = 0;
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (!o || typeof o !== "object") return;
      if (o.a === 1 && Array.isArray(o.k) && o.k.length === 1 && o.k[0] && o.k[0].s !== void 0) {
        const v = o.k[0].s;
        o.a = 0;
        o.k = Array.isArray(v) && v.length === 1 ? v[0] : v;
        n++;
        return;
      }
      for (const k in o) walk(o[k]);
    };
    walk(node);
    return n;
  }
  function inheritOpacity(layers, from, to) {
    const byInd = new Map(layers.map((L) => [L.ind, L]));
    const opacity = (L) => L.ks && L.ks.o || { a: 0, k: 100 };
    const hasHold = (p) => isAnimated(p) && p.k.some((k) => k.h === 1);
    let n = 0;
    for (const L of layers) {
      const chain = [];
      for (let q = byInd.get(L.parent); q; q = byInd.get(q.parent)) {
        const o = opacity(q);
        if (isAnimated(o) || (valueAt(o, 0) || [100])[0] !== 100) chain.push(o);
      }
      if (!chain.length) continue;
      const own = opacity(L);
      const all = [own].concat(chain);
      const at2 = (t) => all.reduce((v, o) => v * (valueAt(o, t) || [100])[0] / 100, 100);
      if (!all.some(isAnimated)) L.ks.o = { a: 0, k: at2(0) };
      else {
        const step = all.some(hasHold);
        const keys = [];
        for (let t = from; t <= to; t++) {
          const kf = { t, s: [at2(t)] };
          if (t < to) Object.assign(kf, step ? { h: 1 } : { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } });
          keys.push(kf);
        }
        L.ks.o = { a: 1, k: keys };
      }
      n++;
    }
    return n;
  }
  function isGuide(id) {
    for (let q = id; q; q = api.getParent(q)) {
      try {
        if (api.hasAttribute(q, "guideLayer") && api.get(q, "guideLayer")) return true;
      } catch (e) {
      }
    }
    return false;
  }
  function dropGuides(layers, sceneOf) {
    const gone = new Set(layers.filter((L) => sceneOf.get(L) && isGuide(sceneOf.get(L))).map((L) => L.ind));
    let grew = true;
    while (grew) {
      grew = false;
      for (const L of layers) if (!gone.has(L.ind) && gone.has(L.parent)) gone.add(L.ind), grew = true;
    }
    return layers.filter((L) => !gone.has(L.ind));
  }
  function exportWithPrecomps(compId, opts = {}) {
    const warnings = [];
    const assets = [];
    const dirs = [];
    const cache = {};
    let pivots = 0, baked = 0, maskCount = 0, trackMattes = 0, fills = 0, outlined = 0, refs = 0, next = 0;
    const userComp = api.getActiveComp(), userFrame = api.getFrame();
    function build(comp, ref) {
      const plan = planMattes(comp, (w) => warnings.push(w));
      const shown = [];
      let out;
      try {
        for (const q of plan.unhide) {
          api.set(q, { hidden: false });
          shown.push(q);
        }
        out = exportComp(comp, Object.assign({}, opts, { ref }));
      } finally {
        for (const q of shown) api.set(q, { hidden: true });
      }
      dirs.push(out.dir);
      const exported = out.json;
      const tag = next++;
      for (const a of exported.assets || []) {
        if (!isImageAsset(a)) continue;
        const id = a.id + "_" + tag;
        for (const L of exported.layers) if (L.ty === 2 && L.refId === a.id) L.refId = id;
        a.id = id;
        a.u = out.dir + "/" + (a.u || "");
      }
      const ids = new Set(compLayers(comp));
      const fps = exported.fr;
      const sceneOf = /* @__PURE__ */ new Map();
      exported.layers = exported.layers.map((L) => {
        const id = sceneId2(L.mn, ids);
        if (!id) return L;
        sceneOf.set(L, id);
        if (api.getLayerType(id) !== "compositionReference") return L;
        const inner = compOf2(id);
        if (!inner) return L;
        refs++;
        const key = inner + shaderArrayPicks(inner, id).map((p) => "|" + p.shader).join("");
        if (!cache[key]) {
          const assetId = "comp_" + next++;
          cache[key] = assetId;
          const built = build(inner, id);
          assets.push({ id: assetId, nm: api.getNiceName(inner), fr: built.fr, layers: built.layers });
          for (const a of built.assets || []) if (!assets.some((b) => b.id === a.id)) assets.push(a);
        }
        const [w, h] = compSize(inner);
        const out2 = {};
        for (const k in L) if (k !== "shapes" && k !== "ty") out2[k] = L[k];
        out2.ty = 0;
        out2.refId = cache[key];
        out2.w = w;
        out2.h = h;
        out2.ks = Object.assign({}, L.ks, { a: shift(L.ks && L.ks.a, w / 2, h / 2) });
        if (L.masksProperties) out2.masksProperties = shiftMasks(L.masksProperties, w / 2, h / 2);
        out2.st = api.get(id, "timeOffset") || 0;
        out2.sr = 1;
        const tm = timeRemap(id, inner, fps);
        if (tm) out2.tm = tm;
        sceneOf.set(out2, id);
        return out2;
      });
      if (opts.duplicators !== false) {
        const builtRefs = duplicatorCompRefs(comp, exported, sceneOf, (inner, ref2) => {
          const key = inner + shaderArrayPicks(inner, ref2).map((p) => "|" + p.shader).join("");
          if (!cache[key]) {
            const assetId = "comp_" + next++;
            cache[key] = assetId;
            const built = build(inner, ref2);
            assets.push({ id: assetId, nm: api.getNiceName(inner), fr: built.fr, w: built.w, h: built.h, layers: built.layers });
            for (const a of built.assets || []) if (!assets.some((b) => b.id === a.id)) assets.push(a);
          }
          return { id: cache[key], fr: exported.fr, w: compSize(inner)[0], h: compSize(inner)[1], layers: null };
        });
        if (builtRefs.refs) refs += builtRefs.refs;
        for (const w of builtRefs.warnings) warnings.push(w);
      }
      const last = api.get(comp, "endFrame");
      for (const L of exported.layers) if (L.op === last) L.op = last + 1;
      for (const L of exported.layers) {
        const id = sceneOf.get(L);
        if (!id) continue;
        let from = -Infinity, to = Infinity;
        for (let p = api.getParent(id), guard = 0; p && ids.has(p) && guard < 64; p = api.getParent(p), guard++) {
          const i = api.getInFrame(p), o = api.getOutFrame(p);
          if (i >= 0) from = Math.max(from, i);
          if (o >= 0) to = Math.min(to, o + 1);
        }
        if (from > L.ip) L.ip = from;
        if (to < L.op) L.op = Math.max(to, L.ip);
      }
      exported.layers = dropGuides(exported.layers, sceneOf);
      staticSingleKeys(exported.layers);
      for (const L of exported.layers) {
        const id = sceneOf.get(L);
        if (!id) continue;
        sceneTransformKeys(L, id);
        sceneSpeedKeys(L, id, comp);
        sceneRotationScale(L, id);
        sceneSkew(L, id, [comp, api.get(comp, "startFrame"), last]);
        if (L.ty !== 0) sceneOpacity(L, id, [comp, api.get(comp, "startFrame"), last]);
        sceneEases(L, id);
        sceneHolds(L, id);
      }
      inheritOpacity(exported.layers, api.get(comp, "startFrame"), last);
      repair(comp, exported, sceneOf);
      addFills(comp, exported, sceneOf);
      for (const L of exported.layers) if (sceneOf.get(L)) sceneGradients(L, sceneOf.get(L), comp, ref);
      for (const L of exported.layers) if (sceneOf.get(L) && sceneOutlinedStroke(L, sceneOf.get(L), comp, opts.outlineGradientStrokes !== false)) outlined++;
      for (const L of exported.layers) if (sceneOf.get(L)) sceneFillRule(L, sceneOf.get(L));
      buildTrackMattes(comp, exported, sceneOf, plan);
      return exported;
    }
    function buildTrackMattes(comp, exported, sceneOf, plan) {
      if (!plan.jobs.length) return;
      const layers = exported.layers;
      const [w, h] = compSize(comp);
      const byInd = new Map(layers.map((L) => [L.ind, L]));
      const within = (id, src) => {
        for (let q = id, g = 0; q && g < 64; q = api.getParent(q), g++) if (q === src) return true;
        return false;
      };
      let ind = Math.max(0, ...layers.map((L) => L.ind || 0)) + 1;
      const used = /* @__PURE__ */ new Set(), assetFor = /* @__PURE__ */ new Map();
      const jobs = [], rest = plan.jobs.slice();
      while (rest.length) {
        const i = rest.findIndex((J) => !rest.some((K) => K !== J && J.sources.some((src) => within(K.target, src))));
        jobs.push(rest.splice(Math.max(i, 0), 1)[0]);
      }
      for (const job of jobs) {
        const key = job.sources.slice().sort().join("+");
        if (!assetFor.has(key)) {
          const inSrc = (L) => !!L && !!sceneOf.get(L) && job.sources.some((src) => within(sceneOf.get(L), src));
          const own = layers.filter((L, i) => inSrc(L) || L.td && layers[i + 1] && layers[i + 1].tt && inSrc(layers[i + 1]));
          if (!own.length) {
            warnings.push("A track matte on " + api.getNiceName(job.target) + " in " + api.getNiceName(comp) + " had nothing to export; it shows unmatted");
            assetFor.set(key, null);
            continue;
          }
          own.forEach((L) => used.add(L));
          const copy = own.map((L) => JSON.parse(JSON.stringify(L)));
          const have = new Set(copy.map((L) => L.ind));
          for (let i = 0; i < copy.length; i++) {
            const P = copy[i].parent != null && !have.has(copy[i].parent) && byInd.get(copy[i].parent);
            if (!P) continue;
            copy.push({ ty: 3, ind: P.ind, parent: P.parent, ip: P.ip, op: P.op, st: P.st || 0, sr: 1, ks: JSON.parse(JSON.stringify(P.ks || {})) });
            have.add(P.ind);
          }
          const id = "matte_" + next++;
          assets.push({ id, nm: "Matte", fr: exported.fr, layers: copy });
          assetFor.set(key, id);
        }
        const refId = assetFor.get(key);
        if (!refId) continue;
        for (const T of layers.filter((L) => sceneOf.get(L) === job.target))
          for (const D of drawingUnder(layers, T)) {
            if (D.tt || used.has(D)) continue;
            layers.splice(layers.indexOf(D), 0, { ty: 0, ind: ind++, nm: "Matte", refId, td: 1, ip: D.ip, op: D.op, st: 0, sr: 1, w, h, ks: {} });
            D.tt = job.tt;
            padMatteBounds(D);
            trackMattes++;
          }
      }
      const hiddenSrc = (L) => plan.unhide.some((q) => within(sceneOf.get(L), q));
      const kept = layers.filter((L) => !used.has(L) || !hiddenSrc(L) || layers.some((q) => q.parent === L.ind && !used.has(q)));
      exported.layers = kept.filter((L, i) => !L.td || kept[i + 1] && kept[i + 1].tt);
    }
    function addFills(comp, exported, sceneOf) {
      const from = api.get(comp, "startFrame"), to = api.get(comp, "endFrame");
      const byInd = new Map(exported.layers.map((L) => [L.ind, L]));
      const depth = (L) => byInd.has(L.parent) ? 1 + depth(byInd.get(L.parent)) : 0;
      for (const L of exported.layers.slice().sort((a, b) => depth(b) - depth(a))) {
        const id = sceneOf.get(L);
        if (!id) continue;
        for (const { f, kind } of sceneFilters(id)) {
          if (kind === "blur") {
            const effect = sceneBlur(comp, f, id, from, to);
            for (const D of drawingUnder(exported.layers, L)) {
              D.ef = (D.ef || []).concat(JSON.parse(JSON.stringify(effect)));
              fills++;
            }
            continue;
          }
          const anim = api.getAnimatedAttributes(f) || [];
          const still = api.get(f, "fillColor");
          const driven = drivenAttr(f, "fillColor") && sampleAttr(comp, f, "fillColor", from, to);
          const channels = ["r", "g", "b", "a"].map(
            (c) => driven ? frameKeys(driven, from, (v) => [v[c] / 255]) : anim.indexOf("fillColor." + c) >= 0 ? sceneKeys(f, "fillColor." + c, (v) => v / 255) : { a: 0, k: still[c] / 255 }
          );
          const { color, opacity } = fillProps(channels, from, to);
          if (api.get(f, "blendMode") !== 3) warnings.push("The Fill filter on " + api.getNiceName(id) + " uses a blend mode Lottie\u2019s Fill effect lacks; it exports as Normal");
          for (const D of drawingUnder(exported.layers, L)) {
            D.ef = (D.ef || []).concat(JSON.parse(JSON.stringify(fillEffect(color, opacity))));
            fills++;
          }
        }
      }
    }
    function sceneBlur(comp, f, id, from, to) {
      const anim = api.getAnimatedAttributes(f) || [];
      const scale = BLUR_SCALE[api.getLayerType(f)];
      const axis = (c) => anim.indexOf("amount." + c) >= 0 ? sceneKeys(f, "amount." + c, (v) => v * scale) : { a: 0, k: api.get(f, "amount")[c] * scale };
      let x = axis("x"), y = axis("y");
      if (drivenAttr(f, "amount")) {
        const vals = sampleAttr(comp, f, "amount", from, to);
        const k = (c) => {
          const P = frameKeys(vals, from, (v) => [v[c] * scale]);
          if (!P.a) P.k = P.k[0];
          return P;
        };
        x = k("x");
        y = k("y");
      }
      const same = JSON.stringify(x) === JSON.stringify(y);
      if (!same && !y.a && y.k === 0) return blurEffect(x, 2);
      if (!same && !x.a && x.k === 0) return blurEffect(y, 3);
      if (!same) warnings.push("The " + api.getNiceName(f) + " filter on " + api.getNiceName(id) + " blurs x and y by different amounts; Lottie blurs both by its x amount");
      return blurEffect(x, 1);
    }
    function repair(comp, exported, sceneOf) {
      const start = api.get(comp, "startFrame"), end = api.get(comp, "endFrame");
      const frames = [start, Math.round((start + end) / 2), end];
      const time = api.get(comp, "time") || 0;
      const ids = [...new Set(sceneOf.values())];
      const world = samplePivots(comp, ids, frames);
      const anchorFor = (L) => {
        const id = sceneOf.get(L);
        const pv = id && api.get(id, "pivot");
        if (!pv || (api.getAnimatedAttributes(id) || []).some((x) => x.indexOf("pivot") === 0)) return null;
        if (L.ty === 0) return [pv.x + L.w / 2, L.h / 2 - pv.y];
        return [pv.x, -pv.y];
      };
      const res = repairPositions(exported.layers, frames, anchorFor, (L) => world[sceneOf.get(L)] || null);
      pivots += res.fixed;
      if (res.varying.length) {
        const all = [];
        for (let f = start; f <= end; f++) all.push(f);
        const vids = res.varying.map((L) => sceneOf.get(L));
        const full = samplePivots(comp, vids, all);
        res.varying.forEach((L) => bakePosition(L, full[sceneOf.get(L)], res.parentMatrix));
        baked += res.varying.length;
      }
      const masked = exported.layers.filter((L) => sceneOf.get(L) && !L.masksProperties).map((L) => [L, sceneMasks(sceneOf.get(L))]).filter((x) => x[1].length);
      if (masked.length) {
        const every = [];
        for (let f = start; f <= end; f++) every.push(f);
        const shapesOf = /* @__PURE__ */ new Map();
        for (const [, ms] of masked) for (const m of ms) if (!shapesOf.has(m.id)) shapesOf.set(m.id, sourceShapes(m.id));
        const sampled = samplePivots(comp, [], every, [...new Set([].concat(...shapesOf.values()))]);
        const paths = {};
        for (const [src, shapes] of shapesOf) {
          const byFrame = {};
          for (const f of every) {
            const cs = [].concat(...shapes.map((sh) => sampled[sh] && sampled[sh][f] || []));
            if (cs.length) byFrame[f] = cs;
          }
          paths[src] = byFrame;
        }
        for (const [L, ms] of masked) {
          const withPaths = ms.map((m) => ({ mode: m.mode, paths: paths[m.id] || {} })).filter((m) => Object.keys(m.paths).length);
          maskCount += applyMasks(withPaths, drawingUnder(exported.layers, L), res.parentMatrix);
        }
      }
      api.setFrame(time);
    }
    let json;
    try {
      json = build(compId);
    } finally {
      api.setActiveComp(userComp);
      api.setFrame(userFrame);
    }
    json.assets = (json.assets || []).concat(assets);
    return { json, dirs, warnings, precomps: assets.length, refs, pivots, baked, masks: maskCount, trackMattes, fills, outlined };
  }

  // ../../../../../private/tmp/entry-test.mjs
  globalThis.__exportWithPrecomps = exportWithPrecomps;
  globalThis.__duplicatorCompRefs = duplicatorCompRefs;
})();
