export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const EPSILON = 1e-10;

export const FACE_NAMES = [
  "+Z",
  "+X (0 deg)",
  "+Y (90E)",
  "-X (180)",
  "-Y (270E)",
  "-Z",
];

export const FACE_FRAMES = [
  { east: [0, 1, 0], north: [-1, 0, 0], normal: [0, 0, 1] },
  { east: [0, 1, 0], north: [0, 0, 1], normal: [1, 0, 0] },
  { east: [-1, 0, 0], north: [0, 0, 1], normal: [0, 1, 0] },
  { east: [0, -1, 0], north: [0, 0, 1], normal: [-1, 0, 0] },
  { east: [1, 0, 0], north: [0, 0, 1], normal: [0, -1, 0] },
  { east: [0, -1, 0], north: [-1, 0, 0], normal: [0, 0, -1] },
];

export const EDGE_NAMES = ["top", "right", "bottom", "left"];

export const SPHERE_ORIENTATION = {
  name: "cube-vertex-poles",
  lon: 0,
  lat: Math.atan(1 / Math.sqrt(2)) * RAD,
  roll: 45,
  northCubeVertex: [1, -1, 1],
  southCubeVertex: [-1, 1, -1],
};

export function projectionOrientation(offset = {}) {
  const lonOffset = Number(offset.lon ?? 0);
  const latOffset = Number(offset.lat ?? 0);
  const rollOffset = Number(offset.roll ?? 0);
  return {
    ...SPHERE_ORIENTATION,
    name: "cube-vertex-poles-offset",
    base: {
      lon: SPHERE_ORIENTATION.lon,
      lat: SPHERE_ORIENTATION.lat,
      roll: SPHERE_ORIENTATION.roll,
    },
    offsets: {
      lon: lonOffset,
      lat: latOffset,
      roll: rollOffset,
    },
    lon: SPHERE_ORIENTATION.lon + lonOffset,
    lat: SPHERE_ORIENTATION.lat + latOffset,
    roll: SPHERE_ORIENTATION.roll + rollOffset,
  };
}

const ROOT_TRIANGLE_SCHEMES = {
  main: [
    {
      name: "left",
      vertices: [
        [0, 0],
        [1, 1],
        [0, 1],
      ],
    },
    {
      name: "right",
      vertices: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    },
  ],
  anti: [
    {
      name: "left",
      vertices: [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    },
    {
      name: "right",
      vertices: [
        [1, 1],
        [0, 1],
        [1, 0],
      ],
    },
  ],
};

export const ISO_TILES = Array.from({ length: 12 }, (_, tile) => ({
  tile,
  face: Math.floor(tile / 2),
  orientation: tile % 2,
}));

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeLon180(lon) {
  const value = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(value, -180) ? 180 : value;
}

export function lonDelta(a, b) {
  return normalizeLon180(a - b);
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale3(a, value) {
  return [a[0] * value, a[1] * value, a[2] * value];
}

export function normalize3(a) {
  const length = Math.hypot(a[0], a[1], a[2]);
  if (length <= EPSILON) throw new Error("Cannot normalize a zero-length vector");
  return [a[0] / length, a[1] / length, a[2] / length];
}

export function lonLatToVector(lon, lat) {
  const lo = lon * DEG;
  const la = lat * DEG;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

export function rotateX(p, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

export function rotateY(p, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

export function rotateZ(p, deg) {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

export function sphericalVectorToCubeVector(vector, orientation = SPHERE_ORIENTATION) {
  return rotateX(
    rotateY(rotateZ(vector, orientation.lon), orientation.lat),
    orientation.roll,
  );
}

export function cubeVectorToSphericalVector(vector, orientation = SPHERE_ORIENTATION) {
  return rotateZ(
    rotateY(rotateX(vector, -orientation.roll), -orientation.lat),
    -orientation.lon,
  );
}

export function lonLatToCubeVector(lon, lat, orientation = SPHERE_ORIENTATION) {
  return sphericalVectorToCubeVector(lonLatToVector(lon, lat), orientation);
}

export function vectorToLonLat(vector) {
  const p = normalize3(vector);
  return {
    lon: normalizeLon180(Math.atan2(p[1], p[0]) * RAD),
    lat: Math.asin(clamp(p[2], -1, 1)) * RAD,
  };
}

export function owningFaceForVector(vector) {
  let bestFace = 0;
  let bestDot = -Infinity;
  for (let face = 0; face < FACE_FRAMES.length; face += 1) {
    const score = dot(vector, FACE_FRAMES[face].normal);
    if (score > bestDot) {
      bestDot = score;
      bestFace = face;
    }
  }
  return bestFace;
}

export function toFaceXYZ(face, vector) {
  const frame = FACE_FRAMES[face];
  return [
    dot(vector, frame.east),
    dot(vector, frame.north),
    dot(vector, frame.normal),
  ];
}

export function fromFaceXYZ(face, xyz) {
  const frame = FACE_FRAMES[face];
  return [
    frame.east[0] * xyz[0] + frame.north[0] * xyz[1] + frame.normal[0] * xyz[2],
    frame.east[1] * xyz[0] + frame.north[1] * xyz[1] + frame.normal[1] * xyz[2],
    frame.east[2] * xyz[0] + frame.north[2] * xyz[1] + frame.normal[2] * xyz[2],
  ];
}

export function vectorToFaceXY(face, vector) {
  const [x, y, z] = toFaceXYZ(face, vector);
  if (Math.abs(z) <= EPSILON) throw new Error(`Point lies on the horizon for face ${face}`);
  return { x: x / z, y: y / z };
}

export function xyToUV(x, y) {
  return {
    u: (x + 1) * 0.5,
    v: (1 - y) * 0.5,
  };
}

export function uvToXY(u, v) {
  return {
    x: u * 2 - 1,
    y: 1 - v * 2,
  };
}

export function vectorToFaceUV(face, vector) {
  const { x, y } = vectorToFaceXY(face, vector);
  return xyToUV(x, y);
}

export function faceUVToVector(face, u, v) {
  const { x, y } = uvToXY(u, v);
  return normalize3(fromFaceXYZ(face, [x, y, 1]));
}

export function lonLatToFaceUV(lon, lat, forcedFace = null, orientation = SPHERE_ORIENTATION) {
  const vector = lonLatToCubeVector(lon, lat, orientation);
  const face = forcedFace == null ? owningFaceForVector(vector) : forcedFace;
  const { x, y } = vectorToFaceXY(face, vector);
  const { u, v } = xyToUV(x, y);
  return { face, u, v, x, y };
}

export function faceUVToLonLat(face, u, v, orientation = SPHERE_ORIENTATION) {
  return vectorToLonLat(cubeVectorToSphericalVector(faceUVToVector(face, u, v), orientation));
}

export function edgeUV(edge, t) {
  switch (edge) {
    case "top":
      return [t, 0];
    case "right":
      return [1, t];
    case "bottom":
      return [1 - t, 1];
    case "left":
      return [0, 1 - t];
    default:
      throw new Error(`Unknown edge: ${edge}`);
  }
}

export function edgeParameter(edge, u, v) {
  switch (edge) {
    case "top":
      return u;
    case "right":
      return v;
    case "bottom":
      return 1 - u;
    case "left":
      return 1 - v;
    default:
      throw new Error(`Unknown edge: ${edge}`);
  }
}

function outsideEdgeUV(edge, t, epsilon = 1e-5) {
  const [u, v] = edgeUV(edge, t);
  if (edge === "top") return [u, v - epsilon];
  if (edge === "right") return [u + epsilon, v];
  if (edge === "bottom") return [u, v + epsilon];
  return [u - epsilon, v];
}

function closestEdgeForUV(u, v) {
  const candidates = [
    ["top", Math.abs(v)],
    ["right", Math.abs(1 - u)],
    ["bottom", Math.abs(1 - v)],
    ["left", Math.abs(u)],
  ];
  candidates.sort((a, b) => a[1] - b[1]);
  return candidates[0][0];
}

export function buildFaceAdjacency() {
  const table = {};
  for (let face = 0; face < FACE_FRAMES.length; face += 1) {
    table[face] = {};
    for (const edge of EDGE_NAMES) {
      const [outsideU, outsideV] = outsideEdgeUV(edge, 0.5);
      const neighborVector = faceUVToVector(face, outsideU, outsideV);
      const toFace = owningFaceForVector(neighborVector);

      const [u0, v0] = edgeUV(edge, 0);
      const [u1, v1] = edgeUV(edge, 1);
      const end0 = vectorToFaceUV(toFace, faceUVToVector(face, u0, v0));
      const end1 = vectorToFaceUV(toFace, faceUVToVector(face, u1, v1));
      const toEdge = closestEdgeForUV(
        (end0.u + end1.u) * 0.5,
        (end0.v + end1.v) * 0.5,
      );
      const t0 = edgeParameter(toEdge, end0.u, end0.v);
      const t1 = edgeParameter(toEdge, end1.u, end1.v);

      table[face][edge] = {
        face,
        edge,
        toFace,
        toEdge,
        reversed: t1 < t0,
      };
    }
  }
  return table;
}

export const FACE_EDGE_ADJACENCY = buildFaceAdjacency();

export function mapFaceEdgeUV(face, edge, t) {
  const link = FACE_EDGE_ADJACENCY[face][edge];
  const targetT = link.reversed ? 1 - t : t;
  const [u, v] = edgeUV(link.toEdge, targetT);
  return { face: link.toFace, edge: link.toEdge, u, v, reversed: link.reversed };
}

export function poleCornerForFace(face, orientation = SPHERE_ORIENTATION) {
  const north = lonLatToCubeVector(0, 90, orientation);
  const south = lonLatToCubeVector(0, -90, orientation);
  const northFace = toFaceXYZ(face, north);
  const southFace = toFaceXYZ(face, south);
  const vector = northFace[2] >= southFace[2] ? north : south;
  const pole = northFace[2] >= southFace[2] ? "north" : "south";
  const { u, v } = vectorToFaceUV(face, vector);
  return {
    pole,
    u: Math.round(clamp(u, 0, 1)),
    v: Math.round(clamp(v, 0, 1)),
  };
}

function variantScheme(scheme, variant) {
  if (((Number(variant) % 2) + 2) % 2 !== 1) return scheme;
  return scheme === "main" ? "anti" : "main";
}

export function splitSchemeForFace(face, orientation = SPHERE_ORIENTATION, variant = 0) {
  const corner = poleCornerForFace(face, orientation);
  const base = corner.u === corner.v ? "main" : "anti";
  return variantScheme(base, variant);
}

export function splitDiagonalForFace(face, orientation = SPHERE_ORIENTATION, variant = 0) {
  return splitSchemeForFace(face, orientation, variant) === "main"
    ? [[0, 0], [1, 1]]
    : [[0, 1], [1, 0]];
}

export function faceUVToPoleAlignedUV(face, u, v, orientation = SPHERE_ORIENTATION) {
  const pole = poleCornerForFace(face, orientation);
  return {
    u: pole.u === 0 ? u : 1 - u,
    v: pole.v === 0 ? v : 1 - v,
  };
}

export function poleAlignedUVToFaceUV(face, u, v, orientation = SPHERE_ORIENTATION) {
  const pole = poleCornerForFace(face, orientation);
  return {
    u: pole.u === 0 ? u : 1 - u,
    v: pole.v === 0 ? v : 1 - v,
  };
}

export function rootTriangleForUV(face, u, v, orientation = SPHERE_ORIENTATION, variant = 0) {
  return splitSchemeForFace(face, orientation, variant) === "main"
    ? (u <= v ? 0 : 1)
    : (u + v <= 1 ? 0 : 1);
}

export function rootTriangleVertices(face, root, orientation = SPHERE_ORIENTATION, variant = 0) {
  return ROOT_TRIANGLE_SCHEMES[splitSchemeForFace(face, orientation, variant)][root].vertices.map((point) => point.slice());
}

export function rootTriangleName(face, root, orientation = SPHERE_ORIENTATION, variant = 0) {
  return ROOT_TRIANGLE_SCHEMES[splitSchemeForFace(face, orientation, variant)][root]?.name ?? "unknown";
}

export function barycentricForTriangle(point, vertices) {
  const [a, b, c] = vertices;
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(det) <= EPSILON) throw new Error("Cannot compute barycentric coordinates for a degenerate triangle");
  const w0 = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / det;
  const w1 = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / det;
  const w2 = 1 - w0 - w1;
  return normalizeBarycentric([w0, w1, w2]);
}

export function normalizeBarycentric(barycentric) {
  const cleaned = barycentric.map((value) => (Math.abs(value) < EPSILON ? 0 : value));
  const sum = cleaned[0] + cleaned[1] + cleaned[2];
  if (Math.abs(sum) <= EPSILON) throw new Error("Cannot normalize a zero-sum barycentric coordinate");
  return cleaned.map((value) => value / sum);
}

export function pointFromBarycentric(barycentric, vertices) {
  return [
    barycentric[0] * vertices[0][0] + barycentric[1] * vertices[1][0] + barycentric[2] * vertices[2][0],
    barycentric[0] * vertices[0][1] + barycentric[1] * vertices[1][1] + barycentric[2] * vertices[2][1],
  ];
}

export function midpoint2(a, b) {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
}

export function childTriangleVertices(vertices, child) {
  const [a, b, c] = vertices;
  const ab = midpoint2(a, b);
  const bc = midpoint2(b, c);
  const ca = midpoint2(c, a);
  switch (child) {
    case 0:
      return [a, ab, ca];
    case 1:
      return [ab, b, bc];
    case 2:
      return [ca, bc, c];
    case 3:
      return [ab, bc, ca];
    default:
      throw new Error(`Child triangle index must be 0..3, got ${child}`);
  }
}

export function childForBarycentric(barycentric) {
  const [a, b, c] = barycentric;
  if (a >= 0.5 - EPSILON) return 0;
  if (b >= 0.5 - EPSILON) return 1;
  if (c >= 0.5 - EPSILON) return 2;
  return 3;
}

export function descendBarycentric(barycentric, child) {
  const [a, b, c] = barycentric;
  let next;
  switch (child) {
    case 0:
      next = [2 * a - 1, 2 * b, 2 * c];
      break;
    case 1:
      next = [2 * a, 2 * b - 1, 2 * c];
      break;
    case 2:
      next = [2 * a, 2 * b, 2 * c - 1];
      break;
    case 3:
      next = [a + b - c, b + c - a, c + a - b];
      break;
    default:
      throw new Error(`Child triangle index must be 0..3, got ${child}`);
  }
  return normalizeBarycentric(next.map((value) => (Math.abs(value) < EPSILON ? 0 : value)));
}

export function triangleVerticesFromAddress(address, orientation = address.orientation ?? SPHERE_ORIENTATION) {
  const variant = address.variant ?? 0;
  let vertices = rootTriangleVertices(address.face, address.root, orientation, variant);
  for (const child of address.path ?? []) {
    vertices = childTriangleVertices(vertices, child);
  }
  return vertices;
}

export function uvToTriAddress(face, u, v, depth = 0, orientation = SPHERE_ORIENTATION, variant = 0) {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`Subdivision depth must be a non-negative integer, got ${depth}`);
  }
  const root = rootTriangleForUV(face, u, v, orientation, variant);
  const path = [];
  let vertices = rootTriangleVertices(face, root, orientation, variant);
  let barycentric = barycentricForTriangle([u, v], vertices);

  for (let level = 0; level < depth; level += 1) {
    const child = childForBarycentric(barycentric);
    path.push(child);
    vertices = childTriangleVertices(vertices, child);
    barycentric = descendBarycentric(barycentric, child);
  }

  return {
    face,
    variant,
    root,
    rootName: rootTriangleName(face, root, orientation, variant),
    depth,
    path,
    pathBits: packPath(path).toString(),
    barycentric,
    uv: [u, v],
    orientation,
  };
}

export function triAddressToUV(address, orientation = address.orientation ?? SPHERE_ORIENTATION) {
  const vertices = triangleVerticesFromAddress(address, orientation);
  return pointFromBarycentric(address.barycentric, vertices);
}

export function lonLatToTriAddress(lon, lat, depth = 0, orientation = SPHERE_ORIENTATION, variant = 0) {
  const projected = lonLatToFaceUV(lon, lat, null, orientation);
  const address = uvToTriAddress(projected.face, projected.u, projected.v, depth, orientation, variant);
  return {
    ...address,
    lon,
    lat,
    xy: [projected.x, projected.y],
  };
}

export function triAddressToLonLat(address, orientation = address.orientation ?? SPHERE_ORIENTATION) {
  const [u, v] = triAddressToUV(address, orientation);
  return faceUVToLonLat(address.face, u, v, orientation);
}

export function packPath(path) {
  let packed = 0n;
  for (const child of path) {
    if (!Number.isInteger(child) || child < 0 || child > 3) {
      throw new Error(`Path child must be 0..3, got ${child}`);
    }
    packed = (packed << 2n) | BigInt(child);
  }
  return packed;
}

export function unpackPath(packed, depth) {
  let value = BigInt(packed);
  const path = Array(depth).fill(0);
  for (let index = depth - 1; index >= 0; index -= 1) {
    path[index] = Number(value & 3n);
    value >>= 2n;
  }
  return path;
}

export function addressKey(address) {
  return `${address.face}:${address.variant ?? 0}:${address.root}:${(address.path ?? []).join("")}`;
}

export function neighborTriangleAddress(
  address,
  edgeIndex,
  depth = address.depth,
  orientation = address.orientation ?? SPHERE_ORIENTATION,
  targetVariant = address.variant ?? 0,
) {
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex > 2) {
    throw new Error(`Triangle edge index must be 0..2, got ${edgeIndex}`);
  }
  const vertices = triangleVerticesFromAddress(address, orientation);
  const opposite = vertices[edgeIndex];
  const a = vertices[(edgeIndex + 1) % 3];
  const b = vertices[(edgeIndex + 2) % 3];
  const midpoint = midpoint2(a, b);
  const direction = [midpoint[0] - opposite[0], midpoint[1] - opposite[1]];
  const length = Math.hypot(direction[0], direction[1]) || 1;
  const scale = Math.max(1e-7, length * 1e-5);
  const probeU = midpoint[0] + (direction[0] / length) * scale;
  const probeV = midpoint[1] + (direction[1] / length) * scale;
  const vector = faceUVToVector(address.face, probeU, probeV);
  const face = owningFaceForVector(vector);
  const { u, v } = vectorToFaceUV(face, vector);
  return uvToTriAddress(face, clamp(u, 0, 1), clamp(v, 0, 1), depth, orientation, targetVariant);
}

export function cubeFacePoint(face, u, v) {
  const { x, y } = uvToXY(u, v);
  return fromFaceXYZ(face, [x, y, 1]);
}

// Variant 1's viewing corner is the 90-degree neighbor of variant 0 on the same
// face (sharing one cube edge). The diagonally-opposite corner would give the
// same rhombus 180-rotated, so all 12 atlas tiles must avoid that pairing.
const ISO_FACE_CORNERS = [
  [[-1, 1, 1], [-1, -1, 1]],
  [[1, -1, 1], [1, -1, -1]],
  [[-1, 1, -1], [-1, 1, 1]],
  [[-1, -1, 1], [-1, 1, 1]],
  [[-1, -1, -1], [1, -1, -1]],
  [[-1, 1, -1], [1, 1, -1]],
];

export function isoCornerForFaceOrientation(face, orientation = 0) {
  const variant = ((Number(orientation) % 2) + 2) % 2;
  return ISO_FACE_CORNERS[face][variant].slice();
}

export function isoProjectVector(vector, corner = [1, 1, 1]) {
  const x = vector[0] * corner[0];
  const y = vector[1] * corner[1];
  const z = vector[2] * corner[2];
  return [
    (x - y) * Math.sqrt(3) * 0.5,
    (x + y) * 0.5 - z,
  ];
}

export function isoProjectFaceUV(face, u, v, orientation = 0) {
  const corner = isoCornerForFaceOrientation(face, orientation);
  return isoProjectVector(cubeFacePoint(face, u, v), corner);
}

export function traceTrajectoryLonLat(points, depth = 0, maxStepDeg = 1, orientation = SPHERE_ORIENTATION) {
  const samples = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [lon0, lat0] = points[index];
    const [lon1Raw, lat1] = points[index + 1];
    const dLon = lonDelta(lon1Raw, lon0);
    const dLat = lat1 - lat0;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(dLat)) / maxStepDeg));
    for (let step = 0; step <= steps; step += 1) {
      if (index > 0 && step === 0) continue;
      const t = step / steps;
      const lon = normalizeLon180(lon0 + dLon * t);
      const lat = lat0 + dLat * t;
      samples.push(lonLatToTriAddress(lon, lat, depth, orientation));
    }
  }

  const runs = [];
  for (const sample of samples) {
    const key = addressKey(sample);
    const previous = runs[runs.length - 1];
    if (previous?.key === key) {
      previous.samples.push(sample);
    } else {
      runs.push({ key, face: sample.face, root: sample.root, path: sample.path, samples: [sample] });
    }
  }
  return { samples, runs };
}

export function topologyManifest(orientation = SPHERE_ORIENTATION) {
  return {
    version: 1,
    sphereOrientation: orientation,
    faces: FACE_NAMES.map((name, face) => ({ face, name, frame: FACE_FRAMES[face] })),
    isoTiles: ISO_TILES.map((tile) => ({
      ...tile,
      corner: isoCornerForFaceOrientation(tile.face, tile.orientation),
    })),
    faceEdgeAdjacency: FACE_EDGE_ADJACENCY,
    poleCorners: FACE_NAMES.map((_, face) => ({ face, ...poleCornerForFace(face, orientation) })),
    splitDiagonals: FACE_NAMES.flatMap((_, face) => [0, 1].map((variant) => ({
      face,
      variant,
      scheme: splitSchemeForFace(face, orientation, variant),
      diagonal: splitDiagonalForFace(face, orientation, variant),
    }))),
    rootTriangleSchemes: ROOT_TRIANGLE_SCHEMES,
  };
}
