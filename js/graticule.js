// Graticule overlay: parallels + meridians at a configurable angular step.
import { drawPolylineOnFace } from './projection.js';

export function drawGraticule(ctx, faceIdx, N, opts) {
  const step = opts.step;
  const lineOpts = { stroke: opts.color, width: opts.width, alpha: opts.alpha };

  for (let lat = -90 + step; lat < 90; lat += step) {
    const ring = [];
    for (let lon = -180; lon <= 180; lon += 0.5) ring.push([lon, lat]);
    drawPolylineOnFace(ctx, faceIdx, ring, N, lineOpts);
  }
  for (let lon = -180; lon < 180; lon += step) {
    const ring = [];
    for (let lat = -90; lat <= 90; lat += 0.5) ring.push([lon, lat]);
    drawPolylineOnFace(ctx, faceIdx, ring, N, lineOpts);
  }
  if (step > 1) {
    const eq = [];
    for (let lon = -180; lon <= 180; lon += 0.5) eq.push([lon, 0]);
    drawPolylineOnFace(ctx, faceIdx, eq, N, lineOpts);
  }
}
