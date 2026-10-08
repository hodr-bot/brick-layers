'use strict';
/*
 * brick.js — Brick Layers: interlocking layers for FDM G-code
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Faithful JavaScript port of GeekDetour/BrickLayers (GPL-3.0, Everson Siqueira),
 * itself an implementation of the "Brick Layers" method popularised by
 * CNC Kitchen (https://youtu.be/5hGm6cubFVs).
 *
 * The upstream is GPL-3.0; relicensing the combined work under AGPL-3.0 is
 * permitted by the GPL-3.0 compatibility clause (section 13), which allows
 * GPL-3.0 material to be combined with AGPLv3-covered material. Both sets of
 * obligations therefore apply: if you modify this project and serve it over
 * a network, you must offer the corresponding source to your users.
 *
 * What it does: on every other layer, the inner perimeters are printed at
 * Z + layerHeight/2 instead of Z. The result is a hexagonal (brick-wall)
 * arrangement instead of a rectangular one, which removes the planar layer
 * boundary and measurably increases layer adhesion (~10-15%).
 *
 * Pure ES module, no dependencies. Runs in the browser and in Node.
 */

/* ------------------------------------------------------------------ */
/* Feature vocabulary (slicer independent)                             */
/* ------------------------------------------------------------------ */

const DEF_TYPES = [';TYPE:', '; FEATURE: '];
const DEF_INNER = new Set(['Perimeter', 'Inner wall']);
const DEF_OUTER = new Set(['External perimeter', 'Outer wall']);
const DEF_OVERHANG = new Set(['Overhang wall']);
const DEF_WIPE_STARTS = [';WIPE_START', '; WIPE_START'];
const DEF_WIPE_ENDS = [';WIPE_END', '; WIPE_END'];
const DEF_LAYER_CHANGES = [';LAYER_CHANGE', '; CHANGE_LAYER'];
const DEF_LAYER_HEIGHTS = [';HEIGHT:', '; LAYER_HEIGHT: '];
const DEF_LAYER_ZS = [';Z:', '; Z_HEIGHT: '];
const DEF_START_OBJECTS = ['; printing object ', '; start printing object, '];
const DEF_STOP_OBJECTS = ['; stop printing object ', '; stop printing object, '];
const DEF_WIDTHS = [';WIDTH:', '; LINE_WIDTH: '];

const SANE_INNER = 'internal_perimeter';
const SANE_OUTER = 'external_perimeter';
const SANE_OVERHANG = 'overhang_perimeter';

/* ------------------------------------------------------------------ */
/* G-code simulator: tracks X/Y/Z/E/F + modes                         */
/* ------------------------------------------------------------------ */

export class Simulator {
  constructor() { this.reset(); }

  reset() {
    this.x = this.y = this.z = this.e = this.f = 0;
    this.retracted = 0;      // retraction "debt", mm
    this.width = 0;
    this.absolute = true;    // G90 default
    this.relExt = false;     // M82 default (absolute extrusion)
    this.isMoving = false;
    this.isExtruding = false;
    this.isRetracting = false;
    this.justStarted = false;
    this.justStopped = false;
    this.movedInXY = false;
    this.travelSpeed = 0;
    this.wipeSpeed = 0;
    this.retractionSpeed = 0;
    this.detractionSpeed = 0;
    this.retractionLength = 0;
    this.constWidth = null;
  }

  /** A stable copy of the machine state, attached to each g-code line. */
  snapshot() {
    // NOTE: this must be a fresh object every call. Callers keep `previous`
    // and `current` per line, and a live view would make every line share
    // the last state, corrupting extrusion deltas.
    return {
      x: this.x, y: this.y, z: this.z, e: this.e, f: this.f,
      width: this.width,
      isExtruding: this.isExtruding, isRetracting: this.isRetracting,
      isMoving: this.isMoving, relExt: this.relExt,
    };
  }

  parse(rawline) {
    this.justStopped = false;
    this.movedInXY = false;
    this.isRetracting = false;
    const stripped = rawline.trim();
    if (!stripped) return this;
    let line = stripped;
    const c = line.indexOf(';');
    if (c !== -1) line = line.slice(0, c);
    line = line.trim();

    if (line) {
      const parts = line.split(/\s+/);
      const cmd = parts[0];

    if (cmd === 'G0' || cmd === 'G1' || cmd === 'G2' || cmd === 'G3') {
      const oldExtruding = this.isExtruding;
      const oldX = this.x, oldY = this.y, oldZ = this.z, oldE = this.e;
      let nx = this.x, ny = this.y, nz = this.z, ne = this.e, nf = this.f;
      let hasX = false, hasY = false, hasZ = false, hasE = false, hasF = false;
      const absPos = this.absolute, relExt = this.relExt;
      for (let i = 1; i < parts.length; i++) {
        const arg = parts[i];
        const axis = arg.charCodeAt(0);
        const v = parseFloat(arg.slice(1));
        if (!isFinite(v)) continue;
        if (axis === 73 /* I */ || axis === 74 /* J */) continue;
        if (axis === 88 /* X */) { nx = absPos ? v : this.x + v; hasX = true; }
        else if (axis === 89 /* Y */) { ny = absPos ? v : this.y + v; hasY = true; }
        else if (axis === 90 /* Z */) { nz = absPos ? v : this.z + v; hasZ = true; }
        else if (axis === 69 /* E */) { ne = relExt ? this.e + v : v; hasE = true; }
        else if (axis === 70 /* F */) { nf = v; hasF = true; }
      }
      const xMove = nx !== oldX, yMove = ny !== oldY, zMove = nz !== oldZ;
      const hadChange = xMove || yMove || zMove;
      this.movedInXY = xMove || yMove;
      const justFeed = hasF && !(hasX || hasY || hasZ);

      if (hasX || hasY || hasZ) { this.x = nx; this.y = ny; this.z = nz; }
      this.e = ne; this.f = nf;   // E/F update unconditionally (matches upstream)
      let extruding = false;
      const extruded = ne - oldE;
      if (extruded > 0) {
        extruding = true;
        this.isExtruding = true;
      } else if (extruded < 0) {
        this.isRetracting = true;
      }
      this.retracted += extruded;
      if (this.retracted + 0.0001 > 0) this.retracted = 0;

      if (hadChange && ne === oldE && this.travelSpeed < nf) this.travelSpeed = nf;
      if (!hadChange && this.isRetracting && Math.abs(extruded) > this.retractionLength) {
        this.retractionLength = Math.abs(extruded);
      }
      if (hadChange) this.isMoving = true;
      else if (extruded !== 0 && !hadChange) this.isMoving = false;
      if (!justFeed) {
        this.justStarted = extruding && !oldExtruding && hadChange;
        if (oldExtruding && !this.isExtruding) this.justStopped = true;
      }
      if (!extruding && extruded <= 0) this.isExtruding = false;
      return this;
    }
    if (cmd === 'G90') { this.absolute = true; return this; }
    if (cmd === 'G91') { this.absolute = false; return this; }
    if (cmd === 'M82') { this.relExt = false; return this; }
    if (cmd === 'M83') { this.relExt = true; return this; }
    if (cmd === 'G92') {
      for (let i = 1; i < parts.length; i++) {
        const arg = parts[i];
        const axis = arg[0].toUpperCase();
        if ('XYZE'.includes(axis)) {
          const v = parseFloat(arg.slice(1));
          if (isFinite(v)) {
            if (axis === 'X') this.x = v;
            else if (axis === 'Y') this.y = v;
            else if (axis === 'Z') this.z = v;
            else if (axis === 'E') this.e = v;
          }
        }
      }
      if (this.e === 0) this.retracted = 0;
      return this;
    }
    if (this.constWidth === null) {
      for (const p of DEF_WIDTHS) {
        if (stripped.startsWith(p)) { this.width = parseFloat(stripped.slice(p.length)); this.constWidth = p; break; }
      }
    }
    return this;
    }  // end: if (line)
  }
}

/* ------------------------------------------------------------------ */
/* Feature tracker: ;TYPE:, layers, objects, wipes                    */
/* ------------------------------------------------------------------ */

export class Feature {
  constructor() {
    this.layer = 0;
    this.z = 0;
    this.height = 0;
    this.layerChange = false;
    this.currentObject = null;
    this.currentType = '';
    this.lastType = '';
    this.internalPerimeter = false;
    this.externalPerimeter = false;
    this.overhangPerimeter = false;
    this.justEnteredInner = false;
    this.justLeftInner = false;
    this.justEnteredOuter = false;
    this.justChangedType = false;
    this.wiping = false;
    this.wipeWillFinish = false;
    this.wipeJustFinished = true;
    this.captureHeight = true;
    // captured dialect constants
    this.internalType = null;
    this.externalType = null;
    this.wipeStart = null;
    this.wipeEnd = null;
    this.objStart = null;
    this.objStop = null;
    this.layerChangeLine = null;
    this.layerHeightConst = null;
    this.layerZConst = null;
  }

  parse(line) {
    const stripped = line.trim();
    const oldInner = this.internalPerimeter;
    this.justChangedType = false;
    this.justEnteredInner = false;
    this.justEnteredOuter = false;
    this.justLeftInner = false;
    this.wipeJustFinished = false;
    this.layerChange = false;

    if (this.wipeWillFinish) {
      this.wiping = false;
      this.wipeJustFinished = true;
      this.wipeWillFinish = false;
    }
    if (!line || line[0] !== ';') return this;

    let matchedType = false;
    for (const p of DEF_TYPES) {
      if (line.startsWith(p)) {
        const newType = line.slice(p.length).trim();
        matchedType = true;
        if (DEF_INNER.has(newType)) {
          if (this.internalType === null) this.internalType = line.endsWith('\n') ? line : line + '\n';
          this.currentType = SANE_INNER;
          if (!this.internalPerimeter) this.justEnteredInner = true;
          this.internalPerimeter = true;
          this.externalPerimeter = false;
          this.overhangPerimeter = false;
        } else if (DEF_OUTER.has(newType)) {
          if (this.externalType === null) this.externalType = line.endsWith('\n') ? line : line + '\n';
          this.currentType = SANE_OUTER;
          if (!this.externalPerimeter) this.justEnteredOuter = true;
          this.externalPerimeter = true;
          this.internalPerimeter = false;
          this.overhangPerimeter = false;
        } else if (DEF_OVERHANG.has(newType)) {
          this.currentType = SANE_OVERHANG;
          this.overhangPerimeter = true;
        } else {
          this.internalPerimeter = false;
          this.externalPerimeter = false;
          this.overhangPerimeter = false;
          this.currentType = newType;
        }
        break;
      }
    }
    if (matchedType) {
      const oldType = this.currentType;
      this.justChangedType = true;
      if (oldInner && !this.internalPerimeter) this.justLeftInner = true;
      if (!this.justChangedType) this.lastType = this.currentType;
      return this;
    }

    let handled = false;
    for (const p of DEF_WIPE_STARTS) {
      if (stripped === p) {
        this.wiping = true;
        if (this.wipeStart === null) this.wipeStart = p + '\n';
        handled = true; break;
      }
    }
    if (handled) return this;
    for (const p of DEF_WIPE_ENDS) {
      if (stripped === p) {
        this.wipeWillFinish = true;
        if (this.wipeEnd === null) this.wipeEnd = p + '\n';
        handled = true; break;
      }
    }
    if (handled) return this;

    for (const p of DEF_START_OBJECTS) {
      if (stripped.startsWith(p)) {
        const name = stripped.slice(p.length);
        if (this.objStart === null) this.objStart = p;
        this.currentObject = name;
        handled = true; break;
      }
    }
    if (handled) return this;

    if (this.objStop === null) {
      for (const p of DEF_STOP_OBJECTS) {
        if (stripped.startsWith(p)) { this.objStop = p; handled = true; break; }
      }
      if (handled) return this;
    }

    for (const p of DEF_LAYER_CHANGES) {
      if (stripped === p) {
        if (this.layerChangeLine === null) this.layerChangeLine = line.endsWith('\n') ? line : line + '\n';
        this.layerChange = true;
        this.internalPerimeter = false;
        this.externalPerimeter = false;
        this.layer += 1;
        this.captureHeight = true;
        handled = true; break;
      }
    }
    if (handled) return this;

    for (const p of DEF_LAYER_ZS) {
      if (stripped.startsWith(p)) {
        const v = parseFloat(stripped.slice(p.length));
        if (isFinite(v)) this.z = v;
        if (this.layerZConst === null) this.layerZConst = p;
        handled = true; break;
      }
    }
    if (handled) return this;

    for (const p of DEF_LAYER_HEIGHTS) {
      if (stripped.startsWith(p)) {
        if (this.captureHeight) {
          const v = parseFloat(stripped.slice(p.length));
          if (isFinite(v)) this.height = v;
          this.captureHeight = false;
        }
        if (this.layerHeightConst === null) this.layerHeightConst = p;
        handled = true; break;
      }
    }
    if (handled) return this;

    if (!this.justChangedType) this.lastType = this.currentType;
    return this;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                   */
/* ------------------------------------------------------------------ */

function distX(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

class BBox {
  constructor() { this.minX = Infinity; this.maxX = -Infinity; this.minY = Infinity; this.maxY = -Infinity; }
  compute(p) {
    if (this.minX === Infinity) {
      this.minX = p.x - 0.1; this.maxX = p.x + 0.1;
      this.minY = p.y - 0.1; this.maxY = p.y + 0.1;
    } else {
      if (p.x < this.minX) this.minX = p.x;
      if (p.x > this.maxX) this.maxX = p.x;
      if (p.y < this.minY) this.minY = p.y;
      if (p.y > this.maxY) this.maxY = p.y;
    }
  }
  contains(o) {
    return this.minX <= o.minX && this.maxX >= o.maxX && this.minY <= o.minY && this.maxY >= o.maxY;
  }
}

/* Loop nesting tree: tells which loops sit at which concentric depth. */
function buildLoopTree(nodes, aroundHole) {
  const parents = [];
  let previous = null;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (i === 0) { previous = node; continue; }
    if (node.bbox.contains(previous.bbox)) {
      node.kids.push(previous);
      if (aroundHole) { node.aroundHole = true; previous.aroundHole = true; }
      const toRemove = [];
      for (const p of parents) {
        if (node.bbox.contains(p.bbox)) { node.kids.push(p); toRemove.push(p); }
      }
      for (const p of toRemove) parents.splice(parents.indexOf(p), 1);
    } else {
      parents.push(previous);
    }
    previous = node;
  }
  parents.push(previous);
  return parents;
}

function propagate(node, moving, depth = 0, myGroup = null) {
  if (myGroup === null) { LoopNode.concentric += 1; myGroup = LoopNode.concentric; }
  node.depth = depth;
  let kidDepth = null;
  if (node.kids.length === 1) {
    kidDepth = propagate(node.kids[0], moving, depth + 1, LoopNode.concentric);
  } else if (node.kids.length > 1) {
    for (const kid of node.kids) {
      LoopNode.concentric += 1;
      propagate(kid, moving, depth + 1, LoopNode.concentric);
    }
  }
  if (node.aroundHole) {
    if (node.kids.length === 0) { node.depth = 0; depth = 0; }
    else if (kidDepth !== null) { node.depth = kidDepth; depth = kidDepth; }
  }
  if ((depth + 1) % 2) moving[node.order] = true;
  for (const ln of node.loopLines) {
    ln.loopOrder = depth;
    ln.concentricGroup = myGroup;
  }
  if (node.aroundHole) return depth + 1;
  return kidDepth;
}

class LoopNode {
  constructor(order, bbox, loopLines) {
    this.aroundHole = false;
    this.depth = 0;
    this.bbox = bbox;
    this.order = order;
    this.loopLines = loopLines;
    this.kids = [];
  }
}
LoopNode.concentric = 0;

/**
 * Returns a boolean list: true for loops that must be shifted up by
 * half a layer height (the "brick" shift).
 */
function calculateLoopDepth(groupPerimeter) {
  const moving = new Array(groupPerimeter.length).fill(false);
  const nodes = [];
  for (let i = 0; i < groupPerimeter.length; i++) {
    const loop = groupPerimeter[i];
    const bb = new BBox();
    for (const ln of loop) {
      if (ln.current && ln.current.isExtruding) bb.compute(ln.current);
    }
    nodes.push(new LoopNode(i, bb, loop));
  }
  const reverse = nodes.map(n => new LoopNode(n.order, n.bbox, n.loopLines)).reverse();
  const direct = buildLoopTree(nodes, false);
  const rev = buildLoopTree(reverse, true);
  const merged = [];
  for (const parent of direct) {
    if (parent.kids.length) { merged.push(parent); continue; }
    const match = rev.find(rp => rp.order === parent.order);
    if (match && match.kids.length) merged.push(match);
    else merged.push(parent);
  }
  LoopNode.concentric = 0;
  for (const parent of merged) {
    LoopNode.concentric += 1;
    propagate(parent, moving, 0);
  }
  return moving;
}

/* ------------------------------------------------------------------ */
/* G-code line wrapper                                                */
/* ------------------------------------------------------------------ */

const RE_X = /X[-+]?[0-9]*\.?[0-9]+/;
const RE_Y = /Y[-+]?[0-9]*\.?[0-9]+/;

function newLine(text) {
  return { gcode: text, previous: null, current: null, object: null, loopOrder: 0, concentricGroup: 0 };
}

/**
 * Rewrite the E value of a gcode move.
 *
 * Python's rule (new_line_from_multiplier): write the SCALED DELTA as a
 * relative E, and re-synchronise the absolute register with a trailing
 * G92 E<previous absolute>. The delta is what it is: previous.e is NOT
 * added back in here.
 */
function applyMultiplier(line, multiplier) {
  const delta = line.current.e - line.previous.e;
  if (delta === 0) return line;
  const e = delta * multiplier;
  const parts = line.gcode.split(/(\s+)/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith('E')) { parts[i] = 'E' + e.toFixed(5); break; }
  }
  line.gcode = parts.join('');
  return line;
}

/* ------------------------------------------------------------------ */
/* The processor                                                      */
/* ------------------------------------------------------------------ */

export class BrickProcessor {
  constructor(opts = {}) {
    this.extrusion = opts.extrusion ?? 1.05;      // global extrusion multiplier
    this.startAtLayer = opts.startAtLayer ?? 3;   // preserve the first N layers
    this.ignoreLayers = new Set(opts.ignoreLayers || []);
    this.flattenLastLayer = opts.flattenLastLayer !== false;
    this.headerComment = opts.headerComment ?? null;
    // optional override; when null the layer height is read from the g-code
    this.layerHeight = opts.layerHeightOverride ?? null;

    this.travelThreshold = 1.5;  // mm — below that, no retraction/wipe
    this.wipeDistance = 2.0;     // mm — total wipe length
    this.retractBeforeWipe = 0.8;
    this.travelZhop = 0.4;       // mm

    this.retractedDebt = 0;
    this.lastNonInternalXYLine = null;

    // streaming state
    this.sim = new Simulator();
    this.feat = new Feature();
    this.prevState = this.sim.snapshot();
    this.buffer = [];
    this.deferred = [];     // [perimeter][loop][line]
    this.keptLoops = [];
    this.pending = '';
    this.stillInHeader = true;
    this.detectSpeeds = true;
    this.knifeActive = false;
    this.layerChangedDuringInner = false;
    this.headerEmitted = false;

    // stats
    this.statLines = 0;
    this.statLayers = 0;
    this.statMoved = 0;
    this.statKept = 0;
    this.statBytes = 0;
    this.layerHeightSeen = 0;
  }

  snapshot() { return this.sim.snapshot(); }

  /* --- internal gcode emit helpers ------------------------------- */
  emit(text) { this.buffer.push(newLine(text.endsWith('\n') ? text : text + '\n')); }

  /** Travel from the end of `loop` (or startState) to targetState. */
  travelTo(targetState, loop = null, startState = null, z = null) {
    const out = [];
    const sim = this.sim;
    let start;
    if (loop !== null) start = loop[loop.length - 1].current;
    else start = startState;
    if (!start) start = targetState;

    let moveZ = '', hopZ = '';
    if (z !== null) { moveZ = ' Z' + z.toFixed(2); hopZ = ' Z' + (z + this.travelZhop).toFixed(2); }

    const push = (t) => out.push(newLine(t.endsWith('\n') ? t : t + '\n'));
    const ts = Math.trunc(sim.travelSpeed);

    if (distX(start, targetState) < this.travelThreshold) {
      const mv = newLine(`G1 X${targetState.x} Y${targetState.y}${moveZ} F${ts} ; BRICK: Travel (no-retraction)\n`);
      push(mv.gcode);
      this.lastNonInternalXYLine = mv;
      push(`G1 F${Math.trunc(targetState.f)} ; BRICK: Feed Rate (no wipe)\n`);
      return out;
    }
    if (sim.retractionLength > 0 && sim.retractionSpeed > 0) {
      const r = sim.wipeSpeed === 0 ? sim.retractionLength : sim.retractionLength * this.retractBeforeWipe;
      push(`G1 E-${r.toFixed(2)} F${Math.trunc(sim.retractionSpeed)} ; BRICK: Retraction\n`);
      this.retractedDebt += r;
    }
    if (loop !== null && sim.wipeSpeed > 0 && this.retractBeforeWipe < 1) {
      out.push(...this.wipe(loop));
    }
    const mv = newLine(`G1 X${targetState.x} Y${targetState.y}${hopZ} F${ts} ; BRICK: Target Position\n`);
    push(mv.gcode);
    this.lastNonInternalXYLine = mv;
    if (z !== null) push(`G1 Z${z.toFixed(2)} ; BRICK: Target Position\n`);
    if (this.retractedDebt > 0 && sim.retractionSpeed > 0) {
      push(`G1 E${this.retractedDebt.toFixed(2)} F${Math.trunc(sim.retractionSpeed)} ; BRICK: Unretract\n`);
      this.retractedDebt = 0;
    }
    return out;
  }

  wipe(loop) {
    const sim = this.sim;
    const total = sim.retractionLength * (1 - this.retractBeforeWipe);
    const perMm = total / this.wipeDistance;
    const start = loop[loop.length - 1].current;
    const out = [];
    const push = (t) => out.push(newLine(t.endsWith('\n') ? t : t + '\n'));

    let path;
    let forward;
    if (distX(start, loop[0].previous) < 1) { forward = true; path = loop; }
    else { forward = false; path = [...loop].reverse(); }

    const points = [], extrusions = [];
    let travelled = 0;
    for (const ln of path) {
      if (!ln.current.isExtruding) continue;
      const from = forward ? ln.previous : ln.current;
      const to = forward ? ln.current : ln.previous;
      const seg = distX(from, to);
      if (seg <= 1e-6) continue;
      if (travelled + seg >= this.wipeDistance) {
        const need = this.wipeDistance - travelled;
        const f = seg > 0 ? need / seg : 0;
        points.push({ x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f });
        extrusions.push(need * perMm);
        break;
      }
      points.push(to);
      extrusions.push(seg * perMm);
      travelled += seg;
    }
    push(this.feat.wipeStart || ';WIPE_START\n');
    push(`G1 F${Math.trunc(sim.wipeSpeed)}\n`);
    let last = null;
    for (let i = 0; i < points.length; i++) {
      last = `G1 X${points[i].x.toFixed(3)} Y${points[i].y.toFixed(3)} E-${extrusions[i].toFixed(5)} ; BRICK: Wipe\n`;
      push(last);
      this.lastNonInternalXYLine = out[out.length - 1];
    }
    push(this.feat.wipeEnd || ';WIPE_END\n');
    this.retractedDebt += total;
    return out;
  }

  stopObject(name) {
    return (this.feat.objStop || '; stop printing object ') + name + '\n';
  }

  /** Build the brick-shifted sub-layer from the deferred perimeters. */
  generateDeferred(myline, extrusionMultiplier) {
    const feat = this.feat, sim = this.sim;
    const deferred = this.deferred;
    if (deferred.length === 0) return;

    // effective layer height: user override wins, else the value sliced in
    const h = this.layerHeight !== null ? this.layerHeight : feat.height;
    const targetZ = feat.z + h / 2;
    const higherZ = feat.z + h + 0.2;
    let currentObject = null;
    let previousLoop = null;
    let previousPerimeter = -1;
    let shouldMoveUp = false;

    for (let pi = 0; pi < deferred.length; pi++) {
      const perimeter = deferred[pi];
      const isFirstPerimeter = pi === 0;
      const isLastPerimeter = pi === deferred.length - 1;
      for (let li = 0; li < perimeter.length; li++) {
        const loop = perimeter[li];
        const isFirstLoop = li === 0;
        const isLastLoop = li === perimeter.length - 1;
        for (let i = 0; i < loop.length; i++) {
          const dl = loop[i];
          const isFirstLine = i === 0;
          const isLastLine = i === loop.length - 1;

          if (isFirstPerimeter && isFirstLoop && isFirstLine) {
            const fix = this.lastNonInternalXYLine;
            if (fix && fix.current && !fix.current.isExtruding) {
              fix.gcode = `G1 X${dl.previous.x} Y${dl.previous.y} Z${higherZ.toFixed(2)} F${Math.trunc(sim.travelSpeed)} ; BRICK: Travel Fix Up\n`;
              this.lastNonInternalXYLine = null;
            } else {
              shouldMoveUp = true;
            }
            if (feat.currentObject !== null) this.emit(this.stopObject(feat.currentObject));
            if (!dl.current.relExt) this.emit('M83 ; BRICK: Change to Relative Extrusion\n');
            this.emit(feat.layerChangeLine || ';LAYER_CHANGE\n');
            this.emit(`${feat.layerZConst || ';Z:'}${targetZ.toFixed(2)}\n`);
            this.emit(`;${targetZ.toFixed(2)}\n`);
            this.emit(`${feat.layerHeightConst || ';HEIGHT:'}${h.toFixed(2)}\n`);
            if (shouldMoveUp) {
              this.buffer.push(...this.travelTo(dl.previous, null, dl.previous, higherZ));
              this.emit(`G1 Z${targetZ.toFixed(2)} F${Math.trunc(sim.travelSpeed)} ; BRICK: Z-Hop Down\n`);
            }
            this.emit(feat.internalType || ';TYPE:Inner wall\n');
            this.emit(`${sim.constWidth || ';WIDTH:'}${dl.current.width.toFixed(2)}\n`);
          }

          if (currentObject !== dl.object) {
            if (currentObject !== null) this.emit(this.stopObject(currentObject));
            if (previousLoop !== null) {
              this.buffer.push(...this.travelTo(dl.previous, previousLoop, null, targetZ));
            } else {
              this.buffer.push(...this.travelTo(dl.previous, null, dl.previous, targetZ));
            }
            this.emit(`${feat.objStart || '; printing object '}${dl.object}\n`);
            this.emit(`G1 F${Math.trunc(dl.previous.f)} ; BRICK: FeedRate\n`);
            currentObject = dl.object;
          } else if (isFirstLine) {
            if (previousLoop !== null) {
              this.buffer.push(...this.travelTo(dl.previous, previousLoop, null, targetZ));
            } else {
              this.buffer.push(...this.travelTo(dl.previous, null, dl.previous, targetZ));
            }
            this.emit(`G1 F${Math.trunc(dl.previous.f)} ; BRICK: FeedRate\n`);
          }

          this.buffer.push(applyMultiplier(dl, extrusionMultiplier));
          this.statLines++;

          if (isLastPerimeter && isLastLoop && isLastLine && currentObject !== null) {
            this.emit(this.stopObject(currentObject));
            currentObject = null;
          }
          if (isLastPerimeter && isLastLoop && isLastLine && !dl.current.relExt) {
            this.emit('M82 ; BRICK: Return to Absolute Extrusion\n');
            this.emit(`G92 E${myline.previous.e} ; BRICK: Resets the Extruder absolute position\n`);
          }
          if (previousPerimeter !== pi) previousPerimeter = pi;
          previousLoop = loop;
        }
      }
    }
    this.deferred.length = 0;
    this.emit(`G1 X${myline.previous.x} Y${myline.previous.y} F${Math.trunc(sim.travelSpeed)} ; BRICK: Calculated to next coordinate\n`);
    this.emit(`G1 F${Math.trunc(myline.previous.f)} ; BRICK: Feed Rate\n`);
  }

  /* --- one gcode line ------------------------------------------- */
  processLine(raw) {
    const out = [];
    const sim = this.sim, feat = this.feat;
    const firstLine = !this.headerEmitted;

    sim.parse(raw);
    const current = sim.snapshot();
    feat.parse(raw);
    if (this.layerHeightSeen === 0 && feat.height > 0) this.layerHeightSeen = feat.height;

    const myline = newLine(raw);
    myline.object = feat.currentObject;

    if (this.stillInHeader && raw.startsWith(';TYPE:Custom')) this.stillInHeader = false;

    let extrusionMultiplier;
    if (feat.layer === this.startAtLayer) extrusionMultiplier = this.extrusion * 1.5;
    else extrusionMultiplier = this.extrusion;

    if (this.detectSpeeds) {
      if (sim.retractionSpeed === 0 && feat.wiping) sim.retractionSpeed = sim.f;
      if (sim.wipeSpeed === 0 && feat.wipeWillFinish) sim.wipeSpeed = sim.f;
      if (sim.detractionSpeed === 0 && sim.retractionSpeed > 0 && sim.isExtruding) sim.detractionSpeed = sim.f;
      if (sim.wipeSpeed > 0 && sim.detractionSpeed > 0 && sim.retractionSpeed > 0) this.detectSpeeds = false;
    }

    if (this.layerChangedDuringInner && sim.isExtruding && sim.isMoving) {
      feat.internalPerimeter = true;
      this.layerChangedDuringInner = false;
    }

    const active = feat.layer >= this.startAtLayer && !this.ignoreLayers.has(feat.layer);

    /* ---- capture internal perimeters, regrouped in loops --------- */
    if (feat.internalPerimeter) {
      if (active) {
        myline.previous = this.prevState;
        myline.current = current;
        myline.object = feat.currentObject;
        if (raw.startsWith('SET_VELOCITY_LIMIT ') || raw.startsWith('M204 ')) {
          // preserved through specialAccelCommand, re-inserted after the kept loops
          this.specialAccel = myline;
          return out;
        }
        if (!this.knifeActive && (feat.wiping || sim.retracted < 0 || sim.justStopped)) {
          this.knifeActive = true;
        } else if (this.knifeActive && sim.isExtruding && sim.isMoving) {
          this.knifeActive = false;
        } else if (this.knifeActive && !feat.wiping && raw.startsWith('G1 F')) {
          this.knifeActive = false;
        }
        if (feat.justEnteredInner) {
          if (this.deferred.length === 0) this.deferred.push([]);
          this.groupLoop = [];
          this.deferred[this.deferred.length - 1].push(this.groupLoop);
        } else if (this.knifeActive) {
          if (this.groupLoop && this.groupLoop.length > 0) {
            this.groupLoop = [];
            this.deferred[this.deferred.length - 1].push(this.groupLoop);
          }
        } else if (!this.knifeActive) {
          if (this.groupLoop) this.groupLoop.push(myline);
        }
      } else {
        this.buffer.push(myline);
      }
    }

    if (feat.layerChange && feat.currentType === SANE_INNER && this.deferred.length > 0) {
      this.layerChangedDuringInner = true;
    }

    /* ---- just left the internal perimeters: reorder ------------- */
    if (feat.justLeftInner || this.layerChangedDuringInner) {
      this.knifeActive = false;
      myline.previous = this.prevState;
      myline.current = current;

      // "group perimeter" = the most recently opened group of inner-wall loops
      const gidx = this.deferred.length - 1;
      let group = gidx >= 0 ? this.deferred[gidx] : [];
      while (group.length && group[group.length - 1].length === 0) group.pop();
      if (group.length > 0) {
        const movingSeq = calculateLoopDepth(group);
        const stay = [], moving = [];
        for (let i = 0; i < movingSeq.length; i++) {
          if (movingSeq[i]) moving.push(group[i]);
          else stay.push(group[i]);
        }
        this.deferred[gidx] = moving;

        // Re-emit the loops that stay at the current Z, with extrusion multiplier
        if (stay.length > 0) {
          let previousLoop = null;
          for (let li = 0; li < stay.length; li++) {
            const loop = stay[li];
            const isFirstLoop = li === 0;
            for (let i = 0; i < loop.length; i++) {
              const kl = loop[i];
              const isFirstLine = i === 0;
              if (isFirstLoop && isFirstLine) {
                const fix = this.lastNonInternalXYLine;
                if (fix && fix.current && !fix.current.isExtruding) {
                  const g = fix.gcode.replace(RE_X, 'X' + kl.previous.x).replace(RE_Y, 'Y' + kl.previous.y);
                  fix.gcode = g.endsWith('\n') ? g : g + '\n';
                  this.lastNonInternalXYLine = null;
                }
                this.emit(feat.internalType || ';TYPE:Inner wall\n');
                this.emit(`${feat.layerHeightConst || ';HEIGHT:'}${feat.height}\n`);
                if (!kl.current.relExt) this.emit('M83 ; BRICK: Change to Relative Extrusion\n');
              }
              if (isFirstLine) {
                if (previousLoop !== null) this.buffer.push(...this.travelTo(kl.previous, previousLoop, null, feat.z));
                else this.buffer.push(...this.travelTo(kl.previous, null, kl.previous, feat.z));
                this.emit(`G1 F${Math.trunc(kl.previous.f)} ; BRICK: Feed Rate\n`);
              }
              this.buffer.push(applyMultiplier(kl, extrusionMultiplier));
              this.statLines++;
              previousLoop = loop;
            }
          }
          // once, after the whole kept run: restore absolute extrusion
          if (!stay[0][0].current.relExt) {
            this.emit('M82 ; BRICK: Return to Absolute Extrusion\n');
            this.emit(`G92 E${myline.previous.e} ; BRICK: Resets the Extruder absolute position\n`);
          }
          this.emit(`${sim.constWidth || ';WIDTH:'}${myline.previous.width}\n`);
          this.emit(`${feat.layerHeightConst || ';HEIGHT:'}${feat.height.toFixed(2)}\n`);
        }
      }
      if (active) {
        this.emit(`G1 X${myline.previous.x} Y${myline.previous.y} F${Math.trunc(sim.travelSpeed)} ; BRICK: Calculated to next coordinate\n`);
        this.emit(`G1 F${Math.trunc(myline.previous.f)} ; BRICK: Feed Rate\n`);
      }
      if (this.specialAccel) { this.buffer.push(this.specialAccel); this.specialAccel = null; }
    }

    /* ---- layer change (or end of print): flush ------------------ */
    if (feat.layerChange || (feat.currentType === 'Custom' && feat.justChangedType && current.z > 0)) {
      myline.previous = this.prevState;
      myline.current = current;
      const isEnd = feat.currentType === 'Custom' && current.z > 0;
      if (isEnd) {
        if (this.flattenLastLayer) {
          // the last brick sub-layer is pulled back half a layer so the very
          // top of the part stays flat, mirroring upstream.
          const hh = this.layerHeight !== null ? this.layerHeight : feat.height;
          feat.z = feat.z - hh / 2;
          extrusionMultiplier = extrusionMultiplier / 2;
        }
      }
      this.generateDeferred(myline, extrusionMultiplier);
      if (feat.currentType === SANE_OUTER) this.emit(feat.externalType || ';TYPE:External perimeter\n');
      if (this.specialAccel) { this.buffer.push(this.specialAccel); this.specialAccel = null; }
      if (feat.layerChange) this.statLayers++;

      out.push(...this.buffer.map(b => b.gcode));
      this.buffer.length = 0;
      this.deferred.length = 0;
    }

    /* ---- everything else passes through ------------------------- */
    if (!feat.internalPerimeter) {
      this.buffer.push(myline);
      if (sim.movedInXY) {
        myline.current = current;
        this.lastNonInternalXYLine = myline;
      }
      if (feat.justChangedType && ['Internal Bridge', 'Ironing', 'Bridge', 'Sparse infill'].includes(feat.currentType)
          && raw.startsWith(feat.layerHeightConst || ';HEIGHT:')) {
        myline.gcode = `${feat.layerHeightConst || ';HEIGHT:'}${feat.height}\n`;
      }
      if (feat.justEnteredOuter && sim.constWidth !== null) {
        this.emit(`${sim.constWidth}${current.width}\n`);
      }
    }

    this.prevState = current;
    this.statLines++;
    this.statBytes += raw.length;
    if (firstLine && !this.headerEmitted) this.headerEmitted = true;
    return out;
  }

  /** Feed a chunk of text; returns the g-code produced so far. */
  feed(text) {
    this.pending += text;
    const out = [];
    let idx;
    while ((idx = this.pending.indexOf('\n')) !== -1) {
      const raw = this.pending.slice(0, idx + 1);
      this.pending = this.pending.slice(idx + 1);
      const produced = this.processLine(raw);
      for (const p of produced) out.push(p);
    }
    return out;
  }

  /** Flush the remaining partial line and buffered output. */
  finish() {
    const out = [];
    if (this.pending) {
      const produced = this.processLine(this.pending);
      for (const p of produced) out.push(p);
      this.pending = '';
    }
    out.push(...this.buffer.map(b => b.gcode));
    this.buffer.length = 0;
    this.keptLoops = [];
    this.groupPerimeter = [];
    this.deferred.length = 0;
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* One-shot helper (small files, tests)                               */
/* ------------------------------------------------------------------ */

export function processGcode(text, opts = {}) {
  const p = new BrickProcessor(opts);
  const chunks = p.feed(text);
  chunks.push(...p.finish());
  return { gcode: chunks.join(''), stats: { lines: p.statLines, layers: p.statLayers, height: p.layerHeightSeen } };
}
