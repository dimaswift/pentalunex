// Solid-color land/ocean rendering using Natural Earth coastlines.
import { drawPolygonOnFace } from './projection.js';

const COASTLINE_URL = 'https://cdn.jsdelivr.net/gh/martynafford/natural-earth-geojson@master/10m/physical/ne_10m_land.json';

let coastlinePromise = null;
export function getCoastlineData() {
  if (!coastlinePromise) {
    coastlinePromise = fetch(COASTLINE_URL).then(r => r.json());
  }
  return coastlinePromise;
}

// Sub-sample long geodesic-ish edges so gnomonic distortion stays smooth.
function densifyRing(ring, stepDeg) {
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i+1];
    const dlon = lon2 - lon1, dlat = lat2 - lat1;
    const dist = Math.sqrt(dlon*dlon + dlat*dlat);
    const n = Math.max(1, Math.ceil(dist / stepDeg));
    for (let k = 0; k < n; k++) {
      out.push([lon1 + dlon*k/n, lat1 + dlat*k/n]);
    }
  }
  out.push(ring[ring.length-1]);
  return out;
}

export async function renderFaceSolid(canvas, faceIdx, N, colors) {
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = colors.ocean;
  ctx.fillRect(0, 0, N, N);

  const geo = await getCoastlineData();
  const coastWidth = parseFloat(colors.coastWidth);
  for (const feat of geo.features) {
    const g = feat.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      const rings = poly.map(r => densifyRing(r, 2));
      drawPolygonOnFace(ctx, faceIdx, rings, N, {
        fill: colors.ground,
        stroke: coastWidth > 0 ? colors.coast : null,
        width: coastWidth,
        alpha: 1,
      });
    }
  }
}
