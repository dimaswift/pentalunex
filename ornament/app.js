// Ornament Builder - rhombic tile composition tool
// Loads vector tiles from ../export/vector_tiles/ and uses manifest.json
// adjacency rules ("bonds") to snap tiles together by shared 3D edges.

const SVG_NS = "http://www.w3.org/2000/svg";
const MANIFEST_URL = "./export/vector_tiles/manifest.json";
const TILE_BASE = "./export/vector_tiles/";
const STORAGE_KEY = "ornament_builder_sets_v1";
// Always snap to closest valid bond — no distance cap.

// ---- State ----
const state = {
  manifest: null,
  assets: {},                  // id -> asset
  bondsByEdge: {},             // "face,edge" -> [{toFace, toEdge, type}]
  tileSvgInner: {},            // assetId -> array of cloned <Element> (raw paths/groups)
  placed: [],                  // placed tiles
  uidCounter: 1,
  selectedUid: null,
  drag: null,                  // active drag state
  view: { tx: 0, ty: 0, scale: 0.05 }, // canvas pan/zoom
  pan: null,                   // pan state
};

// ---- DOM ----
const stage = document.getElementById("stage");
const canvas = document.getElementById("canvas");
const palette = document.getElementById("palette");
const statusEl = document.getElementById("status");

// Layer groups inside the canvas SVG
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
function identityMat() { return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }; }

// Compose: result = A * B (apply B first, then A)
function multMat(A, B) {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    tx: A.a * B.tx + A.c * B.ty + A.tx,
    ty: A.b * B.tx + A.d * B.ty + A.ty,
  };
}

// Build orientation-preserving rigid map (rotation + translation) sending P1->Q1 and P2->Q2.
// Requires |P2-P1| == |Q2-Q1|.
function rigidTransform(P1, P2, Q1, Q2) {
  const angP = Math.atan2(P2[1] - P1[1], P2[0] - P1[0]);
  const angQ = Math.atan2(Q2[1] - Q1[1], Q2[0] - Q1[0]);
  const t = angQ - angP;
  const ct = Math.cos(t), st = Math.sin(t);
  const a = ct, b = st, c = -st, d = ct;
  const tx = Q1[0] - (a * P1[0] + c * P1[1]);
  const ty = Q1[1] - (b * P1[0] + d * P1[1]);
  return { a, b, c, d, tx, ty };
}

// Build orientation-reversing isometry (reflection) sending P1->Q1 and P2->Q2.
function reflectTransform(P1, P2, Q1, Q2) {
  // L = R(t) * F  where F flips y: maps (x,y) -> (x,-y)
  // L([cos p, sin p]) = (cos(t-p) ... ) wait — derive directly.
  // We want orientation-reversing isometry mapping unit u=(P2-P1)/|.| to v=(Q2-Q1)/|.|.
  // L = [[cos t, sin t],[sin t, -cos t]] with t = atan2(v) + atan2(u).
  const angP = Math.atan2(P2[1] - P1[1], P2[0] - P1[0]);
  const angQ = Math.atan2(Q2[1] - Q1[1], Q2[0] - Q1[0]);
  const t = angQ + angP;
  const ct = Math.cos(t), st = Math.sin(t);
  const a = ct, c = st, b = st, d = -ct;
  const tx = Q1[0] - (a * P1[0] + c * P1[1]);
  const ty = Q1[1] - (b * P1[0] + d * P1[1]);
  return { a, b, c, d, tx, ty };
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
      toFace: bond.to.face, toEdge: bond.to.edge,
      type: "natural", orientation: bond.orientation,
    });
  }
  for (const bond of state.manifest.topology.bonds.mirror || []) {
    const k = `${bond.from.face},${bond.from.edge}`;
    (state.bondsByEdge[k] ||= []).push({
      toFace: bond.to.face, toEdge: bond.to.edge,
      type: "mirror", orientation: bond.orientation,
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
  const svgEl = doc.documentElement;
  const inner = Array.from(svgEl.children).map(n => n.cloneNode(true));
  state.tileSvgInner[assetId] = inner;
  return inner;
}

async function preloadAllTiles() {
  const ids = Object.keys(state.assets);
  await Promise.all(ids.map(id => loadTileSvgInner(id).catch(() => null)));
}

// ---- Tile geometry helpers ----
function tilePolygonImage(asset) {
  return asset.polygon.map(v => v.point);
}

// Edges of a placed tile in canvas coords (image points * placement transform).
function placedEdgeCanvas(placed, edgeName) {
  const asset = state.assets[placed.assetId];
  const e = asset.edges[edgeName];
  let from = e.image.from, to = e.image.to;
  // Apply tile's local pre-transform (e.g., mirror) before placement transform.
  if (placed.localMat) {
    from = applyMat(placed.localMat, from);
    to = applyMat(placed.localMat, to);
  }
  return {
    from: applyMat(placed.mat, from),
    to: applyMat(placed.mat, to),
    edgeKey: e.edgeKey,
  };
}

function placedPolygonCanvas(placed) {
  const asset = state.assets[placed.assetId];
  return asset.polygon.map(v => {
    let p = v.point;
    if (placed.localMat) p = applyMat(placed.localMat, p);
    return applyMat(placed.mat, p);
  });
}

// ---- Snap / placement search ----
// Find the best snap target for a candidate asset given a target canvas point.
// Returns { mat, localMat, anchorEdge, candEdge, score } or null.
function findSnap(candidateAssetId, canvasPt, opts = {}) {
  const cand = state.assets[candidateAssetId];
  if (!cand) return null;
  const allowMirror = !!opts.preferMirror;

  let best = null;
  for (const placed of state.placed) {
    if (placed.uid === opts.excludeUid) continue;
    const placedAsset = state.assets[placed.assetId];
    for (const edgeName of ["top", "right", "bottom", "left"]) {
      if (placed.occupiedEdges.has(edgeName)) continue;

      const ae = placedEdgeCanvas(placed, edgeName);
      const midA = [(ae.from[0] + ae.to[0]) / 2, (ae.from[1] + ae.to[1]) / 2];
      const d = dist(canvasPt, midA);

      const bondList = state.bondsByEdge[`${placedAsset.face},${edgeName}`] || [];
      for (const bond of bondList) {
        if (bond.toFace !== cand.face) continue;
        if (bond.type === "mirror" && !allowMirror) continue;
        // Candidate edge in image space (no local transform yet)
        const ce = cand.edges[bond.toEdge];

        // Verify edges have matching world keys
        if (ce.edgeKey !== ae.edgeKey) continue;

        // Build placement transform.
        let mat, localMat = null;
        const C1 = ce.image.from, C2 = ce.image.to;
        if (bond.type === "natural") {
          // Reverse orientation: candidate.from -> anchor.to, candidate.to -> anchor.from
          mat = rigidTransform(C1, C2, ae.to, ae.from);
        } else {
          // Mirror bond: same orientation, reflective placement
          // candidate.from -> anchor.from, candidate.to -> anchor.to (with reflection)
          mat = reflectTransform(C1, C2, ae.from, ae.to);
        }

        // Score: prefer closer to mouse; prefer natural over mirror
        const score = d + (bond.type === "mirror" ? 50 : 0);
        if (!best || score < best.score) {
          best = {
            mat,
            localMat,
            anchorUid: placed.uid,
            anchorEdge: edgeName,
            candEdge: bond.toEdge,
            bondType: bond.type,
            score,
          };
        }
      }
    }
  }

  // Reject if candidate would visibly overlap existing tile (cheap test: polygon center distance)
  if (best) {
    const cP = polygonCenter(cand.polygon);
    const cCanvas = applyMat(best.mat, cP);
    for (const placed of state.placed) {
      if (placed.uid === opts.excludeUid) continue;
      const pAsset = state.assets[placed.assetId];
      const pP = polygonCenter(pAsset.polygon);
      const pCanvas = applyMat(placed.mat, pP);
      const halfDiag = 1857.983 * 0.7; // safety
      if (dist(cCanvas, pCanvas) < halfDiag * 0.6) {
        // Treat as overlap: reject
        return null;
      }
    }
  }

  return best;
}

// Identity placement (no anchor) — center polygon at canvas point.
function freePlacement(assetId, canvasPt) {
  const asset = state.assets[assetId];
  const c = polygonCenter(asset.polygon);
  return {
    a: 1, b: 0, c: 0, d: 1,
    tx: canvasPt[0] - c[0],
    ty: canvasPt[1] - c[1],
  };
}

// ---- Rendering ----
function renderTileGroup(assetId, mat, localMat, opts = {}) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", matToString(mat));
  if (opts.className) g.setAttribute("class", opts.className);

  // Inner group with optional local transform (mirror)
  const inner = document.createElementNS(SVG_NS, "g");
  if (localMat) inner.setAttribute("transform", matToString(localMat));

  const elements = state.tileSvgInner[assetId];
  if (elements) {
    for (const el of elements) inner.appendChild(el.cloneNode(true));
  }
  g.appendChild(inner);

  // Outline of the rhomb polygon (for selection / ghost edges)
  const asset = state.assets[assetId];
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
    const g = renderTileGroup(p.assetId, p.mat, p.localMat, {
      className: "placed-tile" + (state.selectedUid === p.uid ? " selected" : ""),
    });
    g.dataset.uid = p.uid;
    g.addEventListener("mousedown", onPlacedMouseDown);
    placedG.appendChild(g);
  }
}

function clearGhost() {
  while (ghostG.firstChild) ghostG.removeChild(ghostG.firstChild);
}
function clearOverlay() {
  while (overlayG.firstChild) overlayG.removeChild(overlayG.firstChild);
}

function showGhost(assetId, mat, localMat, valid) {
  clearGhost();
  const g = renderTileGroup(assetId, mat, localMat, {
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

// ---- Viewport (pan/zoom) ----
function updateViewport() {
  viewportG.setAttribute("transform",
    `translate(${state.view.tx},${state.view.ty}) scale(${state.view.scale})`);
}

function clientToCanvas(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  return [(x - state.view.tx) / state.view.scale, (y - state.view.ty) / state.view.scale];
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
  const ids = Object.keys(state.assets);
  ids.sort((a, b) => {
    const va = validIds.has(a), vb = validIds.has(b);
    if (va !== vb) return vb - va;
    return a.localeCompare(b);
  });

  for (const id of ids) {
    const card = makeTileCard(id, validIds.has(id));
    palette.appendChild(card);
  }
}

function makeTileCard(assetId, valid) {
  const asset = state.assets[assetId];
  const card = document.createElement("div");
  card.className = "tile-card" + (valid ? " valid" : "");
  card.dataset.assetId = assetId;
  card.title = `${assetId} · face ${asset.face} · corner ${asset.corner}`;

  // Thumbnail SVG
  const svg = document.createElementNS(SVG_NS, "svg");
  const w = asset.image.width, h = asset.image.height;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // Background polygon
  const bg = document.createElementNS(SVG_NS, "polygon");
  bg.setAttribute("points", asset.polygon.map(v => v.point.join(",")).join(" "));
  bg.setAttribute("fill", "#0a0a14");
  bg.setAttribute("stroke", valid ? "#4caf50" : "#444");
  bg.setAttribute("stroke-width", "30");
  svg.appendChild(bg);

  const elements = state.tileSvgInner[assetId];
  if (elements) {
    for (const el of elements) svg.appendChild(el.cloneNode(true));
  }
  card.appendChild(svg);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = `f${asset.face} c${asset.corner}`;
  card.appendChild(label);

  card.addEventListener("mousedown", (e) => onPaletteMouseDown(e, assetId));
  return card;
}

// Compute set of asset IDs that have a valid bond against the current board.
function computeValidAssets() {
  const valid = new Set();
  if (state.placed.length === 0) {
    // any tile is "valid" as a free placement; but we don't highlight any
    return valid;
  }
  // Collect free edge faces
  const freeEdges = []; // [{face, edge}]
  for (const p of state.placed) {
    const a = state.assets[p.assetId];
    for (const en of ["top", "right", "bottom", "left"]) {
      if (!p.occupiedEdges.has(en)) freeEdges.push({ face: a.face, edge: en });
    }
  }
  // Collect target faces
  const targetFaces = new Set();
  for (const fe of freeEdges) {
    const bonds = state.bondsByEdge[`${fe.face},${fe.edge}`] || [];
    for (const b of bonds) targetFaces.add(b.toFace);
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
    mirrored: false,
  }, e);
}

function onPlacedMouseDown(e) {
  if (e.button !== 0) return;
  // If user clicked-not-dragged, we just select — handled by movement threshold below.
  const uid = parseInt(e.currentTarget.dataset.uid, 10);
  e.stopPropagation();
  e.preventDefault();

  const placed = state.placed.find(p => p.uid === uid);
  if (!placed) return;

  // Mark as selected immediately
  state.selectedUid = uid;
  renderAllPlaced();

  beginDrag({
    assetId: placed.assetId,
    sourceCard: null,
    fromBoard: true,
    excludeUid: uid,
    mirrored: !!placed.localMat,
    originalPlaced: { ...placed, occupiedEdges: new Set(placed.occupiedEdges) },
  }, e);
}

function beginDrag(opts, e) {
  state.drag = {
    ...opts,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    snap: null,
    canvasPt: clientToCanvas(e.clientX, e.clientY),
  };

  // Hide the original placed tile while dragging
  if (opts.fromBoard && opts.excludeUid != null) {
    const g = placedG.querySelector(`[data-uid="${opts.excludeUid}"]`);
    if (g) g.classList.add("dragging");
  }

  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
}

function onDragMove(e) {
  const drag = state.drag;
  if (!drag) return;
  if (!drag.moved) {
    if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 4) return;
    drag.moved = true;
  }
  const cpt = clientToCanvas(e.clientX, e.clientY);
  drag.canvasPt = cpt;

  // Find snap
  let snap = null;
  if (state.placed.length > 0 && !(drag.fromBoard && state.placed.length === 1 && drag.excludeUid === state.placed[0].uid)) {
    snap = findSnap(drag.assetId, cpt, {
      excludeUid: drag.excludeUid,
      preferMirror: drag.mirrored,
    });
  }
  drag.snap = snap;

  let mat, localMat = null, valid;
  if (snap) {
    mat = snap.mat;
    valid = true;
  } else if (state.placed.length === 0 || (drag.fromBoard && state.placed.filter(p => p.uid !== drag.excludeUid).length === 0)) {
    mat = freePlacement(drag.assetId, cpt);
    valid = true;
  } else {
    mat = freePlacement(drag.assetId, cpt);
    valid = false;
  }

  showGhost(drag.assetId, mat, localMat, valid);
  showAnchorEdge(snap);
}

function onDragEnd(e) {
  const drag = state.drag;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  state.drag = null;
  clearGhost();
  clearOverlay();

  if (drag.sourceCard) drag.sourceCard.classList.remove("dragging");

  if (!drag.moved) {
    // Click without drag
    if (drag.fromBoard) {
      // Re-show original
      const g = placedG.querySelector(`[data-uid="${drag.excludeUid}"]`);
      if (g) g.classList.remove("dragging");
    }
    return;
  }

  const cpt = drag.canvasPt;
  const snap = drag.snap;

  let mat, localMat = null, anchorBond = null;
  if (snap) {
    mat = snap.mat;
    anchorBond = snap;
  } else if (state.placed.length === 0 ||
             (drag.fromBoard && state.placed.filter(p => p.uid !== drag.excludeUid).length === 0)) {
    mat = freePlacement(drag.assetId, cpt);
  } else {
    // No valid placement: cancel
    if (drag.fromBoard) {
      const g = placedG.querySelector(`[data-uid="${drag.excludeUid}"]`);
      if (g) g.classList.remove("dragging");
    }
    return;
  }

  // Remove from-board original first
  if (drag.fromBoard && drag.excludeUid != null) {
    removePlaced(drag.excludeUid, /*rerender*/ false);
  }

  // Add new placement
  const uid = state.uidCounter++;
  const newPlaced = {
    uid,
    assetId: drag.assetId,
    mat,
    localMat,
    occupiedEdges: new Set(),
  };
  if (anchorBond) {
    newPlaced.occupiedEdges.add(anchorBond.candEdge);
    const anchor = state.placed.find(p => p.uid === anchorBond.anchorUid);
    if (anchor) anchor.occupiedEdges.add(anchorBond.anchorEdge);
  }
  state.placed.push(newPlaced);

  // Recompute occupied edges for ALL tiles based on coincident edge midpoints
  recomputeOccupiedEdges();

  state.selectedUid = uid;
  renderAllPlaced();
  renderPalette();
}

// Recompute occupied edges based on geometric coincidence
function recomputeOccupiedEdges() {
  for (const p of state.placed) p.occupiedEdges = new Set();
  for (let i = 0; i < state.placed.length; i++) {
    for (let j = i + 1; j < state.placed.length; j++) {
      for (const en1 of ["top", "right", "bottom", "left"]) {
        const e1 = placedEdgeCanvas(state.placed[i], en1);
        for (const en2 of ["top", "right", "bottom", "left"]) {
          const e2 = placedEdgeCanvas(state.placed[j], en2);
          // Edges coincide if midpoints match and either
          // (from1=to2,to1=from2) or (from1=from2,to1=to2)
          const m1 = [(e1.from[0] + e1.to[0]) / 2, (e1.from[1] + e1.to[1]) / 2];
          const m2 = [(e2.from[0] + e2.to[0]) / 2, (e2.from[1] + e2.to[1]) / 2];
          if (dist(m1, m2) < 50) {
            // close enough
            const matchA = dist(e1.from, e2.to) < 50 && dist(e1.to, e2.from) < 50;
            const matchB = dist(e1.from, e2.from) < 50 && dist(e1.to, e2.to) < 50;
            if (matchA || matchB) {
              state.placed[i].occupiedEdges.add(en1);
              state.placed[j].occupiedEdges.add(en2);
            }
          }
        }
      }
    }
  }
}

function removePlaced(uid, rerender = true) {
  state.placed = state.placed.filter(p => p.uid !== uid);
  if (state.selectedUid === uid) state.selectedUid = null;
  recomputeOccupiedEdges();
  if (rerender) {
    renderAllPlaced();
    renderPalette();
  }
}

// ---- Stage interactions: pan, zoom, deselect ----
stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const cpt = clientToCanvas(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * 0.001);
  state.view.scale *= factor;
  state.view.scale = Math.max(0.005, Math.min(0.5, state.view.scale));
  // keep cpt under cursor
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top;
  state.view.tx = x - cpt[0] * state.view.scale;
  state.view.ty = y - cpt[1] * state.view.scale;
  updateViewport();
}, { passive: false });

stage.addEventListener("mousedown", (e) => {
  if (e.button === 1 || e.button === 2 ||
      (e.button === 0 && e.target === canvas)) {
    if (e.button === 0 && e.target === canvas) {
      // Click on empty canvas: deselect
      if (state.selectedUid != null) {
        state.selectedUid = null;
        renderAllPlaced();
      }
    }
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.target === canvas && e.shiftKey)) {
      e.preventDefault();
      stage.classList.add("panning");
      state.pan = { startX: e.clientX, startY: e.clientY, ox: state.view.tx, oy: state.view.ty };
      document.addEventListener("mousemove", onPanMove);
      document.addEventListener("mouseup", onPanEnd);
    }
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
  if ((e.key === "Backspace" || e.key === "Delete") && state.selectedUid != null) {
    e.preventDefault();
    removePlaced(state.selectedUid);
  } else if (e.key === "m" || e.key === "M") {
    // Toggle mirror on currently dragged tile? We expose preferMirror.
    if (state.drag) {
      state.drag.mirrored = !state.drag.mirrored;
      // Re-trigger snap evaluation
      const evt = new MouseEvent("mousemove", {
        clientX: state.drag.lastClientX || 0,
        clientY: state.drag.lastClientY || 0,
      });
      // Let the next real mousemove update; nothing to do otherwise.
    }
  } else if (e.key === "Escape") {
    if (state.drag) {
      // cancel: simulate end without applying
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
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    deserializeBoard(data);
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
    empty.style.color = "#666"; empty.style.fontSize = "11px";
    empty.style.textAlign = "center"; empty.style.padding = "12px";
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
    version: 1,
    tiles: state.placed.map(p => ({
      assetId: p.assetId,
      mat: p.mat,
      localMat: p.localMat || null,
    })),
  };
}

function deserializeBoard(data) {
  if (!data || !Array.isArray(data.tiles)) throw new Error("Invalid set");
  state.placed = data.tiles.map(t => ({
    uid: state.uidCounter++,
    assetId: t.assetId,
    mat: t.mat,
    localMat: t.localMat || null,
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

  // Compute bounding box of all placed tile polygons in canvas coords
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of state.placed) {
    const poly = placedPolygonCanvas(p);
    for (const pt of poly) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] > maxY) maxY = pt[1];
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
    g.setAttribute("transform", matToString(p.mat));

    const inner = document.createElementNS(SVG_NS, "g");
    if (p.localMat) inner.setAttribute("transform", matToString(p.localMat));

    const elements = state.tileSvgInner[p.assetId];
    if (elements) {
      for (const el of elements) inner.appendChild(el.cloneNode(true));
    }
    g.appendChild(inner);
    svg.appendChild(g);
  }

  const text = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([
    '<?xml version="1.0" encoding="UTF-8"?>\n', text,
  ], { type: "image/svg+xml" });
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
    setStatus(`Drag a tile from below to start. <span class="key">Esc</span> cancel · <span class="key">Del</span> remove · scroll zoom · shift+drag pan`);
    setTimeout(() => setStatus(""), 6000);
    fitView();
    renderPalette();

    window.addEventListener("resize", () => {
      // Keep view roughly centered after resize: no-op (translate stays absolute)
    });
  } catch (err) {
    console.error(err);
    setStatus(`<span style="color:#f55">Error: ${err.message}</span><br>` +
      `Run from a static server with <code>export/vector_tiles/</code> available.`);
  }
}

boot();
