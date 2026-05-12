// octal-glyph.js — procedural glyph generator that mirrors Fractonica::OctalGlyph::Draw.
// Each row of the glyph encodes 12 bits (= 4 octal digits) of the input value.
//
// Output is built from polyline "chains" (connected sequences of segments).
// Each chain is emitted as a SINGLE clean polygon outline with mitered corners,
// so the resulting SVG fills correctly in laser-engraving software.

const DIAMOND = [
  [2, 2], [3, 1], [4, 2], [5, 3], [6, 4], [5, 5],
  [4, 6], [3, 7], [2, 6], [1, 5], [0, 4], [1, 3],
];

const INNER_DIAMOND = [[3, 3], [4, 4], [3, 5], [2, 4]];

const V = (x, y) => ({ x, y });
const vSub = (a, b) => V(a.x - b.x, a.y - b.y);
const vAdd = (a, b) => V(a.x + b.x, a.y + b.y);
const vScale = (a, s) => V(a.x * s, a.y * s);
const vLen = (a) => Math.hypot(a.x, a.y);
const vNorm = (a) => {
  const L = vLen(a);
  return L === 0 ? V(0, 0) : V(a.x / L, a.y / L);
};

function rotate(p, pivot, angleRad) {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return V(pivot.x + dx * c - dy * s, pivot.y + dx * s + dy * c);
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return BigInt(value);
}

export function parseOctal(str) {
  const s = String(str).trim().replace(/_/g, '');
  if (!s) return 0n;
  const cleaned = s.replace(/^0o/i, '').replace(/^0+(?=\d)/, '');
  if (!/^[0-7]+$/.test(cleaned)) throw new Error('Not a valid octal number');
  return BigInt('0o' + cleaned);
}

export function toOctalString(value) {
  return toBigInt(value).toString(8);
}

// Build the list of chains. Each chain is { vertices: [...], closed: bool, pivot }.
// Open chains correspond to rim segments protruding from anchors;
// closed chains correspond to the always-drawn inner diamond per row.
export function generateChains(value, options = {}) {
  const size = options.size ?? 10;
  const angle = ((options.angle ?? 0) * Math.PI) / 180;
  const symbolLimit = options.symbolLimit ?? Infinity;
  const rhombic = options.rhombic ?? false;
  const yScale = rhombic ? (options.rhombicRatio ?? 2) : 1;

  let v = toBigInt(value);

  let rowCount = 0;
  let temp = v;
  while (temp !== 0n) { rowCount++; temp >>= 12n; }
  if (rowCount === 0) rowCount = 1;
  while (rowCount > symbolLimit) {
    v >>= 12n;
    rowCount--;
  }

  const chains = [];
  const p = { x: 0, y: 0 };
  let digits = 1;
  const sy = size * yScale;

  while (true) {
    const center = V(p.x + 4 * size, p.y + 4 * sy);
    const p0 = V(center.x - size, center.y);
    const p1 = V(center.x + size, center.y);
    const p2 = V(center.x, center.y + sy);
    const p3 = V(center.x, center.y - sy);

    // Inner diamond is a closed loop: p0 → p2 → p1 → p3 → p0.
    chains.push({
      vertices: [p0, p2, p1, p3],
      closed: true,
      pivot: center,
    });

    for (let i = 0; i < 4; i++) {
      const anchor = V(
        p.x + INNER_DIAMOND[i][0] * size + size,
        p.y + INNER_DIAMOND[i][1] * sy
      );
      const verts = [anchor];
      let lastIncluded = anchor;
      for (let j = 0; j < 3; j++) {
        const bit = (v >> BigInt(3 * i + j)) & 1n;
        const d = DIAMOND[i * 3 + j];
        const next = V(p.x + d[0] * size + size, p.y + d[1] * sy);
        if (bit === 1n) {
          verts.push(next);
          lastIncluded = next;
        }
      }
      if (verts.length >= 2) {
        chains.push({ vertices: verts, closed: false, pivot: center });
      }
    }

    v >>= 12n;
    if (v === 0n) break;
    digits++;
    p.y += 6 * sy;
  }

  if (angle !== 0) {
    for (const ch of chains) {
      ch.vertices = ch.vertices.map((pt) => rotate(pt, ch.pivot, angle));
    }
  }

  return { chains, digits, size };
}

// Compute the two side polylines of an offset chain.
// Returns { left, right } where left = +normal side, right = −normal side.
// For closed chains, left wraps around the OUTER boundary, right wraps around the INNER hole.
// cornerStart[i] gives the index in left/right where vertex i's corner begins
// (a miter contributes 1 vertex, a bevel contributes 2; this lets callers
//  align polyline indices back to the original chain vertices).
function chainSides(vertices, closed, thickness, miterLimit) {
  const n = vertices.length;
  if (n < 2) return null;
  const h = thickness / 2;

  const segDir = (i) => {
    const next = closed ? (i + 1) % n : i + 1;
    if (next >= n && !closed) return null;
    return vNorm(vSub(vertices[next], vertices[i]));
  };

  const left = [];
  const right = [];
  const cornerStart = new Array(n);

  for (let i = 0; i < n; i++) {
    cornerStart[i] = left.length;
    const hasIncoming = closed || i > 0;
    const hasOutgoing = closed || i < n - 1;

    if (!hasIncoming) {
      const d = segDir(0);
      const nrm = V(-d.y, d.x);
      left.push(vAdd(vertices[0], vScale(nrm, h)));
      right.push(vSub(vertices[0], vScale(nrm, h)));
    } else if (!hasOutgoing) {
      const d = segDir(n - 2);
      const nrm = V(-d.y, d.x);
      left.push(vAdd(vertices[n - 1], vScale(nrm, h)));
      right.push(vSub(vertices[n - 1], vScale(nrm, h)));
    } else {
      const inIdx = closed ? (i - 1 + n) % n : i - 1;
      const d0 = segDir(inIdx);
      const d1 = segDir(i);
      const n0 = V(-d0.y, d0.x);
      const n1 = V(-d1.y, d1.x);
      const denom = 1 + n0.x * n1.x + n0.y * n1.y;
      const miterLen = Math.abs(denom) > 1e-9 ? h / denom : Infinity;

      if (!isFinite(miterLen) || Math.abs(miterLen) > miterLimit * h) {
        left.push(vAdd(vertices[i], vScale(n0, h)));
        left.push(vAdd(vertices[i], vScale(n1, h)));
        right.push(vSub(vertices[i], vScale(n0, h)));
        right.push(vSub(vertices[i], vScale(n1, h)));
      } else {
        const m = V(n0.x + n1.x, n0.y + n1.y);
        left.push(V(vertices[i].x + m.x * miterLen, vertices[i].y + m.y * miterLen));
        right.push(V(vertices[i].x - m.x * miterLen, vertices[i].y - m.y * miterLen));
      }
    }
  }

  return { left, right, cornerStart, closed };
}

function chainOutline(vertices, closed, thickness, miterLimit) {
  const sides = chainSides(vertices, closed, thickness, miterLimit);
  if (!sides) return null;
  if (sides.closed) return { closed: true, outer: sides.left, inner: sides.right };
  return { closed: false, polygon: [...sides.left, ...sides.right.slice().reverse()] };
}

function lineSegIntersect(p1, p2, p3, p4) {
  const rx = p2.x - p1.x, ry = p2.y - p1.y;
  const sx = p4.x - p3.x, sy = p4.y - p3.y;
  const rxs = rx * sy - ry * sx;
  if (Math.abs(rxs) < 1e-9) return null;
  const qpx = p3.x - p1.x, qpy = p3.y - p1.y;
  const u = (qpx * ry - qpy * rx) / rxs;
  if (u < -1e-6 || u > 1 + 1e-6) return null;
  return V(p3.x + u * sx, p3.y + u * sy);
}

function findLinePolylineHit(lineP1, lineP2, polyline) {
  for (let i = 0; i < polyline.length - 1; i++) {
    const hit = lineSegIntersect(lineP1, lineP2, polyline[i], polyline[i + 1]);
    if (hit) return { point: hit, segmentIndex: i };
  }
  return null;
}

// Group chains coming out of generateChains into per-row buckets.
// Each row begins with the closed inner-diamond chain and is followed by 0–4 open rim chains.
function groupRowChains(chains) {
  const rows = [];
  let cur = null;
  for (const ch of chains) {
    if (ch.closed) {
      if (cur) rows.push(cur);
      cur = { diamond: ch, rims: [] };
    } else if (cur) {
      cur.rims.push(ch);
    }
  }
  if (cur) rows.push(cur);
  return rows;
}

// Build the merged outer polygon for a single row by splicing each rim chain's
// outline into the inner diamond's outer offset at the corresponding anchor.
// Returns { outer, inner } where inner is the diamond's interior hole.
function mergeRowOutline(row, thickness, miterLimit) {
  const h = thickness / 2;
  const cycle = row.diamond.vertices;
  const n = cycle.length;
  const dSides = chainSides(cycle, true, thickness, miterLimit);
  if (!dSides) return null;

  // Match each rim chain to its cycle vertex by anchor coordinates.
  const chainAt = new Array(n).fill(null);
  for (const ch of row.rims) {
    const a = ch.vertices[0];
    for (let i = 0; i < n; i++) {
      const c = cycle[i];
      if (Math.abs(c.x - a.x) < 1e-3 && Math.abs(c.y - a.y) < 1e-3) {
        chainAt[i] = ch;
        break;
      }
    }
  }

  const outer = [];

  for (let i = 0; i < n; i++) {
    const chain = chainAt[i];
    const cornerIdx = dSides.cornerStart[i];
    const cornerCount = (i + 1 < n ? dSides.cornerStart[i + 1] : dSides.left.length) - cornerIdx;

    if (!chain) {
      for (let k = 0; k < cornerCount; k++) outer.push(dSides.left[cornerIdx + k]);
      continue;
    }

    const Vprev = cycle[(i - 1 + n) % n];
    const Vi = cycle[i];
    const Vnext = cycle[(i + 1) % n];

    const dIn = vNorm(vSub(Vi, Vprev));
    const nIn = V(-dIn.y, dIn.x);
    const inA = vAdd(Vprev, vScale(nIn, h));
    const inB = vAdd(Vi, vScale(nIn, h));

    const dOut = vNorm(vSub(Vnext, Vi));
    const nOut = V(-dOut.y, dOut.x);
    const outA = vAdd(Vi, vScale(nOut, h));
    const outB = vAdd(Vnext, vScale(nOut, h));

    const cSides = chainSides(chain.vertices, false, thickness, miterLimit);
    if (!cSides) {
      for (let k = 0; k < cornerCount; k++) outer.push(dSides.left[cornerIdx + k]);
      continue;
    }

    const dBr = vNorm(vSub(chain.vertices[1], chain.vertices[0]));
    const nBr = V(-dBr.y, dBr.x);
    const entryOnLeft = nIn.x * nBr.x + nIn.y * nBr.y > 0;
    const entrySide = entryOnLeft ? cSides.left : cSides.right;
    const exitSide = entryOnLeft ? cSides.right : cSides.left;

    const X1 = findLinePolylineHit(inA, inB, entrySide);
    const X2 = findLinePolylineHit(outA, outB, exitSide);

    if (!X1 || !X2) {
      for (let k = 0; k < cornerCount; k++) outer.push(dSides.left[cornerIdx + k]);
      continue;
    }

    outer.push(X1.point);
    for (let k = X1.segmentIndex + 1; k < entrySide.length; k++) outer.push(entrySide[k]);
    outer.push(exitSide[exitSide.length - 1]);
    for (let k = exitSide.length - 2; k > X2.segmentIndex; k--) outer.push(exitSide[k]);
    outer.push(X2.point);
  }

  return { outer, inner: dSides.right };
}

function polygonArea(pts) {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}

const fmt = (n) => {
  const r = Math.round(n * 1000) / 1000;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
};

const pointsStr = (pts) => pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');

const subpathD = (pts) => {
  if (pts.length === 0) return '';
  const head = `M${fmt(pts[0].x)},${fmt(pts[0].y)}`;
  const rest = pts.slice(1).map((p) => `L${fmt(p.x)},${fmt(p.y)}`).join('');
  return head + rest + 'Z';
};

export function generateSVG(value, options = {}) {
  const thickness = options.thickness ?? 2;
  const color = options.color ?? '#000000';
  const background = options.background ?? null;
  const padding = options.padding ?? thickness;
  const miterLimit = options.miterLimit ?? 10;
  const merge = options.merge ?? true;

  const { chains } = generateChains(value, options);

  // Two output modes:
  //   merge=true  → one merged polygon (outer + diamond hole) per glyph row, no internal seams.
  //   merge=false → one polygon per chain (the older behaviour).
  const shapes = [];
  if (merge) {
    const rows = groupRowChains(chains);
    for (const row of rows) {
      const merged = mergeRowOutline(row, thickness, miterLimit);
      if (!merged) continue;
      // Drop the inner hole if the offset has inverted (thickness too large for the diamond).
      const outerArea = polygonArea(merged.outer);
      const innerArea = polygonArea(merged.inner);
      const useInner = merged.inner.length >= 3 && outerArea * innerArea > 0
        && Math.abs(innerArea) < Math.abs(outerArea);
      shapes.push({ outer: merged.outer, inner: useInner ? merged.inner : null });
    }
  } else {
    for (const ch of chains) {
      const o = chainOutline(ch.vertices, ch.closed, thickness, miterLimit);
      if (!o) continue;
      if (o.closed) shapes.push({ outer: o.outer, inner: o.inner });
      else shapes.push({ outer: o.polygon, inner: null });
    }
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (pts) => {
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  };
  for (const s of shapes) {
    grow(s.outer);
    if (s.inner) grow(s.inner);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }

  minX -= padding; minY -= padding; maxX += padding; maxY += padding;
  const w = maxX - minX;
  const h = maxY - minY;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(minX)} ${fmt(minY)} ${fmt(w)} ${fmt(h)}" width="${fmt(w)}" height="${fmt(h)}">`
  );
  if (background) {
    parts.push(`<rect x="${fmt(minX)}" y="${fmt(minY)}" width="${fmt(w)}" height="${fmt(h)}" fill="${background}"/>`);
  }
  parts.push(`<g fill="${color}" stroke="none" fill-rule="evenodd">`);

  for (const s of shapes) {
    if (s.inner) {
      parts.push(`<path d="${subpathD(s.outer)}${subpathD(s.inner)}"/>`);
    } else {
      parts.push(`<polygon points="${pointsStr(s.outer)}"/>`);
    }
  }

  parts.push(`</g>`);
  parts.push(`</svg>`);
  return parts.join('');
}

// Back-compat: the old segment-based API. Each polyline segment becomes a
// stand-alone two-vertex chain — kept so existing callers don't break.
export function generateSegments(value, options = {}) {
  const { chains, digits, size } = generateChains(value, options);
  const segments = [];
  for (const c of chains) {
    const n = c.vertices.length;
    const last = c.closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = c.vertices[i];
      const b = c.vertices[(i + 1) % n];
      segments.push({ start: a, end: b, pivot: c.pivot });
    }
  }
  return { segments, digits, size };
}

export default { generateChains, generateSegments, generateSVG, parseOctal, toOctalString };
