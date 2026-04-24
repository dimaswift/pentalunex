/**
 * Q3C / Quadrilateralised Spherical Cube projection
 * Pure gnomonic (tangent plane) per face — no polynomial approximation.
 * Based on q3c source (Koposov & Bartunov).
 *
 * Face numbering:
 *   0 = North pole
 *   1 = ra=0°   (+X)
 *   2 = ra=90°  (+Y)
 *   3 = ra=180° (-X)
 *   4 = ra=270° (-Y)
 *   5 = South pole
 *
 * x, y ∈ [-1, +1]  (Q3C internally uses [-0.5,0.5]; we scale ×2)
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;


// Internal: ra in [0,360), dec in [-90,90]
function _project(ra, dec) {
  const dec1 = dec * DEG;
  const td1  = Math.tan(dec1);

  // Determine equatorial face candidate
  let face_num = Math.floor((ra + 45) / 90) % 4; // 0..3
  const ra1 = (ra - 90 * face_num) * DEG;
  let x0 = Math.tan(ra1);
  let y0 = td1 / Math.cos(ra1);
  face_num += 1; // now 1..4

  if (y0 > 1) {
    // North polar face
    face_num = 0;
    const r1 = ra * DEG;
    const tmp = 1 / td1;
    x0 =  Math.sin(r1) * tmp;   //  sin(ra)/tan(dec)
    y0 = -Math.cos(r1) * tmp;   // -cos(ra)/tan(dec)
  } else if (y0 < -1) {
    // South polar face
    face_num = 5;
    const r1 = ra * DEG;
    const tmp = 1 / td1;
    x0 = -Math.sin(r1) * tmp;   // -sin(ra)/tan(dec)
    y0 = -Math.cos(r1) * tmp;   // -cos(ra)/tan(dec)
  }

  // Q3C stores x,y in [-0.5, 0.5]; we use [-1, 1]
  return { face: face_num, x: x0, y: y0 };
}

export function latLonToFaceXY(lat, lon) {
  const ra = ((lon % 360) + 360) % 360;
  return _project(ra, lat);
}

export function faceXYToLatLon(face, x, y) {
  // x,y in [-1,1] → gnomonic coords on that face's tangent plane
  let ra, dec;

  if (face === 0) {
    // North: x = sin(ra)/tan(dec), y = -cos(ra)/tan(dec)
    // => ra = atan2(x, -y),  tan(dec) = 1/sqrt(x²+y²)
    ra  = Math.atan2(x, -y) * RAD;
    dec = Math.atan2(1, Math.sqrt(x*x + y*y)) * RAD;
  } else if (face === 5) {
    // South: x = -sin(ra)/tan(dec), y = -cos(ra)/tan(dec)
    // => ra = atan2(-x, -y),  tan(dec) = -1/sqrt(x²+y²)
    ra  = Math.atan2(-x, -y) * RAD;
    dec = Math.atan2(-1, Math.sqrt(x*x + y*y)) * RAD;
  } else {
    // Equatorial faces 1-4
    // x = tan(ra - ra_centre),  y = tan(dec)/cos(ra - ra_centre)
     const ra_centre = (face - 1) * 90;  // face1→0°, face2→90°, face3→180°, face4→270°
    const dra_rad = Math.atan(x);
    const dra_deg = dra_rad * RAD;
    ra  = ra_centre + dra_deg;
    dec = Math.atan(y * Math.cos(dra_rad)) * RAD;
  }

  // Normalise ra to [0, 360)
  ra = ((ra % 360) + 360) % 360;
  // Convert ra back to lon in (-180, 180]
  const lon = ra > 180 ? ra - 360 : ra;

  return { lat: dec, lon };
}

export function faceXYToPixel(x, y, N) {
  return {
    col: Math.min(N-1, Math.floor((1 + x) / 2 * N)),
    row: Math.min(N-1, Math.floor((1 - y) / 2 * N)),
  };
}



export function pixelToFaceXY(col, row, N) {
  return {
    x: (col + 0.5) / N * 2 - 1,
    y: 1 - (row + 0.5) / N * 2,
  };
}