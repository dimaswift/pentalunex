import test from "node:test";
import assert from "node:assert/strict";
import {
  createTriangleManifest,
  enumerateTriangleAddresses,
  renderBacksideSvg,
  renderTriangleSvg,
  tileBacksideLabel,
} from "../src/exporter.js";
import { lonLatToTriAddress } from "../src/spherecube.js";

const style = {
  ocean: "#102725",
  land: "#b9b39f",
  coast: "#f0dcc0",
  coastWidth: 0.7,
};

test("enumerates every face/root triangle at a selected depth", () => {
  assert.equal(enumerateTriangleAddresses(0).length, 24);
  assert.equal(enumerateTriangleAddresses(1).length, 96);
  assert.equal(enumerateTriangleAddresses(2).length, 384);
});

test("manifest includes same-chirality and reflection adjacency for mirrored export", () => {
  const addresses = enumerateTriangleAddresses(1).slice(0, 2);
  const manifest = createTriangleManifest(addresses, {
    type: "svg",
    depth: 1,
    mirror: true,
    svgScale: 512,
    pngResolution: 512,
    border: { enabled: true },
    graticule: { enabled: false, color: "#37c8b1", width: 0.6, step: 15, sampleStep: 1 },
    style,
  });
  assert.equal(manifest.triangles.length, 4);
  const original = manifest.triangles.find((triangle) => !triangle.mirrored);
  const mirrored = manifest.triangles.find((triangle) => triangle.mirrored && triangle.reflectionOf === original.id);
  assert.ok(original);
  assert.ok(mirrored);
  assert.equal(manifest.adjacency[original.id].reflection, mirrored.id);
  assert.equal(manifest.adjacency[mirrored.id].reflection, original.id);
  assert.equal(manifest.adjacency[original.id].sameChirality.length, 3);
});

test("selected SVG export contains triangle metadata and map style", () => {
  const address = lonLatToTriAddress(0, 0, 2);
  const svg = renderTriangleSvg(address, [], {
    type: "svg",
    depth: 2,
    mirror: false,
    svgScale: 640,
    pngResolution: 512,
    border: { enabled: true },
    graticule: { enabled: false, color: "#37c8b1", width: 0.6, step: 15, sampleStep: 1 },
    style,
  });
  assert.match(svg, /<svg /);
  assert.match(svg, /data-face="1"/);
  assert.match(svg, /data-variant="0"/);
  assert.match(svg, /width="640"/);
  assert.match(svg, /#102725/);
  assert.doesNotMatch(svg, /clipPath|clip-path|vector-effect/);
  assert.doesNotMatch(svg, /id="graticule"/);
});

test("SVG graticule export adds a clipped stroke layer", () => {
  const address = lonLatToTriAddress(0, 0, 1);
  const svg = renderTriangleSvg(address, [], {
    type: "svg",
    depth: 1,
    mirror: false,
    svgScale: 512,
    pngResolution: 512,
    border: { enabled: true },
    graticule: { enabled: true, color: "#ff00ff", width: 1.2, step: 15, sampleStep: 2 },
    style,
  });
  assert.match(svg, /id="graticule"/);
  assert.match(svg, /stroke="#ff00ff"/);
  assert.match(svg, /stroke-width="1.2"/);
});

test("SVG export can omit coastline border layer", () => {
  const address = lonLatToTriAddress(0, 0, 1);
  const svg = renderTriangleSvg(address, [], {
    type: "svg",
    depth: 1,
    mirror: false,
    svgScale: 512,
    pngResolution: 512,
    border: { enabled: false },
    graticule: { enabled: false, color: "#37c8b1", width: 0.6, step: 15, sampleStep: 1 },
    style,
  });
  assert.doesNotMatch(svg, /id="coastlines"/);
});

test("SVG eclipse export adds a separate clipped path layer", () => {
  const address = lonLatToTriAddress(69.3, 1.6, 0);
  const svg = renderTriangleSvg(address, [], {
    type: "svg",
    depth: 0,
    mirror: false,
    svgScale: 512,
    pngResolution: 512,
    border: { enabled: false },
    graticule: { enabled: false, color: "#37c8b1", width: 0.6, step: 15, sampleStep: 1 },
    style,
    eclipse: {
      sarosNumber: 141,
      sarosPosition: 22,
      datetime_utc: "2010-01-15 07:07:39",
      type: "A",
      stroke: "#ffd16c",
      fill: "#ff8800",
      width: 4.5,
      fillOpacity: 0.25,
      geometry: {
        type: "MultiPolygon",
        coordinates: [[[
          [68, 0],
          [71, 0],
          [71, 4],
          [68, 4],
          [68, 0],
        ]]],
      },
    },
  });
  assert.match(svg, /id="eclipse"/);
  assert.match(svg, /id="eclipse-fill"/);
  assert.match(svg, /id="eclipse-path"/);
  assert.match(svg, /data-saros="141"/);
  assert.match(svg, /stroke="#ffd16c"/);
  assert.match(svg, /fill="#ff8800"/);
  assert.match(svg, /stroke-width="4.5"/);
});

test("SVG eclipse export supports multiple eclipse layers", () => {
  const address = lonLatToTriAddress(69.3, 1.6, 0);
  const baseEclipse = {
    sarosPosition: 22,
    datetime_utc: "2010-01-15 07:07:39",
    type: "A",
    stroke: "#ffd16c",
    fill: "#ff8800",
    width: 4.5,
    fillOpacity: 0.25,
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[
        [68, 0],
        [71, 0],
        [71, 4],
        [68, 4],
        [68, 0],
      ]]],
    },
  };
  const svg = renderTriangleSvg(address, [], {
    type: "svg",
    depth: 0,
    mirror: false,
    svgScale: 512,
    pngResolution: 512,
    border: { enabled: false },
    graticule: { enabled: false, color: "#37c8b1", width: 0.6, step: 15, sampleStep: 1 },
    style,
    eclipses: [
      { ...baseEclipse, sarosNumber: 141 },
      { ...baseEclipse, sarosNumber: 145, stroke: "#ff66aa" },
    ],
  });
  assert.match(svg, /id="eclipses"/);
  assert.match(svg, /data-saros="141"/);
  assert.match(svg, /data-saros="145"/);
  assert.match(svg, /stroke="#ff66aa"/);
});

test("backside SVG contains chirality key and global number", () => {
  const address = lonLatToTriAddress(0, 0, 1);
  const regular = renderBacksideSvg(address, {
    type: "svg",
    depth: 1,
    mirror: false,
    svgScale: 512,
    pngResolution: 512,
    backside: { enabled: true },
    style,
  }, 7);
  const mirrored = renderBacksideSvg(address, {
    type: "svg",
    depth: 1,
    mirror: false,
    mirrored: true,
    svgScale: 512,
    pngResolution: 512,
    backside: { enabled: true },
    style,
  }, 8);
  assert.match(regular, /data-backside="true"/);
  assert.match(regular, /#7/);
  assert.match(regular, new RegExp(tileBacksideLabel(address, false).replaceAll(".", "\\.")));
  assert.match(mirrored, /#8/);
  assert.match(mirrored, new RegExp(tileBacksideLabel(address, true).replaceAll(".", "\\.")));
});

test("manifest records backside file and global tile number", () => {
  const addresses = enumerateTriangleAddresses(0).slice(0, 1);
  const manifest = createTriangleManifest(addresses, {
    type: "svg",
    depth: 0,
    mirror: false,
    svgScale: 512,
    pngResolution: 512,
    border: { enabled: true },
    backside: { enabled: true },
    graticule: { enabled: false, color: "#37c8b1", width: 0.6, step: 15, sampleStep: 1 },
    style,
  });
  assert.equal(manifest.triangles[0].globalNumber, 1);
  assert.match(manifest.triangles[0].backsideFile, /_backside\.svg$/);
  assert.equal(manifest.triangles[0].backsideLabel, tileBacksideLabel(addresses[0], false));
});
