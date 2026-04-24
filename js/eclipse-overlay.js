// Eclipse path overlays. Saros bins are decoded once and cached. Partial
// eclipses (P/Pb/Pe) have no central path — we draw their outer ring(s) as a
// polyline instead of filling polygons.
import { decodeSeries } from '../eclipse_codec.js';
import { SolarEclipseDB } from '../saros-browser.js';
import { drawPolygonOnFace, drawPolylineOnFace } from './projection.js';

const PARTIAL_TYPES = new Set(['P', 'Pb', 'Pe', 'Tminus', 'Aminus', 'Aplus']);
export const isPartialType = t => PARTIAL_TYPES.has(t);

const sarosCache = new Map();
export async function loadSarosBin(num) {
  if (sarosCache.has(num)) return sarosCache.get(num);
  const resp = await fetch(`./eclipses/${num}.bin`);
  if (!resp.ok) throw new Error(`saros ${num}: ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const records = decodeSeries(bytes);
  sarosCache.set(num, records);
  return records;
}

let solarDB = null;
export async function ensureSolarDB() {
  if (!solarDB) solarDB = await SolarEclipseDB.load();
  return solarDB;
}

function drawRingsAsLines(ctx, faceIdx, rings, N, style) {
  const opts = { stroke: style.outline, width: style.width, alpha: style.alpha };
  for (const ring of rings) drawPolylineOnFace(ctx, faceIdx, ring, N, opts);
}

export function drawEclipseGeometry(ctx, faceIdx, N, geom, style) {
  const partial = isPartialType(style.type);

  if (geom.type === 'Polygon') {
    if (partial) drawRingsAsLines(ctx, faceIdx, geom.coordinates, N, style);
    else drawPolygonOnFace(ctx, faceIdx, geom.coordinates, N, {
      fill: style.fillEnabled ? style.fill : null,
      stroke: style.outline, width: style.width, alpha: style.alpha,
    });
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (partial) drawRingsAsLines(ctx, faceIdx, poly, N, style);
      else drawPolygonOnFace(ctx, faceIdx, poly, N, {
        fill: style.fillEnabled ? style.fill : null,
        stroke: style.outline, width: style.width, alpha: style.alpha,
      });
    }
  } else if (geom.type === 'LineString') {
    drawPolylineOnFace(ctx, faceIdx, geom.coordinates, N,
      { stroke: style.outline, width: style.width, alpha: style.alpha });
  }
}
