import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_NAMES,
  FACE_EDGE_ADJACENCY,
  ISO_TILES,
  addressKey,
  cubeFacePoint,
  faceUVToLonLat,
  faceUVToVector,
  isoChirality,
  isoCornerForFaceOrientation,
  isoProjectFaceUV,
  lonDelta,
  lonLatToCubeVector,
  lonLatToFaceUV,
  lonLatToTriAddress,
  mapFaceEdgeUV,
  neighborTriangleAddress,
  packPath,
  poleCornerForFace,
  projectionOrientation,
  splitDiagonalForFace,
  triAddressToLonLat,
  triAddressToUV,
  triangleVerticesFromAddress,
  unpackPath,
  uvToTriAddress,
} from "../src/spherecube.js";

test("lon/lat round-trips through owning face UV", () => {
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lon = -170; lon <= 170; lon += 10) {
      const projected = lonLatToFaceUV(lon, lat);
      assert.ok(projected.face >= 0 && projected.face < 6);
      assert.ok(projected.u >= -1e-9 && projected.u <= 1 + 1e-9);
      assert.ok(projected.v >= -1e-9 && projected.v <= 1 + 1e-9);
      const roundTrip = faceUVToLonLat(projected.face, projected.u, projected.v);
      assert.ok(Math.abs(lonDelta(roundTrip.lon, lon)) < 1e-9, `${lon},${lat} lon -> ${roundTrip.lon}`);
      assert.ok(Math.abs(roundTrip.lat - lat) < 1e-9, `${lon},${lat} lat -> ${roundTrip.lat}`);
    }
  }
});

test("sphere poles are oriented onto opposite cube vertices", () => {
  const north = lonLatToCubeVector(0, 90);
  const south = lonLatToCubeVector(0, -90);
  const r = 1 / Math.sqrt(3);
  assert.ok(Math.abs(north[0] - r) < 1e-12);
  assert.ok(Math.abs(north[1] + r) < 1e-12);
  assert.ok(Math.abs(north[2] - r) < 1e-12);
  assert.ok(Math.abs(south[0] + r) < 1e-12);
  assert.ok(Math.abs(south[1] - r) < 1e-12);
  assert.ok(Math.abs(south[2] + r) < 1e-12);
});

test("variant 0 split diagonal includes that face's pole corner", () => {
  for (let face = 0; face < 6; face += 1) {
    const pole = poleCornerForFace(face);
    const diagonal = splitDiagonalForFace(face, undefined, 0);
    assert.ok(
      diagonal.some(([u, v]) => u === pole.u && v === pole.v),
      `face ${face} pole ${JSON.stringify(pole)} diagonal ${JSON.stringify(diagonal)}`,
    );
  }
});

test("variant 1 split is the opposite diagonal of variant 0", () => {
  for (let face = 0; face < 6; face += 1) {
    const d0 = splitDiagonalForFace(face, undefined, 0).map((p) => p.join(","));
    const d1 = splitDiagonalForFace(face, undefined, 1).map((p) => p.join(","));
    assert.notDeepEqual(new Set(d0), new Set(d1), `F${face} variants share a diagonal`);
  }
});

test("isometric atlas exposes 12 equilateral variants with variant-aware split", () => {
  assert.equal(ISO_TILES.length, 12);
  for (let face = 0; face < 6; face += 1) {
    assert.equal(ISO_TILES.filter((tile) => tile.face === face).length, 2);
    for (let variant = 0; variant < 2; variant += 1) {
      const corners = [
        isoProjectFaceUV(face, 0, 0, variant),
        isoProjectFaceUV(face, 1, 0, variant),
        isoProjectFaceUV(face, 1, 1, variant),
        isoProjectFaceUV(face, 0, 1, variant),
      ];
      const side = distance(corners[0], corners[1]);
      const diagonal = splitDiagonalForFace(face, undefined, variant).map(([u, v]) => isoProjectFaceUV(face, u, v, variant));
      assert.ok(Math.abs(distance(diagonal[0], diagonal[1]) - side) < 1e-12, `F${face}.${variant} split is equilateral`);
    }
  }
});

test("the 12 atlas tiles are pairwise distinct under rotation and 180-flip", () => {
  // Each tile is characterized by the ordered sequence of world points it puts
  // at the rhombus corners. Two tiles that share the same set of world corners
  // are 180-rotation duplicates; both must not occur in the atlas.
  const fingerprints = ISO_TILES.map((tile) => {
    const cubeCorners = [
      cubeFacePoint(tile.face, 0, 0),
      cubeFacePoint(tile.face, 1, 0),
      cubeFacePoint(tile.face, 1, 1),
      cubeFacePoint(tile.face, 0, 1),
    ];
    const isoCorners = cubeCorners.map((corner) => isoProjectFaceUV(tile.face, ...uvFromCornerIndex(0), tile.orientation));
    // Sort the four cube vertices by their iso-y then iso-x to get a
    // rotation-invariant fingerprint per tile. Two tiles match iff their cube
    // corners coincide AND their iso layout is the same modulo translation.
    const pairs = cubeCorners.map((corner, index) => ({
      corner: corner.map((value) => Math.round(value * 1000)).join(","),
      iso: [
        Math.round(isoProjectFaceUV(tile.face, ...uvFromCornerIndex(index), tile.orientation)[0] * 1000),
        Math.round(isoProjectFaceUV(tile.face, ...uvFromCornerIndex(index), tile.orientation)[1] * 1000),
      ].join(","),
    }));
    pairs.sort((a, b) => (a.corner > b.corner ? 1 : -1));
    return pairs.map((pair) => `${pair.corner}@${pair.iso}`).join("|");
  });
  const unique = new Set(fingerprints);
  assert.equal(unique.size, 12, `expected 12 distinct atlas fingerprints, got ${unique.size}`);
});

function uvFromCornerIndex(index) {
  return [[0, 0], [1, 0], [1, 1], [0, 1]][index];
}

test("triangular address round-trips UV for both root polarities", () => {
  const samples = [
    [0.12, 0.87],
    [0.2, 0.31],
    [0.48, 0.49],
    [0.76, 0.34],
    [0.92, 0.96],
  ];
  for (const [u, v] of samples) {
    for (let depth = 0; depth <= 6; depth += 1) {
      const address = uvToTriAddress(2, u, v, depth);
      const [actualU, actualV] = triAddressToUV(address);
      assert.ok(Math.abs(actualU - u) < 1e-10, `${u},${v} depth ${depth} u -> ${actualU}`);
      assert.ok(Math.abs(actualV - v) < 1e-10, `${u},${v} depth ${depth} v -> ${actualV}`);
      assert.equal(address.path.length, depth);
    }
  }
});

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

test("spherical triangular address round-trips lon/lat", () => {
  const points = [
    [0, 0],
    [74.5, 32.25],
    [-122.41, 37.77],
    [179.2, -12.5],
    [-12, 70],
  ];
  for (const [lon, lat] of points) {
    const address = lonLatToTriAddress(lon, lat, 5);
    const roundTrip = triAddressToLonLat(address);
    assert.ok(Math.abs(lonDelta(roundTrip.lon, lon)) < 1e-9);
    assert.ok(Math.abs(roundTrip.lat - lat) < 1e-9);
  }
});

test("offset projection anchor still round-trips lon/lat", () => {
  const orientation = projectionOrientation({ lon: 45, lat: -15, roll: 30 });
  const points = [
    [0, 0],
    [120, 22],
    [-80, -35],
  ];
  for (const [lon, lat] of points) {
    const address = lonLatToTriAddress(lon, lat, 4, orientation);
    const roundTrip = triAddressToLonLat(address, orientation);
    assert.ok(Math.abs(lonDelta(roundTrip.lon, lon)) < 1e-9);
    assert.ok(Math.abs(roundTrip.lat - lat) < 1e-9);
  }
});

test("path packing uses two bits per child", () => {
  const path = [0, 3, 1, 2, 2, 1, 0, 3];
  const packed = packPath(path);
  assert.deepEqual(unpackPath(packed, path.length), path);
});

test("face edge adjacency is reciprocal", () => {
  for (let face = 0; face < 6; face += 1) {
    for (const edge of EDGE_NAMES) {
      const link = FACE_EDGE_ADJACENCY[face][edge];
      const back = FACE_EDGE_ADJACENCY[link.toFace][link.toEdge];
      assert.equal(back.toFace, face, `F${face} ${edge} -> F${link.toFace} ${link.toEdge} back face`);
      assert.equal(back.toEdge, edge, `F${face} ${edge} -> F${link.toFace} ${link.toEdge} back edge`);
    }
  }
});

test("iso chirality matches the numerical Jacobian sign and equals -cornerParity", () => {
  for (let face = 0; face < 6; face += 1) {
    for (let variant = 0; variant < 2; variant += 1) {
      const p00 = isoProjectFaceUV(face, 0, 0, variant);
      const p10 = isoProjectFaceUV(face, 1, 0, variant);
      const p01 = isoProjectFaceUV(face, 0, 1, variant);
      const cross = (p10[0] - p00[0]) * (p01[1] - p00[1]) - (p10[1] - p00[1]) * (p01[0] - p00[0]);
      const numericalSign = Math.sign(cross);
      const corner = isoCornerForFaceOrientation(face, variant);
      const cornerParity = corner[0] * corner[1] * corner[2];
      assert.equal(isoChirality(face, variant), numericalSign, `F${face}.${variant} chirality mismatch`);
      assert.equal(isoChirality(face, variant), -cornerParity, `F${face}.${variant} chirality != -parity`);
    }
  }
});

test("triangle neighbors are reciprocal across faces and variants", () => {
  function enumeratePaths(depth) {
    if (depth === 0) return [[]];
    const out = [];
    for (const prefix of enumeratePaths(depth - 1)) {
      for (let child = 0; child < 4; child += 1) out.push([...prefix, child]);
    }
    return out;
  }
  for (let depth = 0; depth <= 2; depth += 1) {
    for (let face = 0; face < 6; face += 1) {
      for (let variant = 0; variant < 2; variant += 1) {
        for (let root = 0; root < 2; root += 1) {
          for (const path of enumeratePaths(depth)) {
            const addr = { face, variant, root, depth, path };
            for (let edge = 0; edge < 3; edge += 1) {
              const neighbor = neighborTriangleAddress(addr, edge, depth);
              let back = -1;
              for (let e = 0; e < 3; e += 1) {
                const candidate = neighborTriangleAddress(neighbor, e, depth, undefined, variant);
                if (addressKey(candidate) === addressKey(addr)) { back = e; break; }
              }
              assert.notEqual(back, -1, `F${face}.${variant} r${root} d${depth} ${path.join("")} e${edge} has no back edge from ${addressKey(neighbor)}`);
            }
          }
        }
      }
    }
  }
});

test("triangle edges across face boundaries share a world-space segment", () => {
  // Adjacent triangles must share a physical edge in cube space, so projecting
  // the matched edge endpoints from each face must land on identical cube
  // points. This is the seamless-tiling guarantee.
  for (let face = 0; face < 6; face += 1) {
    for (let variant = 0; variant < 2; variant += 1) {
      for (let root = 0; root < 2; root += 1) {
        const addr = { face, variant, root, depth: 0, path: [] };
        const verts = triangleVerticesFromAddress(addr);
        for (let edge = 0; edge < 3; edge += 1) {
          const a = verts[(edge + 1) % 3];
          const b = verts[(edge + 2) % 3];
          const neighbor = neighborTriangleAddress(addr, edge, 0);
          if (neighbor.face === face) continue;
          const aVec = faceUVToVector(face, a[0], a[1]);
          const bVec = faceUVToVector(face, b[0], b[1]);
          const nVerts = triangleVerticesFromAddress(neighbor);
          // Endpoint a must match one of the neighbor triangle vertices, and b another.
          const matches = nVerts.map(([u, v]) => faceUVToVector(neighbor.face, u, v));
          const matchA = matches.some((m) => Math.hypot(m[0] - aVec[0], m[1] - aVec[1], m[2] - aVec[2]) < 1e-9);
          const matchB = matches.some((m) => Math.hypot(m[0] - bVec[0], m[1] - bVec[1], m[2] - bVec[2]) < 1e-9);
          assert.ok(matchA && matchB, `F${face}.${variant} r${root} edge ${edge} -> F${neighbor.face}.${neighbor.variant} r${neighbor.root} does not share endpoints`);
        }
      }
    }
  }
});

test("edge UV mapping stays on target face boundary", () => {
  for (let face = 0; face < 6; face += 1) {
    for (const edge of EDGE_NAMES) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const mapped = mapFaceEdgeUV(face, edge, t);
        assert.ok(mapped.face >= 0 && mapped.face < 6);
        const onVertical = Math.abs(mapped.u) < 1e-10 || Math.abs(mapped.u - 1) < 1e-10;
        const onHorizontal = Math.abs(mapped.v) < 1e-10 || Math.abs(mapped.v - 1) < 1e-10;
        assert.ok(onVertical || onHorizontal, `mapped edge point is on boundary: ${JSON.stringify(mapped)}`);
      }
    }
  }
});
