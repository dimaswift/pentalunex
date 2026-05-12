export const COASTLINE_URL = "ne_50m_land.json";

let coastlinePromise = null;
let polygonPromise = null;

export function getCoastlineData() {
  if (!coastlinePromise) {
    coastlinePromise = fetch(COASTLINE_URL).then((response) => {
      if (!response.ok) throw new Error(`Natural Earth request failed: ${response.status}`);
      return response.json();
    });
  }
  return coastlinePromise;
}

export async function getLandPolygons() {
  if (!polygonPromise) {
    polygonPromise = getCoastlineData().then(extractLandPolygons);
  }
  return polygonPromise;
}

export function extractLandPolygons(geojson) {
  const polygons = [];
  for (const feature of geojson.features ?? []) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon") {
      polygons.push(geometry.coordinates.map(prepareRing));
    } else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates) {
        polygons.push(polygon.map(prepareRing));
      }
    }
  }
  return polygons;
}

function prepareRing(ring) {
  return densifyRing(thinRing(ring, 0.08), 2);
}

function thinRing(ring, minStepDeg) {
  if (ring.length <= 3) return ring;
  const out = [ring[0]];
  let last = ring[0];
  for (let index = 1; index < ring.length - 1; index += 1) {
    const point = ring[index];
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) >= minStepDeg) {
      out.push(point);
      last = point;
    }
  }
  out.push(ring[ring.length - 1]);
  return out;
}

function densifyRing(ring, stepDeg) {
  const out = [];
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [lon1, lat1] = ring[index];
    const [lon2, lat2] = ring[index + 1];
    const dlon = lon2 - lon1;
    const dlat = lat2 - lat1;
    const dist = Math.hypot(dlon, dlat);
    const steps = Math.max(1, Math.ceil(dist / stepDeg));
    for (let step = 0; step < steps; step += 1) {
      out.push([lon1 + (dlon * step) / steps, lat1 + (dlat * step) / steps]);
    }
  }
  out.push(ring[ring.length - 1]);
  return out;
}
