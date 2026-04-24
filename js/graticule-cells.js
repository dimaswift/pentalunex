// Graticule cell detection and highlighting for cube map faces
import { DEG, FACE_FRAMES, toFaceXYZ, lonLatTo3D, clipRing, projXY } from './projection.js';

// Reverse projection: pixel → face XYZ → lon/lat
export function pixelToLonLat(face, px, py, N) {
  // Reverse of projXY: px = (1 + x/z) / 2 * N, py = (1 - y/z) / 2 * N
  // So: x/z = 2*px/N - 1, y/z = 1 - 2*py/N
  const x = 2 * px / N - 1;
  const y = 1 - 2 * py / N;
  const z = 1; // Set z=1 for normalized direction, then normalize

  // The point in face space is (x, y, z) (unnormalized)
  // Normalize to unit vector
  const len = Math.sqrt(x*x + y*y + z*z);
  const nx = x / len, ny = y / len, nz = z / len;

  // Transform back from face space to 3D world space
  const f = FACE_FRAMES[face];
  const p = [
    nx * f.east[0] + ny * f.north[0] + nz * f.normal[0],
    nx * f.east[1] + ny * f.north[1] + nz * f.normal[1],
    nx * f.east[2] + ny * f.north[2] + nz * f.normal[2],
  ];

  return sphericalToLonLat(p);
}

function sphericalToLonLat(p) {
  const lon = Math.atan2(p[1], p[0]) / DEG;
  const lat = Math.asin(Math.max(-1, Math.min(1, p[2]))) / DEG;
  return [lon, lat];
}

// Find which graticule cell contains a lon/lat point
export function findGraticuleCellIndex(lon, lat, step) {
  // Snap to grid: cell index is floor(coord / step)
  const lonIdx = Math.floor((lon + 180) / step);
  const latIdx = Math.floor((lat + 90) / step);
  return { lonIdx, latIdx };
}

// Generate the ring of lon/lat coordinates for a graticule cell
export function generateGraticuleCellRing(lonIdx, latIdx, step) {
  const lon0 = -180 + lonIdx * step;
  const lon1 = lon0 + step;
  const lat0 = -90 + latIdx * step;
  const lat1 = lat0 + step;

  const ring = [];

  // Bottom edge (south latitude)
  for (let i = 0; i <= 10; i++) {
    const lon = lon0 + (lon1 - lon0) * i / 10;
    ring.push([lon, lat0]);
  }

  // Right edge (east longitude)
  for (let i = 1; i <= 10; i++) {
    const lat = lat0 + (lat1 - lat0) * i / 10;
    ring.push([lon1, lat]);
  }

  // Top edge (north latitude)
  for (let i = 9; i >= 0; i--) {
    const lon = lon0 + (lon1 - lon0) * i / 10;
    ring.push([lon, lat1]);
  }

  // Left edge (west longitude)
  for (let i = 9; i >= 1; i--) {
    const lat = lat0 + (lat1 - lat0) * i / 10;
    ring.push([lon0, lat]);
  }

  return ring;
}

// Draw face boundaries for all 6 faces (visible on this face only)
export function drawFaceBoundaries(ctx, face, N, opts) {
  for (let f = 0; f < 6; f++) {
    const polylines = getFaceBoundaryPolylines(f);
    for (const ring of polylines) {
      const ring3 = ring.map(pt => toFaceXYZ(face, lonLatTo3D(pt[0], pt[1])));
      const clipped = clipRing(ring3);

      if (clipped.length < 2) continue;

      ctx.save();
      ctx.globalAlpha = opts.alpha ?? 0.5;
      ctx.strokeStyle = opts.stroke ?? '#888';
      ctx.lineWidth = opts.width ?? 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();

      let first = true;
      for (const p3d of clipped) {
        const p = projXY(p3d, N);
        if (first) {
          ctx.moveTo(p.px, p.py);
          first = false;
        } else {
          ctx.lineTo(p.px, p.py);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
  }
}

// Draw a graticule cell on a specific face
export function drawGraticuleCellOnFace(ctx, face, lonIdx, latIdx, step, N, opts) {
  const ring = generateGraticuleCellRing(lonIdx, latIdx, step);
  const ring3 = ring.map(pt => toFaceXYZ(face, lonLatTo3D(pt[0], pt[1])));
  const clipped = clipRing(ring3);

  if (clipped.length < 3) return; // Not visible on this face

  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 0.3;

  const first = projXY(clipped[0], N);
  ctx.beginPath();
  ctx.moveTo(first.px, first.py);

  for (let i = 1; i < clipped.length; i++) {
    const p = projXY(clipped[i], N);
    ctx.lineTo(p.px, p.py);
  }
  ctx.closePath();

  if (opts.fill) {
    ctx.fillStyle = opts.fill;
    ctx.fill('evenodd');
  }
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = opts.width ?? 2;
    ctx.stroke();
  }

  ctx.restore();
}

// Get cell info from pixel coordinates
export function getCellAtPixel(face, px, py, N, step) {
  const [lon, lat] = pixelToLonLat(face, px, py, N);
  const { lonIdx, latIdx } = findGraticuleCellIndex(lon, lat, step);
  return { lon, lat, lonIdx, latIdx, face };
}

// Get the lon/lat bounds of a face by projecting its edges
export function getFaceBounds(face) {
  const samples = 20;
  let minLon = 180, maxLon = -180;
  let minLat = 90, maxLat = -90;

  // Sample the 4 edges of the face square in normalized coords (-1 to 1)
  const edges = [
    // bottom edge (y = -1)
    Array.from({length: samples}, (_, i) => [
      -1 + (2 * i / (samples - 1)), -1
    ]),
    // top edge (y = 1)
    Array.from({length: samples}, (_, i) => [
      -1 + (2 * i / (samples - 1)), 1
    ]),
    // left edge (x = -1)
    Array.from({length: samples}, (_, i) => [
      -1, -1 + (2 * i / (samples - 1))
    ]),
    // right edge (x = 1)
    Array.from({length: samples}, (_, i) => [
      1, -1 + (2 * i / (samples - 1))
    ]),
  ];

  for (const edge of edges) {
    for (const [x, y] of edge) {
      const p = [
        x * FACE_FRAMES[face].east[0] + y * FACE_FRAMES[face].north[0] + FACE_FRAMES[face].normal[0],
        x * FACE_FRAMES[face].east[1] + y * FACE_FRAMES[face].north[1] + FACE_FRAMES[face].normal[1],
        x * FACE_FRAMES[face].east[2] + y * FACE_FRAMES[face].north[2] + FACE_FRAMES[face].normal[2],
      ];
      const [lon, lat] = sphericalToLonLat(p);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  }

  return { minLon, maxLon, minLat, maxLat };
}

// Check if a point is within a face's lon/lat bounds
function isPointInFaceBounds(face, lon, lat, bounds) {
  // For most faces, simple AABB check works
  if (bounds.minLon <= bounds.maxLon) {
    return lon >= bounds.minLon && lon <= bounds.maxLon &&
           lat >= bounds.minLat && lat <= bounds.maxLat;
  }
  // Faces that wrap longitude (e.g., near ±180°)
  return (lon >= bounds.minLon || lon <= bounds.maxLon) &&
         lat >= bounds.minLat && lat <= bounds.maxLat;
}

// Cache face bounds
const faceBoundsCache = {};
export function getCachedFaceBounds(face) {
  if (!faceBoundsCache[face]) {
    faceBoundsCache[face] = getFaceBounds(face);
  }
  return faceBoundsCache[face];
}

// Get polylines that define a face boundary
export function getFaceBoundaryPolylines(face, samples = 30) {
  const polylines = [];
  const samplePoints = [];

  // Sample the 4 edges of the face square
  const edges = [
    // bottom edge (y = -1)
    Array.from({length: samples}, (_, i) => [-1 + (2*i/(samples-1)), -1]),
    // right edge (x = 1)
    Array.from({length: samples}, (_, i) => [1, -1 + (2*i/(samples-1))]),
    // top edge (y = 1)
    Array.from({length: samples}, (_, i) => [1 - (2*i/(samples-1)), 1]),
    // left edge (x = -1)
    Array.from({length: samples}, (_, i) => [-1, 1 - (2*i/(samples-1))]),
  ];

  for (const edge of edges) {
    const ring = [];
    for (const [x, y] of edge) {
      const p = [
        x * FACE_FRAMES[face].east[0] + y * FACE_FRAMES[face].north[0] + FACE_FRAMES[face].normal[0],
        x * FACE_FRAMES[face].east[1] + y * FACE_FRAMES[face].north[1] + FACE_FRAMES[face].normal[1],
        x * FACE_FRAMES[face].east[2] + y * FACE_FRAMES[face].north[2] + FACE_FRAMES[face].normal[2],
      ];
      const [lon, lat] = sphericalToLonLat(p);
      ring.push([lon, lat]);
    }
    polylines.push(ring);
  }

  return polylines;
}
