import test from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_NAMES,
  FACE_EDGE_ADJACENCY,
  ISO_TILES,
  faceUVToLonLat,
  isoProjectFaceUV,
  lonDelta,
  lonLatToCubeVector,
  lonLatToFaceUV,
  lonLatToTriAddress,
  mapFaceEdgeUV,
  packPath,
  poleCornerForFace,
  projectionOrientation,
  splitDiagonalForFace,
  triAddressToLonLat,
  triAddressToUV,
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

test("each face split diagonal includes that face's pole corner", () => {
  for (let face = 0; face < 6; face += 1) {
    const pole = poleCornerForFace(face);
    const diagonal = splitDiagonalForFace(face);
    assert.ok(
      diagonal.some(([u, v]) => u === pole.u && v === pole.v),
      `face ${face} pole ${JSON.stringify(pole)} diagonal ${JSON.stringify(diagonal)}`,
    );
  }
});

test("isometric atlas exposes two equilateral variants per face", () => {
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
      const diagonal = splitDiagonalForFace(face).map(([u, v]) => isoProjectFaceUV(face, u, v, variant));
      assert.ok(Math.abs(distance(diagonal[0], diagonal[1]) - side) < 1e-12, `F${face}.${variant} split is equilateral`);
    }
  }
});

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
