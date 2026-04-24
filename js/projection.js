// Frame-based gnomonic projection for the COBE CSC cube.
// Each face has an orthonormal (east, north, normal) frame. A point on the
// unit sphere is rotated into the frame, then projected as (X/Z, Y/Z). This
// matches the inverses in cobe-csc.js (including the south-face sign
// convention) so overlays land exactly where the map texture does.

export const DEG = Math.PI / 180;

export const FACE_NAMES = [
  'North Pole', '+X (0°)', '+Y (90°E)', '-X (180°)', '-Y (270°E)', 'South Pole',
];

export const FACE_FRAMES = [
  { east:[ 0, 1, 0], north:[-1, 0, 0], normal:[ 0, 0, 1] }, // 0  N pole
  { east:[ 0, 1, 0], north:[ 0, 0, 1], normal:[ 1, 0, 0] }, // 1  lon=0
  { east:[-1, 0, 0], north:[ 0, 0, 1], normal:[ 0, 1, 0] }, // 2  lon=90
  { east:[ 0,-1, 0], north:[ 0, 0, 1], normal:[-1, 0, 0] }, // 3  lon=180
  { east:[ 1, 0, 0], north:[ 0, 0, 1], normal:[ 0,-1, 0] }, // 4  lon=270
  { east:[ 0,-1, 0], north:[-1, 0, 0], normal:[ 0, 0,-1] }, // 5  S pole
];

export function lonLatTo3D(lon, lat) {
  const la = lat * DEG, lo = lon * DEG;
  const cl = Math.cos(la);
  return [cl*Math.cos(lo), cl*Math.sin(lo), Math.sin(la)];
}

export function toFaceXYZ(face, p) {
  const f = FACE_FRAMES[face];
  return [
    p[0]*f.east[0]   + p[1]*f.east[1]   + p[2]*f.east[2],
    p[0]*f.north[0]  + p[1]*f.north[1]  + p[2]*f.north[2],
    p[0]*f.normal[0] + p[1]*f.normal[1] + p[2]*f.normal[2],
  ];
}

// Clip plane just inside the visible hemisphere — keeps the division finite.
const CLIP_EPS = 0.02; // ≈ 88.85° from face normal

function interpZ(a, b) {
  const t = (CLIP_EPS - a[2]) / (b[2] - a[2]);
  return [a[0] + t*(b[0]-a[0]), a[1] + t*(b[1]-a[1]), CLIP_EPS];
}

// Sutherland-Hodgman clip of a closed ring against Z >= CLIP_EPS.
export function clipRing(ring) {
  if (ring.length === 0) return [];
  const out = [];
  let prev = ring[ring.length - 1];
  let prevIn = prev[2] >= CLIP_EPS;
  for (const cur of ring) {
    const curIn = cur[2] >= CLIP_EPS;
    if (curIn) {
      if (!prevIn) out.push(interpZ(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(interpZ(prev, cur));
    }
    prev = cur; prevIn = curIn;
  }
  return out;
}

// Clip one segment a→b against the visible hemisphere.
export function clipSegment(a, b) {
  const aIn = a[2] >= CLIP_EPS, bIn = b[2] >= CLIP_EPS;
  if (aIn && bIn) return [a, b];
  if (!aIn && !bIn) return null;
  const ip = interpZ(a, b);
  return aIn ? [a, ip] : [ip, b];
}

export function projXY(p, N) {
  return { px: (1 + p[0]/p[2]) / 2 * N, py: (1 - p[1]/p[2]) / 2 * N };
}

// Draw a polyline ([[lon,lat], ...]) on the given face, clipping each segment.
export function drawPolylineOnFace(ctx, face, coords, N, opts) {
  if (coords.length < 2) return;
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.strokeStyle = opts.stroke;
  ctx.lineWidth = opts.width ?? 1;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let prev3 = toFaceXYZ(face, lonLatTo3D(coords[0][0], coords[0][1]));
  let lastEnd = null;
  for (let i = 1; i < coords.length; i++) {
    const cur3 = toFaceXYZ(face, lonLatTo3D(coords[i][0], coords[i][1]));
    const seg = clipSegment(prev3, cur3);
    if (seg) {
      const a = projXY(seg[0], N), b = projXY(seg[1], N);
      if (!lastEnd || lastEnd.px !== a.px || lastEnd.py !== a.py) ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      lastEnd = b;
    } else {
      lastEnd = null;
    }
    prev3 = cur3;
  }
  ctx.stroke();
  ctx.restore();
}

// Draw a polygon (array of rings) on the given face, using 3D hemisphere
// clipping so rings that cross the horizon stay closed and correctly wound.
export function drawPolygonOnFace(ctx, face, rings, N, opts) {
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.beginPath();
  for (const ring of rings) {
    const ring3 = ring.map(pt => toFaceXYZ(face, lonLatTo3D(pt[0], pt[1])));
    const clipped = clipRing(ring3);
    if (clipped.length < 3) continue;
    const first = projXY(clipped[0], N);
    ctx.moveTo(first.px, first.py);
    for (let i = 1; i < clipped.length; i++) {
      const p = projXY(clipped[i], N);
      ctx.lineTo(p.px, p.py);
    }
    ctx.closePath();
  }
  if (opts.fill) { ctx.fillStyle = opts.fill; ctx.fill('evenodd'); }
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.width ?? 1;
    ctx.stroke();
  }
  ctx.restore();
}
