// Ornament Builder - rhombic tile composition tool
// Loads vector tiles from ./export/vector_tiles/ and uses manifest.json
// adjacency rules ("bonds") to snap tiles together by shared 3D edges.

const SVG_NS = "http://www.w3.org/2000/svg";
const MANIFEST_URL = "./export/vector_tiles/manifest.json";
const TILE_BASE = "./export/vector_tiles/";
const STORAGE_KEY = "ornament_builder_sets_v1";

// Tolerances (in image-pixel units; tile edges ≈ 1858 px)
const EDGE_COINCIDE_EPS = 50;
const OVERLAP_EPS = 30;

// ---- State ----
const state = {
  manifest: null,
  assets: {},
  bondsByEdge: {},      // "face,edge" -> [{toFace, toEdge, type}]
  tileSvgInner: {},     // assetId -> array of cloned <Element>
  placed: [],           // {uid, assetId, mat, parity, occupiedEdges}
  uidCounter: 1,
  selectedUid: null,
  drag: null,
  mirrorMode: false,    // toggled with spacebar
  view: { tx: 0, ty: 0, scale: 0.05 },
  pan: null,
};

// ---- DOM ----
const stage = document.getElementById("stage");
const canvas = document.getElementById("canvas");
const palette = document.getElementById("palette");
const statusEl = document.getElementById("status");
const mirrorIndicator = document.getElementById("mirror-indicator");

const viewportG = document.createElementNS(SVG_NS, "g");
viewportG.setAttribute("id", "viewport");
canvas.appendChild(viewportG);
const placedG = document.createElementNS(SVG_NS, "g");
placedG.setAttribute("id", "placed");
viewportG.appendChild(placedG);
const overlayG = document.createElementNS(SVG_NS, "g");
overlayG.setAttribute("id", "overlay");
viewportG.appendChild(overlayG);
const ghostG = document.createElementNS(SVG_NS, "g");
ghostG.setAttribute("id", "ghost");
viewportG.appendChild(ghostG);

// ---- Math helpers ----
function applyMat(m, p) {
  return [m.a * p[0] + m.c * p[1] + m.tx, m.b * p[0] + m.d * p[1] + m.ty];
}
function matToString(m) {
  return `matrix(${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty})`;
}

// Build orientation-preserving rigid map (rotation + translation) sending P1->Q1 and P2->Q2.
function rigidTransform(P1, P2, Q1, Q2) {
  const angP = Math.atan2(P2[1] - P1[1], P2[0] - P1[0]);
  const angQ = Math.atan2(Q2[1] - Q1[1], Q2[0] - Q1[0]);
  const t = angQ - angP;
  const ct = Math.cos(t), st = Math.sin(t);
  const tx = Q1[0] - (ct * P1[0] - st * P1[1]);
  const ty = Q1[1] - (st * P1[0] + ct * P1[1]);
  return { a: ct, b: st, c: -st, d: ct, tx, ty };
}

function dist(p, q) {
  const dx = p[0] - q[0], dy = p[1] - q[1];
  return Math.hypot(dx, dy);
}

function polygonCenter(polygon) {
  let cx = 0, cy = 0;
  for (const v of polygon) { cx += v.point[0]; cy += v.point[1]; }
  return [cx / polygon.length, cy / polygon.length];
}

// Local matrix expressing tile parity. parity=1 -> identity (null);
// parity=-1 -> reflect across the vertical axis through image-width/2.
function localMatForParity(asset, parity) {
  if (parity !== -1) return null;
  return { a: -1, b: 0, c: 0, d: 1, tx: asset.image.width, ty: 0 };
}

// SAT-based overlap test for convex polygons. Returns true if they share interior area.
// Two polygons that only share an edge (or a vertex) return false.
function polygonsOverlap(A, B) {
  for (const poly of [A, B]) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const nx = -(b[1] - a[1]);
      const ny = b[0] - a[0];
      let minA = Infinity, maxA = -Infinity;
      for (const p of A) {
        const d = p[0] * nx + p[1] * ny;
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      let minB = Infinity, maxB = -Infinity;
      for (const p of B) {
        const d = p[0] * nx + p[1] * ny;
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      // Separated (with shared-edge tolerance) on this axis -> no overlap.
      if (maxA - minB <= OVERLAP_EPS || maxB - minA <= OVERLAP_EPS) return false;
    }
  }
  return true;
}

function edgesCoincide(e1, e2) {
  const m1 = [(e1.from[0] + e1.to[0]) / 2, (e1.from[1] + e1.to[1]) / 2];
  const m2 = [(e2.from[0] + e2.to[0]) / 2, (e2.from[1] + e2.to[1]) / 2];
  if (dist(m1, m2) > EDGE_COINCIDE_EPS) return false;
  return (dist(e1.from, e2.to) < EDGE_COINCIDE_EPS && dist(e1.to, e2.from) < EDGE_COINCIDE_EPS)
      || (dist(e1.from, e2.from) < EDGE_COINCIDE_EPS && dist(e1.to, e2.to) < EDGE_COINCIDE_EPS);
}

// ---- Manifest / asset loading ----
async function loadManifest() {
  setStatus("Loading manifest...");
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`Failed to load manifest: ${res.status}`);
  state.manifest = await res.json();
  for (const asset of state.manifest.assets) state.assets[asset.id] = asset;

  for (const bond of state.manifest.topology.bonds.natural || []) {
    const k = `${bond.from.face},${bond.from.edge}`;
    (state.bondsByEdge[k] ||= []).push({
      toFace: bond.to.face, toEdge: bond.to.edge, type: "natural",
    });
  }
  for (const bond of state.manifest.topology.bonds.mirror || []) {
    const k = `${bond.from.face},${bond.from.edge}`;
    (state.bondsByEdge[k] ||= []).push({
      toFace: bond.to.face, toEdge: bond.to.edge, type: "mirror",
    });
  }
  setStatus("");
}

async function loadTileSvgInner(assetId) {
  if (state.tileSvgInner[assetId]) return state.tileSvgInner[assetId];
  const res = await fetch(`${TILE_BASE}iso_${assetId}.svg`);
  if (!res.ok) throw new Error(`Failed to load tile ${assetId}`);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const inner = Array.from(doc.documentElement.children).map(n => n.cloneNode(true));
  state.tileSvgInner[assetId] = inner;
  return inner;
}

async function preloadAllTiles() {
  await Promise.all(Object.keys(state.assets).map(id =>
    loadTileSvgInner(id).catch(() => null)));
}

// ---- Tile geometry ----
function placedEdgeCanvas(placed, edgeName) {
  return assetEdgeCanvas(placed.assetId, placed.parity, placed.mat, edgeName);
}

function assetEdgeCanvas(assetId, parity, mat, edgeName) {
  const asset = state.assets[assetId];
  const e = asset.edges[edgeName];
  const localMat = localMatForParity(asset, parity);
  let from = e.image.from, to = e.image.to;
  if (localMat) {
    from = applyMat(localMat, from);
    to = applyMat(localMat, to);
  }
  return {
    from: applyMat(mat, from),
    to: applyMat(mat, to),
    edgeKey: e.edgeKey,
  };
}

function placedPolygonCanvas(placed) {
  return assetPolygonCanvas(placed.assetId, placed.parity, placed.mat);
}

function assetPolygonCanvas(assetId, parity, mat) {
  const asset = state.assets[assetId];
  const localMat = localMatForParity(asset, parity);
  return asset.polygon.map(v => {
    let p = v.point;
    if (localMat) p = applyMat(localMat, p);
    return applyMat(mat, p);
  });
}

// Bonds permitted between (anchorFace,anchorEdge,anchorParity) and (candFace,candEdge,candParity).
// Same parity → natural bonds; cross parity → mirror bonds (always intra-face/edge).
function bondAllowed(anchorFace, anchorEdge, anchorParity, candFace, candEdge, candParity) {
  const sameP = anchorParity === candParity;
  const list = state.bondsByEdge[`${anchorFace},${anchorEdge}`] || [];
  for (const b of list) {
    if (b.toFace !== candFace || b.toEdge !== candEdge) continue;
    if (sameP && b.type === "natural") return true;
    if (!sameP && b.type === "mirror") return true;
  }
  return false;
}

// Full legality check: does placing candidate at `mat` with `parity` overlap any tile
// or create an illegal coincident edge with any tile?
function placementLegality(candAssetId, candParity, mat, excludeUid) {
  const candAsset = state.assets[candAssetId];
  const candPoly = assetPolygonCanvas(candAssetId, candParity, mat);

  const candEdges = {};
  for (const en of ["top", "right", "bottom", "left"]) {
    candEdges[en] = assetEdgeCanvas(candAssetId, candParity, mat, en);
  }

  for (const placed of state.placed) {
    if (placed.uid === excludeUid) continue;
    const placedAsset = state.assets[placed.assetId];
    const placedPoly = placedPolygonCanvas(placed);

    if (polygonsOverlap(candPoly, placedPoly)) {
      return { ok: false, reason: "overlap", uid: placed.uid };
    }

    for (const cen of ["top", "right", "bottom", "left"]) {
      const ce = candEdges[cen];
      for (const pen of ["top", "right", "bottom", "left"]) {
        const pe = placedEdgeCanvas(placed, pen);
        if (!edgesCoincide(ce, pe)) continue;
        if (ce.edgeKey !== pe.edgeKey) {
          return { ok: false, reason: "edge-key-mismatch", uid: placed.uid };
        }
        if (!bondAllowed(placedAsset.face, pen, placed.parity,
                         candAsset.face, cen, candParity)) {
          return { ok: false, reason: "illegal-bond", uid: placed.uid };
        }
      }
    }
  }
  return { ok: true };
}

// ---- Snap search ----
// Try every (anchor edge, candidate edge) pair; among those that produce a legal
// placement, return the one whose anchor-edge midpoint is closest to canvasPt.
function findSnap(candAssetId, canvasPt, opts = {}) {
  const cand = state.assets[candAssetId];
  if (!cand) return null;
  const candParity = opts.parity || 1;

  let best = null;
  for (const placed of state.placed) {
    if (placed.uid === opts.excludeUid) continue;
    const placedAsset = state.assets[placed.assetId];
    const placedParity = placed.parity || 1;
    const sameP = placedParity === candParity;

    for (const edgeName of ["top", "right", "bottom", "left"]) {
      if (placed.occupiedEdges.has(edgeName)) continue;
      const ae = placedEdgeCanvas(placed, edgeName);
      const midA = [(ae.from[0] + ae.to[0]) / 2, (ae.from[1] + ae.to[1]) / 2];
      const d = dist(canvasPt, midA);

      const bondList = state.bondsByEdge[`${placedAsset.face},${edgeName}`] || [];
      for (const bond of bondList) {
        if (bond.toFace !== cand.face) continue;
        if (sameP && bond.type !== "natural") continue;
        if (!sameP && bond.type !== "mirror") continue;

        const ce = cand.edges[bond.toEdge];
        if (ce.edgeKey !== ae.edgeKey) continue;

        // Candidate edge endpoints in the candidate's local-reflected frame
        const candLocal = localMatForParity(cand, candParity);
        let C1 = ce.image.from, C2 = ce.image.to;
        if (candLocal) {
          C1 = applyMat(candLocal, C1);
          C2 = applyMat(candLocal, C2);
        }

        // Same parity: bond is "reversed" - candidate.from -> anchor.to, candidate.to -> anchor.from.
        // Cross parity (mirror bond, "same" orientation): candidate.from -> anchor.from, candidate.to -> anchor.to.
        const mat = sameP
          ? rigidTransform(C1, C2, ae.to, ae.from)
          : rigidTransform(C1, C2, ae.from, ae.to);

        const legality = placementLegality(candAssetId, candParity, mat, opts.excludeUid);
        if (!legality.ok) continue;

        if (!best || d < best.score) {
          best = {
            mat,
            anchorUid: placed.uid,
            anchorEdge: edgeName,
            candEdge: bond.toEdge,
            bondType: bond.type,
            score: d,
            parity: candParity,
          };
        }
      }
    }
  }
  return best;
}

// Identity placement (no anchor) — center mirrored polygon at canvas point.
function freePlacement(assetId, parity, canvasPt) {
  const asset = state.assets[assetId];
  const localMat = localMatForParity(asset, parity);
  const c = polygonCenter(asset.polygon);
  const cl = localMat ? applyMat(localMat, c) : c;
  return {
    a: 1, b: 0, c: 0, d: 1,
    tx: canvasPt[0] - cl[0],
    ty: canvasPt[1] - cl[1],
  };
}

// ---- Rendering ----
function renderTileGroup(assetId, mat, parity, opts = {}) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", matToString(mat));
  if (opts.className) g.setAttribute("class", opts.className);

  const inner = document.createElementNS(SVG_NS, "g");
  const asset = state.assets[assetId];
  const localMat = localMatForParity(asset, parity);
  if (localMat) inner.setAttribute("transform", matToString(localMat));

  const elements = state.tileSvgInner[assetId];
  if (elements) for (const el of elements) inner.appendChild(el.cloneNode(true));
  g.appendChild(inner);

  const outline = document.createElementNS(SVG_NS, "polygon");
  outline.setAttribute("class", "tile-outline");
  outline.setAttribute("points", asset.polygon.map(v => v.point.join(",")).join(" "));
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "transparent");
  outline.setAttribute("stroke-width", "4");
  inner.appendChild(outline);

  return g;
}

function renderAllPlaced() {
  while (placedG.firstChild) placedG.removeChild(placedG.firstChild);
  for (const p of state.placed) {
    const cls = "placed-tile"
      + (state.selectedUid === p.uid ? " selected" : "")
      + (p.parity === -1 ? " mirrored" : "");
    const g = renderTileGroup(p.assetId, p.mat, p.parity, { className: cls });
    g.dataset.uid = p.uid;
    g.addEventListener("mousedown", onPlacedMouseDown);
    placedG.appendChild(g);
  }
}

function clearGhost() { while (ghostG.firstChild) ghostG.removeChild(ghostG.firstChild); }
function clearOverlay() { while (overlayG.firstChild) overlayG.removeChild(overlayG.firstChild); }

function showGhost(assetId, mat, parity, valid) {
  clearGhost();
  const g = renderTileGroup(assetId, mat, parity, {
    className: "ghost" + (valid ? "" : " invalid"),
  });
  ghostG.appendChild(g);
}

function showAnchorEdge(snap) {
  clearOverlay();
  if (!snap) return;
  const placed = state.placed.find(p => p.uid === snap.anchorUid);
  if (!placed) return;
  const ae = placedEdgeCanvas(placed, snap.anchorEdge);
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "anchor-edge");
  line.setAttribute("x1", ae.from[0]);
  line.setAttribute("y1", ae.from[1]);
  line.setAttribute("x2", ae.to[0]);
  line.setAttribute("y2", ae.to[1]);
  overlayG.appendChild(line);
}

function updateMirrorIndicator() {
  if (!mirrorIndicator) return;
  mirrorIndicator.classList.toggle("active", state.mirrorMode);
}

// ---- Viewport ----
function updateViewport() {
  viewportG.setAttribute("transform",
    `translate(${state.view.tx},${state.view.ty}) scale(${state.view.scale})`);
}

function clientToCanvas(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return [(clientX - rect.left - state.view.tx) / state.view.scale,
          (clientY - rect.top - state.view.ty) / state.view.scale];
}

function fitView() {
  const rect = canvas.getBoundingClientRect();
  state.view.tx = rect.width / 2;
  state.view.ty = rect.height / 2;
  state.view.scale = 0.06;
  updateViewport();
}

// ---- Palette ----
function renderPalette() {
  while (palette.firstChild) palette.removeChild(palette.firstChild);
  const validIds = computeValidAssets();
  const ids = Object.keys(state.assets).sort((a, b) => {
    const va = validIds.has(a), vb = validIds.has(b);
    if (va !== vb) return vb - va;
    return a.localeCompare(b);
  });
  for (const id of ids) palette.appendChild(makeTileCard(id, validIds.has(id)));
}

function makeTileCard(assetId, valid) {
  const asset = state.assets[assetId];
  const card = document.createElement("div");
  card.className = "tile-card" + (valid ? " valid" : "");
  card.dataset.assetId = assetId;
  card.title = `${assetId} · face ${asset.face} · corner ${asset.corner}`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${asset.image.width} ${asset.image.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const bg = document.createElementNS(SVG_NS, "polygon");
  bg.setAttribute("points", asset.polygon.map(v => v.point.join(",")).join(" "));
  bg.setAttribute("fill", "#0a0a14");
  bg.setAttribute("stroke", valid ? "#4caf50" : "#444");
  bg.setAttribute("stroke-width", "30");
  svg.appendChild(bg);

  const elements = state.tileSvgInner[assetId];
  if (elements) for (const el of elements) svg.appendChild(el.cloneNode(true));
  card.appendChild(svg);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = `f${asset.face} c${asset.corner}`;
  card.appendChild(label);

  card.addEventListener("mousedown", (e) => onPaletteMouseDown(e, assetId));
  return card;
}

function computeValidAssets() {
  const valid = new Set();
  if (state.placed.length === 0) return valid;
  const targetFaces = new Set();
  const candParity = state.mirrorMode ? -1 : 1;
  for (const p of state.placed) {
    const a = state.assets[p.assetId];
    const sameP = (p.parity || 1) === candParity;
    for (const en of ["top", "right", "bottom", "left"]) {
      if (p.occupiedEdges.has(en)) continue;
      const bonds = state.bondsByEdge[`${a.face},${en}`] || [];
      for (const b of bonds) {
        if (sameP && b.type === "natural") targetFaces.add(b.toFace);
        else if (!sameP && b.type === "mirror") targetFaces.add(b.toFace);
      }
    }
  }
  for (const id in state.assets) {
    if (targetFaces.has(state.assets[id].face)) valid.add(id);
  }
  return valid;
}

// ---- Drag / drop ----
function onPaletteMouseDown(e, assetId) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.currentTarget.classList.add("dragging");
  beginDrag({
    assetId,
    sourceCard: e.currentTarget,
    fromBoard: false,
    excludeUid: null,
    parity: state.mirrorMode ? -1 : 1,
  }, e);
}

function onPlacedMouseDown(e) {
  if (e.button !== 0) return;
  const uid = parseInt(e.currentTarget.dataset.uid, 10);
  e.stopPropagation();
  e.preventDefault();
  const placed = state.placed.find(p => p.uid === uid);
  if (!placed) return;

  state.selectedUid = uid;
  renderAllPlaced();

  beginDrag({
    assetId: placed.assetId,
    sourceCard: null,
    fromBoard: true,
    excludeUid: uid,
    parity: placed.parity || 1,
  }, e);
}

function beginDrag(opts, e) {
  state.drag = {
    ...opts,
    startX: e.clientX,
    startY: e.clientY,
    lastClientX: e.clientX,
    lastClientY: e.clientY,
    moved: false,
    snap: null,
    canvasPt: clientToCanvas(e.clientX, e.clientY),
  };
  if (opts.fromBoard && opts.excludeUid != null) {
    const g = placedG.querySelector(`[data-uid="${opts.excludeUid}"]`);
    if (g) g.classList.add("dragging");
  }
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
}

function refreshDragGhost() {
  const drag = state.drag;
  if (!drag || !drag.moved) return;
  const cpt = drag.canvasPt;

  const otherTilesExist = state.placed.some(p => p.uid !== drag.excludeUid);
  let snap = null;
  if (otherTilesExist) {
    snap = findSnap(drag.assetId, cpt, {
      excludeUid: drag.excludeUid,
      parity: drag.parity,
    });
  }
  drag.snap = snap;

  let mat, valid;
  if (snap) {
    mat = snap.mat;
    valid = true;
  } else if (!otherTilesExist) {
    mat = freePlacement(drag.assetId, drag.parity, cpt);
    valid = true;
  } else {
    mat = freePlacement(drag.assetId, drag.parity, cpt);
    valid = false;
  }

  showGhost(drag.assetId, mat, drag.parity, valid);
  showAnchorEdge(snap);
}

function onDragMove(e) {
  const drag = state.drag;
  if (!drag) return;
  drag.lastClientX = e.clientX;
  drag.lastClientY = e.clientY;
  if (!drag.moved) {
    if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 4) return;
    drag.moved = true;
  }
  drag.canvasPt = clientToCanvas(e.clientX, e.clientY);
  refreshDragGhost();
}

function onDragEnd() {
  const drag = state.drag;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  state.drag = null;
  clearGhost();
  clearOverlay();

  if (drag.sourceCard) drag.sourceCard.classList.remove("dragging");
  if (drag.fromBoard && drag.excludeUid != null) {
    const g = placedG.querySelector(`[data-uid="${drag.excludeUid}"]`);
    if (g) g.classList.remove("dragging");
  }

  if (!drag.moved) return;

  const otherTilesExist = state.placed.some(p => p.uid !== drag.excludeUid);
  const snap = drag.snap;

  let mat;
  if (snap) {
    mat = snap.mat;
  } else if (!otherTilesExist) {
    mat = freePlacement(drag.assetId, drag.parity, drag.canvasPt);
  } else {
    return; // no valid placement
  }

  // Drop original first so legality check excludes it.
  if (drag.fromBoard && drag.excludeUid != null) {
    state.placed = state.placed.filter(p => p.uid !== drag.excludeUid);
    if (state.selectedUid === drag.excludeUid) state.selectedUid = null;
  }

  // Final legality re-check (in case board state changed during drag)
  const final = placementLegality(drag.assetId, drag.parity, mat, null);
  if (!final.ok) {
    recomputeOccupiedEdges();
    renderAllPlaced();
    renderPalette();
    return;
  }

  const uid = state.uidCounter++;
  state.placed.push({
    uid,
    assetId: drag.assetId,
    mat,
    parity: drag.parity,
    occupiedEdges: new Set(),
  });
  recomputeOccupiedEdges();
  state.selectedUid = uid;
  renderAllPlaced();
  renderPalette();
}

function recomputeOccupiedEdges() {
  for (const p of state.placed) p.occupiedEdges = new Set();
  for (let i = 0; i < state.placed.length; i++) {
    for (let j = i + 1; j < state.placed.length; j++) {
      for (const en1 of ["top", "right", "bottom", "left"]) {
        const e1 = placedEdgeCanvas(state.placed[i], en1);
        for (const en2 of ["top", "right", "bottom", "left"]) {
          const e2 = placedEdgeCanvas(state.placed[j], en2);
          if (edgesCoincide(e1, e2)) {
            state.placed[i].occupiedEdges.add(en1);
            state.placed[j].occupiedEdges.add(en2);
          }
        }
      }
    }
  }
}

function removePlaced(uid) {
  state.placed = state.placed.filter(p => p.uid !== uid);
  if (state.selectedUid === uid) state.selectedUid = null;
  recomputeOccupiedEdges();
  renderAllPlaced();
  renderPalette();
}

// ---- Stage interactions ----
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const cpt = clientToCanvas(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * 0.001);
  state.view.scale = Math.max(0.005, Math.min(0.5, state.view.scale * factor));
  const rect = canvas.getBoundingClientRect();
  state.view.tx = (e.clientX - rect.left) - cpt[0] * state.view.scale;
  state.view.ty = (e.clientY - rect.top) - cpt[1] * state.view.scale;
  updateViewport();
}, { passive: false });

stage.addEventListener("mousedown", (e) => {
  const isPanButton = e.button === 1 || e.button === 2 ||
                      (e.button === 0 && e.target === canvas && e.shiftKey);
  if (e.button === 0 && e.target === canvas && state.selectedUid != null && !e.shiftKey) {
    state.selectedUid = null;
    renderAllPlaced();
  }
  if (isPanButton) {
    e.preventDefault();
    stage.classList.add("panning");
    state.pan = { startX: e.clientX, startY: e.clientY, ox: state.view.tx, oy: state.view.ty };
    document.addEventListener("mousemove", onPanMove);
    document.addEventListener("mouseup", onPanEnd);
  }
});
stage.addEventListener("contextmenu", (e) => e.preventDefault());

function onPanMove(e) {
  const p = state.pan; if (!p) return;
  state.view.tx = p.ox + (e.clientX - p.startX);
  state.view.ty = p.oy + (e.clientY - p.startY);
  updateViewport();
}
function onPanEnd() {
  state.pan = null;
  stage.classList.remove("panning");
  document.removeEventListener("mousemove", onPanMove);
  document.removeEventListener("mouseup", onPanEnd);
}

// ---- Keyboard ----
document.addEventListener("keydown", (e) => {
  // Skip when typing in an input
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if ((e.key === "Backspace" || e.key === "Delete") && state.selectedUid != null) {
    e.preventDefault();
    removePlaced(state.selectedUid);
  } else if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    state.mirrorMode = !state.mirrorMode;
    updateMirrorIndicator();
    if (state.drag) {
      state.drag.parity = state.mirrorMode ? -1 : 1;
      refreshDragGhost();
    } else {
      renderPalette();
    }
  } else if (e.key === "Escape") {
    if (state.drag) {
      const drag = state.drag;
      document.removeEventListener("mousemove", onDragMove);
      document.removeEventListener("mouseup", onDragEnd);
      state.drag = null;
      clearGhost(); clearOverlay();
      if (drag.sourceCard) drag.sourceCard.classList.remove("dragging");
      if (drag.fromBoard && drag.excludeUid != null) {
        const g = placedG.querySelector(`[data-uid="${drag.excludeUid}"]`);
        if (g) g.classList.remove("dragging");
      }
    }
  }
});

// ---- Status ----
function setStatus(msg) {
  if (!msg) statusEl.style.display = "none";
  else { statusEl.style.display = "block"; statusEl.innerHTML = msg; }
}

// ---- Toolbar actions ----
document.getElementById("btn-new").addEventListener("click", () => {
  if (state.placed.length > 0 && !confirm("Clear the board?")) return;
  state.placed = [];
  state.selectedUid = null;
  renderAllPlaced();
  renderPalette();
});

document.getElementById("btn-export").addEventListener("click", exportSvg);

document.getElementById("btn-save").addEventListener("click", () => {
  document.getElementById("modal-save").classList.add("active");
  document.getElementById("save-name").value =
    new Date().toISOString().slice(0, 16).replace("T", " ");
  document.getElementById("save-name").focus();
});

document.getElementById("btn-load").addEventListener("click", () => {
  populateSavedSets();
  document.getElementById("modal-load").classList.add("active");
});

window.closeModal = (id) => document.getElementById(id).classList.remove("active");

window.confirmSaveSet = () => {
  const name = document.getElementById("save-name").value.trim();
  if (!name) return;
  const sets = loadSets();
  sets[name] = serializeBoard();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(sets));
  closeModal("modal-save");
};

document.getElementById("btn-import-file").addEventListener("click", () =>
  document.getElementById("file-input").click()
);
document.getElementById("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    deserializeBoard(JSON.parse(await file.text()));
    closeModal("modal-load");
  } catch (err) {
    alert("Failed to load: " + err.message);
  }
});

function loadSets() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

function populateSavedSets() {
  const sets = loadSets();
  const list = document.getElementById("saved-sets-list");
  list.innerHTML = "";
  const names = Object.keys(sets);
  if (names.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:#666;font-size:11px;text-align:center;padding:12px;";
    empty.textContent = "(no saved sets)";
    list.appendChild(empty);
    return;
  }
  for (const name of names.sort()) {
    const data = sets[name];
    const row = document.createElement("div");
    row.className = "saved-set";

    const label = document.createElement("div");
    label.className = "name";
    label.textContent = `${name} (${data.tiles?.length || 0} tiles)`;
    row.appendChild(label);

    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Load";
    loadBtn.onclick = () => { deserializeBoard(data); closeModal("modal-load"); };
    row.appendChild(loadBtn);

    const dlBtn = document.createElement("button");
    dlBtn.textContent = "Download";
    dlBtn.onclick = () => downloadJson(`${name}.json`, data);
    row.appendChild(dlBtn);

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.onclick = () => {
      if (!confirm(`Delete "${name}"?`)) return;
      const all = loadSets();
      delete all[name];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      populateSavedSets();
    };
    row.appendChild(delBtn);

    list.appendChild(row);
  }
}

function serializeBoard() {
  return {
    version: 2,
    tiles: state.placed.map(p => ({
      assetId: p.assetId,
      mat: p.mat,
      parity: p.parity,
    })),
  };
}

function deserializeBoard(data) {
  if (!data || !Array.isArray(data.tiles)) throw new Error("Invalid set");
  state.placed = data.tiles.map(t => ({
    uid: state.uidCounter++,
    assetId: t.assetId,
    mat: t.mat,
    // v1 sets may have localMat instead of parity; reconstruct.
    parity: t.parity != null
      ? t.parity
      : (t.localMat && t.localMat.a === -1 ? -1 : 1),
    occupiedEdges: new Set(),
  }));
  recomputeOccupiedEdges();
  state.selectedUid = null;
  renderAllPlaced();
  renderPalette();
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Export SVG ----
function exportSvg() {
  if (state.placed.length === 0) {
    alert("No tiles placed.");
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of state.placed) {
    for (const pt of placedPolygonCanvas(p)) {
      if (pt[0] < minX) minX = pt[0]; if (pt[1] < minY) minY = pt[1];
      if (pt[0] > maxX) maxX = pt[0]; if (pt[1] > maxY) maxY = pt[1];
    }
  }
  const pad = 50;
  const w = maxX - minX + 2 * pad;
  const h = maxY - minY + 2 * pad;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);

  for (const p of state.placed) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("data-asset", p.assetId);
    if (p.parity === -1) g.setAttribute("data-mirror", "1");
    g.setAttribute("transform", matToString(p.mat));

    const inner = document.createElementNS(SVG_NS, "g");
    const asset = state.assets[p.assetId];
    const localMat = localMatForParity(asset, p.parity);
    if (localMat) inner.setAttribute("transform", matToString(localMat));

    const elements = state.tileSvgInner[p.assetId];
    if (elements) for (const el of elements) inner.appendChild(el.cloneNode(true));
    g.appendChild(inner);
    svg.appendChild(g);
  }

  const text = new XMLSerializer().serializeToString(svg);
  const blob = new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n', text],
                       { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ornament_${Date.now()}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Boot ----
async function boot() {
  try {
    await loadManifest();
    setStatus("Loading tiles...");
    await preloadAllTiles();
    setStatus(`<span class="key">Space</span> mirror · <span class="key">Esc</span> cancel · <span class="key">Del</span> remove · scroll zoom · shift+drag pan`);
    setTimeout(() => setStatus(""), 6000);
    fitView();
    renderPalette();
    updateMirrorIndicator();
  } catch (err) {
    console.error(err);
    setStatus(`<span style="color:#f55">Error: ${err.message}</span><br>` +
      `Run from a static server with <code>export/vector_tiles/</code> available.`);
  }
}

boot();
