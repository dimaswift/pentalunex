// Treat the totality band as a curved mirror on the sphere:
//
//   1. extractCenterline(geom)   reduces the totality polygon to a single
//      non-interrupted line down its center, by pairing ring vertices i and
//      (N−1−i) and taking their great-circle midpoint. Works because NASA
//      totality polygons traverse one edge of the band, then the other in
//      reverse — so opposite indices sit across from each other.
//
//   2. castReflectorRays(line)   resamples the centerline at uniform
//      arc-length, then at each sample emits a great-circle "ray" perpendicular
//      to the local tangent in the chosen direction (±side). On a curved
//      mirror, neighbouring rays converge on one side and diverge on the
//      other — exactly the focusing behaviour we want for the reflection.
//
// Spherical math: points are unit vectors in R³. The great-circle tangent at
// P pointing towards Q is `T = normalize(Q − (Q·P)P)`. Rotating 90° in the
// tangent plane at P is `±(P × T)`. Walking θ along the great circle through
// P with tangent T is `cos θ · P + sin θ · T`.

import { lonLatTo3D } from './projection.js';

const RAD = Math.PI / 180, DEG = 180 / Math.PI;

// ── vec3 helpers ─────────────────────────────────────────────────────────────
const dot   = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const scale = (v, s) => [v[0]*s, v[1]*s, v[2]*s];
const add   = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const sub   = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 ? [v[0]/l, v[1]/l, v[2]/l] : v;
}

function vec3ToLonLat(p) {
  const z = Math.max(-1, Math.min(1, p[2]));
  return [Math.atan2(p[1], p[0]) * DEG, Math.asin(z) * DEG];
}

// Spherical linear interpolation between unit vectors a and b at t∈[0,1].
function slerp(a, b, t) {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  const Ω = Math.acos(c);
  if (Ω < 1e-9) return a.slice();
  const s = Math.sin(Ω);
  return normalize(add(scale(a, Math.sin((1-t)*Ω)/s), scale(b, Math.sin(t*Ω)/s)));
}

// ── Centerline extraction ────────────────────────────────────────────────────

// Resample a polyline of unit vectors at `n` evenly-spaced great-circle
// arc-length samples. Used to align two boundary arcs of the same band.
function resampleArc3(arc, n) {
  if (arc.length === 0) return [];
  if (arc.length === 1 || n < 2) return new Array(n).fill(arc[0]);
  const cum = [0];
  for (let i = 1; i < arc.length; i++) {
    const c = Math.max(-1, Math.min(1, dot(arc[i-1], arc[i])));
    cum.push(cum[i-1] + Math.acos(c));
  }
  const total = cum[cum.length - 1] || 1;
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const s = (k / (n - 1)) * total;
    let j = 0;
    while (j < arc.length - 2 && cum[j+1] < s) j++;
    const span = cum[j+1] - cum[j];
    const t = span > 0 ? (s - cum[j]) / span : 0;
    out[k] = slerp(arc[j], arc[j+1], t);
  }
  return out;
}

// Build a centerline for one polygon ring.
//
// We don't know where on the band's boundary the ring starts. Naively pairing
// i with N−1−i breaks at the loop seam and produces a perpendicular kink at
// the end. Instead:
//   1. Find the two "tips" of the band — the pair of ring vertices farthest
//      apart on the sphere.
//   2. Split the ring into two arcs going from one tip to the other in
//      opposite directions.
//   3. Resample both arcs to the same number of points by arc-length.
//   4. Pair sample-by-sample and take the great-circle midpoint.
// Endpoints land exactly on the tips, so the centerline has no kinks.
function ringCenterline(ring, opts = {}) {
  const minSamples = opts.minSamples ?? 32;
  if (!ring || ring.length < 4) return [];
  const last = ring[ring.length - 1], first = ring[0];
  if (last[0] === first[0] && last[1] === first[1]) ring = ring.slice(0, -1);
  const N = ring.length;
  if (N < 4) return [];

  const pts3 = ring.map(([lo, la]) => lonLatTo3D(lo, la));

  // Find the two band tips by scanning all vertex pairs (O(N²); rings are
  // typically a few hundred vertices). The smallest dot product = largest
  // angular separation.
  let minDot = Infinity, ia = 0, ib = 1;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const d = dot(pts3[i], pts3[j]);
      if (d < minDot) { minDot = d; ia = i; ib = j; }
    }
  }

  // Walk the ring from ia to ib in both directions.
  const arc1 = [], arc2 = [];
  for (let k = ia; ; k = (k + 1) % N)         { arc1.push(pts3[k]); if (k === ib) break; }
  for (let k = ia; ; k = (k - 1 + N) % N)     { arc2.push(pts3[k]); if (k === ib) break; }

  // Resample to the same number of samples by arc length on each side.
  const n = Math.max(arc1.length, arc2.length, minSamples);
  const r1 = resampleArc3(arc1, n);
  const r2 = resampleArc3(arc2, n);

  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = vec3ToLonLat(normalize(add(r1[i], r2[i])));
  return out;
}

/**
 * Extract centerlines from a totality geometry. Returns one polyline per
 * polygon: single-element array for Polygon, multiple for MultiPolygon
 * (e.g. antimeridian-split paths). Each polyline starts and ends exactly at
 * the band tips — no perpendicular kinks.
 *
 * @param geom   GeoJSON Polygon or MultiPolygon
 * @returns      Array<Array<[lon, lat]>>
 */
export function extractCenterlines(geom) {
  if (!geom) return [];
  const rings = [];
  if (geom.type === 'Polygon') {
    if (geom.coordinates[0]) rings.push(geom.coordinates[0]);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) if (poly[0]) rings.push(poly[0]);
  } else {
    return [];
  }
  const out = [];
  for (const ring of rings) {
    const line = ringCenterline(ring);
    if (line.length >= 2) out.push(line);
  }
  return out;
}

// ── Reflector ray casting ────────────────────────────────────────────────────

// Re-sample a polyline at uniform great-circle arc-length.
// Returns 3D unit vectors (skip the lon/lat round-trip until needed).
function resampleByArcLength(line, stepRad) {
  if (line.length < 2) return line.map(([lo, la]) => lonLatTo3D(lo, la));
  const pts = line.map(([lo, la]) => lonLatTo3D(lo, la));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const c = Math.max(-1, Math.min(1, dot(pts[i-1], pts[i])));
    cum.push(cum[i-1] + Math.acos(c));
  }
  const total = cum[cum.length - 1];
  if (total < 1e-9) return [pts[0]];
  const out = [];
  let j = 0;
  for (let s = 0; s <= total; s += stepRad) {
    while (j < pts.length - 2 && cum[j+1] < s) j++;
    const span = cum[j+1] - cum[j];
    const t = span > 0 ? (s - cum[j]) / span : 0;
    out.push(slerp(pts[j], pts[j+1], t));
  }
  // ensure final endpoint
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Build great-circle rays perpendicular to one or more centerlines.
 *
 * @param centerlines  array of polylines (as returned by extractCenterlines);
 *                     each polyline is [[lon, lat], ...] ordered along the band
 * @param opts         {
 *                       stepDeg: number,        // spacing between rays along the centerline
 *                       side: +1 | -1,          // which side of the band to shoot rays from
 *                       lengthDeg: number,      // ray length in degrees of arc
 *                       samplesPerRay: number,  // sample count per ray polyline
 *                     }
 * @returns            flat array of polylines; each polyline is [[lon, lat], ...]
 */
export function castReflectorRays(centerlines, opts = {}) {
  const stepDeg       = opts.stepDeg       ?? 1.0;
  const side          = opts.side          ?? +1;
  const lengthDeg     = opts.lengthDeg     ?? 120;
  const samplesPerRay = opts.samplesPerRay ?? 64;
  const lenRad        = lengthDeg * RAD;
  const sideSign      = Math.sign(side) || 1;

  const rays = [];
  for (const line of centerlines) {
    if (!line || line.length < 2) continue;
    const samples = resampleByArcLength(line, stepDeg * RAD);
    for (let i = 0; i < samples.length - 1; i++) {
      const P = samples[i], Q = samples[i + 1];
      // tangent along the centerline at P
      const T = normalize(sub(Q, scale(P, dot(P, Q))));
      if (!Number.isFinite(T[0])) continue;
      // perpendicular in the tangent plane at P, on the chosen side
      const Nperp = normalize(scale(cross(P, T), sideSign));

      const ray = new Array(samplesPerRay + 1);
      for (let s = 0; s <= samplesPerRay; s++) {
        const θ = (s / samplesPerRay) * lenRad;
        const c = Math.cos(θ), si = Math.sin(θ);
        ray[s] = vec3ToLonLat([
          P[0]*c + Nperp[0]*si,
          P[1]*c + Nperp[1]*si,
          P[2]*c + Nperp[2]*si,
        ]);
      }
      rays.push(ray);
    }
  }
  return rays;
}
