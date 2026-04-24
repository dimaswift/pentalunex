// Eclipse path overlays. Saros bins are decoded once and cached. Partial
// eclipses (P/Pb/Pe) have no central path — we draw their outer ring(s) as a
// polyline instead of filling polygons.
import { decodeSeries } from '../eclipse_codec.js';
import { SolarEclipseDB } from '../saros-browser.js';
import { drawPolygonOnFace, drawPolylineOnFace, FACE_FRAMES, lonLatTo3D } from './projection.js';
import { findGraticuleCellIndex } from './graticule-cells.js';

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

// Same face-detection logic as mouse hover: highest dot product with face normal
function lonLatToFace(lon, lat) {
  const p = lonLatTo3D(lon, lat);
  let maxDot = -Infinity, owningFace = 0;
  for (let f = 0; f < 6; f++) {
    const { normal } = FACE_FRAMES[f];
    const dot = p[0]*normal[0] + p[1]*normal[1] + p[2]*normal[2];
    if (dot > maxDot) { maxDot = dot; owningFace = f; }
  }
  return owningFace;
}

// Find cells per face — mirrors the mouse hover approach exactly
// Returns an array of 6 Sets, one per face
export function getCellsByFace(geom, step) {
  const faceCells = Array.from({length: 6}, () => new Set());

  function addCoord(lon, lat) {
    const face = lonLatToFace(lon, lat);
    const { lonIdx, latIdx } = findGraticuleCellIndex(lon, lat, step);
    faceCells[face].add(`${lonIdx},${latIdx}`);
  }

  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) for (const [lon, lat] of ring) addCoord(lon, lat);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) for (const ring of poly) for (const [lon, lat] of ring) addCoord(lon, lat);
  } else if (geom.type === 'LineString') {
    for (const [lon, lat] of geom.coordinates) addCoord(lon, lat);
  } else if (geom.type === 'MultiLineString') {
    for (const line of geom.coordinates) for (const [lon, lat] of line) addCoord(lon, lat);
  }

  return faceCells.map(set => Array.from(set).map(s => {
    const [lonIdx, latIdx] = s.split(',').map(Number);
    return { lonIdx, latIdx };
  }));
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
