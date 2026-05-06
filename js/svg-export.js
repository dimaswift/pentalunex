// SVG export of graticule + eclipse overlays for selected faces.
// Uses manual 2D Cohen-Sutherland clipping (LightBurn ignores SVG clipPath).
import { toFaceXYZ, orientedLonLatTo3D, clipSegment, clipRing, projXY } from './projection.js';
import { generateGraticuleCellRing } from './graticule-cells.js';
import { isPartialType } from './eclipse-overlay.js';

// ── 2D Cohen-Sutherland line clipping ────────────────────────────────────────

function outCode(x, y, x0, y0, x1, y1) {
  return (x < x0 ? 1 : 0) | (x > x1 ? 2 : 0) | (y < y0 ? 4 : 0) | (y > y1 ? 8 : 0);
}

function clip2D(ax, ay, bx, by, x0, y0, x1, y1) {
  let ca = outCode(ax, ay, x0, y0, x1, y1);
  let cb = outCode(bx, by, x0, y0, x1, y1);
  while (true) {
    if (!(ca | cb)) return [ax, ay, bx, by]; // both inside
    if (ca & cb)    return null;              // both outside same edge
    const co = ca || cb;
    let x, y;
    if      (co & 8) { x = ax + (bx-ax)*(y1-ay)/(by-ay); y = y1; }
    else if (co & 4) { x = ax + (bx-ax)*(y0-ay)/(by-ay); y = y0; }
    else if (co & 2) { y = ay + (by-ay)*(x1-ax)/(bx-ax); x = x1; }
    else             { y = ay + (by-ay)*(x0-ax)/(bx-ax); x = x0; }
    if (co === ca) { ax = x; ay = y; ca = outCode(ax, ay, x0, y0, x1, y1); }
    else           { bx = x; by = y; cb = outCode(bx, by, x0, y0, x1, y1); }
  }
}

// ── Path builders ─────────────────────────────────────────────────────────────

function polylinePath(face, coords, N) {
  if (coords.length < 2) return '';
  const d = [];
  let prev3 = toFaceXYZ(face, orientedLonLatTo3D(coords[0][0], coords[0][1]));
  let lastEnd = null;
  for (let i = 1; i < coords.length; i++) {
    const cur3 = toFaceXYZ(face, orientedLonLatTo3D(coords[i][0], coords[i][1]));
    const seg = clipSegment(prev3, cur3);
    if (seg) {
      const a = projXY(seg[0], N), b = projXY(seg[1], N);
      const c = clip2D(a.px, a.py, b.px, b.py, 0, 0, N, N);
      if (c) {
        const [ax, ay, bx, by] = c;
        if (!lastEnd || Math.abs(lastEnd[0]-ax) > 0.1 || Math.abs(lastEnd[1]-ay) > 0.1)
          d.push(`M${ax.toFixed(1)},${ay.toFixed(1)}`);
        d.push(`L${bx.toFixed(1)},${by.toFixed(1)}`);
        lastEnd = [bx, by];
      } else { lastEnd = null; }
    } else { lastEnd = null; }
    prev3 = cur3;
  }
  return d.join('');
}

function polygonPath(face, rings, N) {
  const d = [];
  for (const ring of rings) {
    const ring3 = ring.map(pt => toFaceXYZ(face, orientedLonLatTo3D(pt[0], pt[1])));
    const clipped = clipRing(ring3);
    if (clipped.length < 3) continue;
    const pts = clipped.map(p => projXY(p, N));
    d.push(`M${pts[0].px.toFixed(1)},${pts[0].py.toFixed(1)}`);
    for (let i = 1; i < pts.length; i++)
      d.push(`L${pts[i].px.toFixed(1)},${pts[i].py.toFixed(1)}`);
    d.push('Z');
  }
  return d.join('');
}

// ── Sutherland-Hodgman polygon clip to axis-aligned rect ─────────────────────

function clipPolyToRect(pts, x0, y0, x1, y1) {
  const clip = [
    [p => p.px >= x0, (a, b) => { const t = (x0-a.px)/(b.px-a.px); return {px:x0, py:a.py+t*(b.py-a.py)}; }],
    [p => p.px <= x1, (a, b) => { const t = (x1-a.px)/(b.px-a.px); return {px:x1, py:a.py+t*(b.py-a.py)}; }],
    [p => p.py >= y0, (a, b) => { const t = (y0-a.py)/(b.py-a.py); return {px:a.px+t*(b.px-a.px), py:y0}; }],
    [p => p.py <= y1, (a, b) => { const t = (y1-a.py)/(b.py-a.py); return {px:a.px+t*(b.px-a.px), py:y1}; }],
  ];
  let out = pts;
  for (const [inside, intersect] of clip) {
    if (!out.length) return [];
    const inp = out; out = [];
    let prev = inp[inp.length - 1], prevIn = inside(prev);
    for (const curr of inp) {
      const currIn = inside(curr);
      if (currIn) { if (!prevIn) out.push(intersect(prev, curr)); out.push(curr); }
      else if (prevIn) out.push(intersect(prev, curr));
      prev = curr; prevIn = currIn;
    }
  }
  return out;
}

// ── Hatch scanline fill ───────────────────────────────────────────────────────

function hatchPolygon(pts, interval) {
  if (pts.length < 3) return [];
  const minY = Math.min(...pts.map(p => p.py));
  const maxY = Math.max(...pts.map(p => p.py));
  const segs = [];
  const n = pts.length;
  for (let y = Math.ceil(minY / interval) * interval; y <= maxY; y += interval) {
    const xs = [];
    for (let i = 0; i < n; i++) {
      const p1 = pts[i], p2 = pts[(i+1) % n];
      // half-open interval: count edge only when crossing strictly upward or downward
      if ((p1.py <= y && p2.py > y) || (p2.py <= y && p1.py > y))
        xs.push(p1.px + (y - p1.py) / (p2.py - p1.py) * (p2.px - p1.px));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2)
      segs.push([xs[i], y, xs[i+1], y]);
  }
  return segs;
}

// ── Group builders ────────────────────────────────────────────────────────────

function graticuleGroup(face, N, opts) {
  const { step, color, width, alpha } = opts;
  const lines = [];

  for (let lat = -90 + step; lat < 90; lat += step) {
    const ring = [];
    for (let lon = -180; lon <= 180; lon += 0.5) ring.push([lon, lat]);
    const d = polylinePath(face, ring, N);
    if (d) lines.push(`<path d="${d}"/>`);
  }
  for (let lon = -180; lon < 180; lon += step) {
    const ring = [];
    for (let lat = -90; lat <= 90; lat += 0.5) ring.push([lon, lat]);
    const d = polylinePath(face, ring, N);
    if (d) lines.push(`<path d="${d}"/>`);
  }
  if (step > 1) {
    const eq = [];
    for (let lon = -180; lon <= 180; lon += 0.5) eq.push([lon, 0]);
    const d = polylinePath(face, eq, N);
    if (d) lines.push(`<path d="${d}"/>`);
  }

  return `<g fill="none" stroke="${color}" stroke-width="${width}" opacity="${alpha}">`
    + lines.join('') + '</g>';
}

function eclipseGroup(face, N, ec) {
  const geom = ec.geometry;
  const partial = isPartialType(ec.type);
  const fill = (!partial && ec.fillEnabled) ? ec.fill : 'none';
  const parts = [];

  const addPolyline = coords => {
    const d = polylinePath(face, coords, N);
    if (d) parts.push(`<path d="${d}" fill="none"/>`);
  };
  const addPolygon = rings => {
    const d = polygonPath(face, rings, N);
    if (d) parts.push(`<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`);
  };

  if (geom.type === 'Polygon')
    partial ? geom.coordinates.forEach(addPolyline) : addPolygon(geom.coordinates);
  else if (geom.type === 'MultiPolygon')
    for (const poly of geom.coordinates)
      partial ? poly.forEach(addPolyline) : addPolygon(poly);
  else if (geom.type === 'LineString')
    addPolyline(geom.coordinates);

  if (!parts.length) return '';
  return `<g stroke="${ec.outline}" stroke-width="${ec.width}" opacity="${ec.alpha}">`
    + parts.join('') + '</g>';
}

function hatchGroup(face, N, ec, hatchInterval, gratStep) {
  if (!ec.touchedCells || !hatchInterval) return '';
  const cells = ec.touchedCells[face];
  if (!cells || !cells.length) return '';
  const lines = [];

  for (const { lonIdx, latIdx } of cells) {
    const ring = generateGraticuleCellRing(lonIdx, latIdx, gratStep);
    const ring3 = ring.map(pt => toFaceXYZ(face, orientedLonLatTo3D(pt[0], pt[1])));
    const clipped = clipRing(ring3);
    if (clipped.length < 3) continue;
    // Clip projected polygon to face bounds before hatching — prevents phantom
    // scanline intersections from out-of-bounds projected points
    const pts = clipPolyToRect(clipped.map(p => projXY(p, N)), 0, 0, N, N);
    if (pts.length < 3) continue;
    for (const [x0, y0, x1, y1] of hatchPolygon(pts, hatchInterval))
      lines.push(`<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}"/>`);
  }

  if (!lines.length) return '';
  return `<g stroke="#000000" stroke-width="0.5" opacity="${ec.alpha}" fill="none">`
    + lines.join('') + '</g>';
}

// ── Per-face SVG ──────────────────────────────────────────────────────────────

function buildFaceSvg(face, N, gratState, eclipseState, hatchInterval) {
  const { color, width, alpha } = gratState;
  const inset = width / 2;
  const parts = [`<rect width="${N}" height="${N}" fill="white"/>`];

  if (gratState.enabled) parts.push(graticuleGroup(face, N, gratState));

  // Hatch first, then eclipse paths — so paths always render on top
  for (const ec of eclipseState)
    if (ec.geometry) parts.push(hatchGroup(face, N, ec, hatchInterval, gratState.step));
  for (const ec of eclipseState)
    if (ec.geometry) parts.push(eclipseGroup(face, N, ec));

  // Face boundary on top — inset so stroke is fully inside
  if (gratState.enabled)
    parts.push(`<rect x="${inset}" y="${inset}" width="${N-width}" height="${N-width}" `
      + `fill="none" stroke="${color}" stroke-width="${width}" opacity="${alpha}"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">`
    + parts.join('') + '</svg>';
}

// ── Isometric SVG composition ─────────────────────────────────────────────────
// Cube viewed orthographically from one of its 8 corners (cornerIdx 0-7, where
// bit 0 = +X, bit 1 = +Y, bit 2 = +Z). Three faces are visible per corner.
//
// Two outputs:
//   • Graticule SVG — per-face graticule lines (existing 2D path data wrapped
//     in an affine <g transform>), plus 9 visible cube edges.
//   • Cells SVG — each cell is ONE closed path projected directly onto the
//     cube surface (no per-face transform, so cells that span face boundaries
//     stay continuous and unclipped — required for laser engraving).

// Offset geographic 3D unit vector → THREE.js scene cube-surface
// position. The geo→scene axis remap is (gx, gy, gz) → (gy, gz, gx); the
// max-axis ray intersects the cube at ±0.5.
function lonLatToCubePoint(lon, lat) {
  const [gx, gy, gz] = orientedLonLatTo3D(lon, lat);
  const tx = gy, ty = gz, tz = gx;
  const m = Math.max(Math.abs(tx), Math.abs(ty), Math.abs(tz));
  return [tx * 0.5 / m, ty * 0.5 / m, tz * 0.5 / m];
}

// Face-local 2D (fx, fy ∈ [-0.5, 0.5]) → world coords for any of the 6 faces.
// Derived from FACE_CONFIGS (pos + rot) in scene.js.
function faceLocalToWorld(face, fx, fy) {
  switch (face) {
    case 0: return [ fx,  0.5, -fy]; // +Y top
    case 1: return [ fx,  fy,   0.5]; // +Z front
    case 2: return [ 0.5, fy,  -fx]; // +X right
    case 3: return [-fx,  fy,  -0.5]; // -Z back
    case 4: return [-0.5, fy,   fx]; // -X left
    case 5: return [-fx, -0.5, -fy]; // -Y bottom
  }
}

// Build an orthographic projector for the camera placed at one of the 8 cube
// corners, looking at the origin with up=(0,1,0). Returns:
//   project(P, scale) → [svg_x, svg_y]   (Y-down for SVG)
//   visibleFaces                          three face indices
//   signs                                 (sx, sy, sz) of the corner
function isoProjector(cornerIdx) {
  const sx = (cornerIdx & 1) ? 1 : -1;
  const sy = (cornerIdx & 2) ? 1 : -1;
  const sz = (cornerIdx & 4) ? 1 : -1;
  const SQRT3 = Math.sqrt(3);
  // Camera local +Z (back, points from origin toward camera).
  const zA = [sx / SQRT3, sy / SQRT3, sz / SQRT3];
  // Camera local +Y = (world up) − (world up · zA) zA, normalized.
  // world up = (0,1,0), so (world up · zA) = sy / √3.
  const yDot = sy / SQRT3;
  let yA = [-yDot * zA[0], 1 - yDot * zA[1], -yDot * zA[2]];
  const yLen = Math.hypot(yA[0], yA[1], yA[2]);
  yA = [yA[0] / yLen, yA[1] / yLen, yA[2] / yLen];
  // Camera local +X = yA × zA.
  const xA = [
    yA[1] * zA[2] - yA[2] * zA[1],
    yA[2] * zA[0] - yA[0] * zA[2],
    yA[0] * zA[1] - yA[1] * zA[0],
  ];
  const project = (P, scale) => [
     (P[0] * xA[0] + P[1] * xA[1] + P[2] * xA[2]) * scale,
    -(P[0] * yA[0] + P[1] * yA[1] + P[2] * yA[2]) * scale, // SVG Y is down
  ];
  // The 3 visible faces share the corner's signs.
  const visibleFaces = [
    sy > 0 ? 0 : 5,
    sz > 0 ? 1 : 3,
    sx > 0 ? 2 : 4,
  ];
  return { project, visibleFaces, signs: [sx, sy, sz] };
}

// Affine matrix mapping a face's pixel coords (px, py) ∈ [0,N]² → SVG.
function isoFaceTransform(face, N, scale, projector) {
  const at = (px, py) =>
    projector.project(faceLocalToWorld(face, px / N - 0.5, 0.5 - py / N), scale);
  const o = at(0, 0), x = at(N, 0), y = at(0, N);
  return {
    a: (x[0] - o[0]) / N, b: (x[1] - o[1]) / N,
    c: (y[0] - o[0]) / N, d: (y[1] - o[1]) / N,
    e: o[0], f: o[1],
  };
}

function cornerToWorld(idx) {
  return [(idx & 1) ? 0.5 : -0.5, (idx & 2) ? 0.5 : -0.5, (idx & 4) ? 0.5 : -0.5];
}

// SVG bounding box of the projected cube hexagon (for viewBox).
function isoHexBounds(projector, scale) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const [x, y] = projector.project(cornerToWorld(i), scale);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

function faceCornersWorld(face) {
  return [
    faceLocalToWorld(face, -0.5, -0.5),
    faceLocalToWorld(face,  0.5, -0.5),
    faceLocalToWorld(face,  0.5,  0.5),
    faceLocalToWorld(face, -0.5,  0.5),
  ];
}

function isoFaceBounds(face, projector, scale) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const corner of faceCornersWorld(face)) {
    const [x, y] = projector.project(corner, scale);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, w: maxX - minX, h: maxY - minY };
}

// The 9 visible cube edges from cornerIdx (12 total minus the 3 at the far
// corner). Includes the 6 hexagon-outline edges and the 3 internal edges
// from the closest corner.
function visibleCubeEdges(cornerIdx) {
  const far = cornerIdx ^ 7;
  const edges = [];
  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4]) {
      const j = i ^ bit;
      if (j <= i) continue;
      if (i === far || j === far) continue;
      edges.push([i, j]);
    }
  }
  return edges;
}

function cubeEdgesPathD(cornerIdx, projector, scale) {
  const d = [];
  for (const [a, b] of visibleCubeEdges(cornerIdx)) {
    const [ax, ay] = projector.project(cornerToWorld(a), scale);
    const [bx, by] = projector.project(cornerToWorld(b), scale);
    d.push(`M${ax.toFixed(2)},${ay.toFixed(2)}L${bx.toFixed(2)},${by.toFixed(2)}`);
  }
  return d.join('');
}

function faceEdgesPathD(face, projector, scale) {
  const corners = faceCornersWorld(face).map(p => projector.project(p, scale));
  const d = [`M${corners[0][0].toFixed(2)},${corners[0][1].toFixed(2)}`];
  for (let i = 1; i < corners.length; i++)
    d.push(`L${corners[i][0].toFixed(2)},${corners[i][1].toFixed(2)}`);
  d.push('Z');
  return d.join('');
}

// Map (graticule ∪ cube edges) SVG for a chosen corner.
export function buildIsoGraticuleSvg(N, gratState, scale, cornerIdx) {
  const projector = isoProjector(cornerIdx);
  const b = isoHexBounds(projector, scale);
  const groups = [];

  // Cube edges (always visible — even with graticule disabled they define the silhouette).
  const edgeColor = gratState.enabled ? gratState.color : '#000000';
  const edgeWidth = gratState.enabled ? gratState.width : 1;
  const edgeAlpha = gratState.enabled ? gratState.alpha : 1;
  groups.push(`<g fill="none" stroke="${edgeColor}" stroke-width="${edgeWidth}" opacity="${edgeAlpha}">`
    + `<path d="${cubeEdgesPathD(cornerIdx, projector, scale)}"/></g>`);

  // Per-face graticule via affine transform (reuses the existing 2D path builder).
  if (gratState.enabled) {
    for (const face of projector.visibleFaces) {
      const content = graticuleGroup(face, N, gratState);
      if (!content) continue;
      const t = isoFaceTransform(face, N, scale, projector);
      groups.push(`<g transform="matrix(${t.a} ${t.b} ${t.c} ${t.d} ${t.e} ${t.f})">${content}</g>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" `
    + `viewBox="${b.minX.toFixed(2)} ${b.minY.toFixed(2)} ${b.w.toFixed(2)} ${b.h.toFixed(2)}" `
    + `width="${b.w.toFixed(2)}" height="${b.h.toFixed(2)}">`
    + groups.join('') + '</svg>';
}

// Map (graticule ∪ face boundary) SVG for one face from the chosen corner.
export function buildIsoFaceGraticuleSvg(N, gratState, scale, cornerIdx, face, opts = {}) {
  const projector = isoProjector(cornerIdx);
  const b = isoFaceBounds(face, projector, scale);
  const groups = [];

  const edgeColor = gratState.enabled ? gratState.color : '#000000';
  const edgeWidth = gratState.enabled ? gratState.width : 1;
  const edgeAlpha = gratState.enabled ? gratState.alpha : 1;

  if (gratState.enabled) {
    const content = graticuleGroup(face, N, gratState);
    if (content) {
      const t = isoFaceTransform(face, N, scale, projector);
      groups.push(`<g transform="matrix(${t.a} ${t.b} ${t.c} ${t.d} ${t.e} ${t.f})">${content}</g>`);
    }
  }

  groups.push(`<g fill="none" stroke="${edgeColor}" stroke-width="${edgeWidth}" opacity="${edgeAlpha}">`
    + `<path d="${faceEdgesPathD(face, projector, scale)}"/></g>`);

  if (opts.rotate) {
    const r = opts.rotate;
    return `<svg xmlns="http://www.w3.org/2000/svg" `
      + `viewBox="0 0 ${r.width.toFixed(2)} ${r.height.toFixed(2)}" `
      + `width="${r.width.toFixed(2)}" height="${r.height.toFixed(2)}">`
      + `<g transform="translate(${(r.translate[0] + r.pad[0]).toFixed(4)} ${(r.translate[1] + r.pad[1]).toFixed(4)}) `
      + `rotate(${r.angleDeg.toFixed(8)}) translate(${-b.minX.toFixed(4)} ${-b.minY.toFixed(4)})">`
      + groups.join('') + '</g></svg>';
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" `
    + `viewBox="${b.minX.toFixed(2)} ${b.minY.toFixed(2)} ${b.w.toFixed(2)} ${b.h.toFixed(2)}" `
    + `width="${b.w.toFixed(2)}" height="${b.h.toFixed(2)}">`
    + groups.join('') + '</svg>';
}

// Cells SVG — one closed <path> per cell, projected directly onto the cube
// surface (continuous across face boundaries; no clipping artefacts).
export function buildIsoCellsSvg(eclipseState, gratStep, scale, cornerIdx) {
  const projector = isoProjector(cornerIdx);
  const b = isoHexBounds(projector, scale);
  const [sx, sy, sz] = projector.signs;
  const groups = [];

  // A cube point is on a hidden face if any of its ±0.5-snapped axes points
  // away from the camera corner. Used to skip cells that fall entirely on
  // hidden faces.
  const EPS = 1e-6;
  const onVisibleSurface = (P) =>
       !(Math.abs(P[0]) > 0.5 - EPS && Math.sign(P[0]) !== sx)
    && !(Math.abs(P[1]) > 0.5 - EPS && Math.sign(P[1]) !== sy)
    && !(Math.abs(P[2]) > 0.5 - EPS && Math.sign(P[2]) !== sz);

  for (const ec of eclipseState) {
    if (!ec.touchedCells) continue;
    // Collect unique (lonIdx, latIdx) pairs from visible faces only.
    const seen = new Set();
    for (const face of projector.visibleFaces) {
      for (const { lonIdx, latIdx } of ec.touchedCells[face])
        seen.add(`${lonIdx},${latIdx}`);
    }
    const paths = [];
    for (const key of seen) {
      const [lonIdx, latIdx] = key.split(',').map(Number);
      const ring = generateGraticuleCellRing(lonIdx, latIdx, gratStep);
      const cubePts = ring.map(([lon, lat]) => lonLatToCubePoint(lon, lat));
      // Skip cells that lie entirely on hidden faces (rare but possible at the
      // visible/hidden seam).
      if (!cubePts.some(onVisibleSurface)) continue;
      const svgPts = cubePts.map(p => projector.project(p, scale));
      const d = [`M${svgPts[0][0].toFixed(2)},${svgPts[0][1].toFixed(2)}`];
      for (let i = 1; i < svgPts.length; i++)
        d.push(`L${svgPts[i][0].toFixed(2)},${svgPts[i][1].toFixed(2)}`);
      d.push('Z');
      paths.push(`<path d="${d.join('')}"/>`);
    }
    if (paths.length) {
      groups.push(`<g fill="${ec.fill}22" stroke="${ec.fill}" stroke-width="2" opacity="0.5">`
        + paths.join('') + '</g>');
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" `
    + `viewBox="${b.minX.toFixed(2)} ${b.minY.toFixed(2)} ${b.w.toFixed(2)} ${b.h.toFixed(2)}" `
    + `width="${b.w.toFixed(2)}" height="${b.h.toFixed(2)}">`
    + groups.join('') + '</svg>';
}

// ── Export ────────────────────────────────────────────────────────────────────

export function exportFaces(selectedFaces, N, gratState, eclipseState, hatchInterval) {
  for (const face of selectedFaces) {
    const svg = buildFaceSvg(face, N, gratState, eclipseState, hatchInterval);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `face_${face}.svg`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }
}
