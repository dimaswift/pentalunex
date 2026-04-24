// SVG export of graticule + eclipse overlays for selected faces.
// Uses manual 2D Cohen-Sutherland clipping (LightBurn ignores SVG clipPath).
import { toFaceXYZ, lonLatTo3D, clipSegment, clipRing, projXY } from './projection.js';
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
  let prev3 = toFaceXYZ(face, lonLatTo3D(coords[0][0], coords[0][1]));
  let lastEnd = null;
  for (let i = 1; i < coords.length; i++) {
    const cur3 = toFaceXYZ(face, lonLatTo3D(coords[i][0], coords[i][1]));
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
    const ring3 = ring.map(pt => toFaceXYZ(face, lonLatTo3D(pt[0], pt[1])));
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
    const ring3 = ring.map(pt => toFaceXYZ(face, lonLatTo3D(pt[0], pt[1])));
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
