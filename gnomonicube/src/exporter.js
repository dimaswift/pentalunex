import {
  EPSILON,
  FACE_NAMES,
  SPHERE_ORIENTATION,
  childTriangleVertices,
  faceUVToPoleAlignedUV,
  isoProjectFaceUV,
  lonLatToCubeVector,
  neighborTriangleAddress,
  packPath,
  rootTriangleName,
  rootTriangleVertices,
  splitDiagonalForFace,
  toFaceXYZ,
  topologyManifest,
  triangleVerticesFromAddress,
  uvToTriAddress,
  vectorToFaceUV,
} from "./spherecube.js";
import { buildZip } from "./zip.js";

const FACE_CLIP_EPS = 0.00001;
const SVG_NS = "http://www.w3.org/2000/svg";
const encoder = new TextEncoder();

export function createTriangleManifest(addresses, options) {
  const triangles = [];
  const adjacency = {};
  let ordinal = 1;
  for (const address of addresses) {
    const item = manifestTriangle(address, false, options, ordinal++);
    triangles.push(item);
    adjacency[item.id] = adjacencyForAddress(address, false, options.orientation ?? address.orientation);
    if (options.mirror) {
      const mirrored = manifestTriangle(address, true, options, ordinal++);
      triangles.push(mirrored);
      adjacency[mirrored.id] = adjacencyForAddress(address, true, options.orientation ?? address.orientation);
    }
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    projection: "gnomonic-cube-vertex-poles",
    rhombVariants: 2,
    sphereOrientation: SPHERE_ORIENTATION,
    export: {
      type: options.type,
      depth: options.depth,
      mirror: options.mirror,
      svgScale: options.svgScale,
      pngResolution: options.pngResolution,
      border: options.border,
      backside: options.backside,
      graticule: options.graticule,
      style: options.style,
    },
    topology: topologyManifest(options.orientation),
    mirrorRule: "A mirrored triangle may connect to its own reflection; mirrored-to-mirrored and original-to-original triangles preserve same-chirality seamless adjacency.",
    triangles,
    adjacency,
  };
}

export function enumerateTriangleAddresses(depth, orientation) {
  const addresses = [];
  for (let face = 0; face < 6; face += 1) {
    for (let variant = 0; variant < 2; variant += 1) {
      for (let root = 0; root < 2; root += 1) {
        collectAddresses(face, variant, root, [], depth, addresses, orientation);
      }
    }
  }
  return addresses;
}

export function triangleFileBase(address, mirrored = false) {
  const path = address.path.length ? address.path.join("") : "root";
  const variant = address.variant ?? 0;
  return `face_${address.face}_v${variant}/f${address.face}_v${variant}_r${address.root}_d${address.depth}_${path}${mirrored ? "_mirror" : ""}`;
}

export function tileDisplayKey(address) {
  const path = address.path?.length ? address.path.join("") : "root";
  return `${address.face}.${address.variant ?? 0}:${address.root}:${path}`;
}

export function tileBacksideLabel(address, mirrored = false) {
  return `${mirrored ? "L" : "R"}:${tileDisplayKey(address)}`;
}

export function renderTriangleSvg(address, polygons, options = {}) {
  const width = Number(options.svgScale) || 512;
  const height = width;
  const mirrored = !!options.mirrored;
  const orientation = options.orientation ?? address.orientation;
  const geometry = triangleGeometry(address, width, height, mirrored, orientation);
  const content = renderTriangleSvgFragment(address, polygons, options, geometry);
  const attrs = [
    `xmlns="${SVG_NS}"`,
    `width="${round(width)}"`,
    `height="${round(height)}"`,
    `viewBox="0 0 ${round(width)} ${round(height)}"`,
    `data-face="${address.face}"`,
    `data-variant="${address.variant ?? 0}"`,
    `data-root="${address.root}"`,
    `data-depth="${address.depth}"`,
    `data-path="${address.path.join("")}"`,
    `data-mirrored="${String(mirrored)}"`,
  ].join(" ");

return `<?xml version="1.0" encoding="UTF-8"?>
<svg ${attrs}>
${content}
</svg>
`;
}

export function renderBacksideSvg(address, options = {}, ordinal = 1) {
  const width = Number(options.svgScale) || 512;
  const height = width;
  const mirrored = !!options.mirrored;
  const orientation = options.orientation ?? address.orientation;
  const geometry = triangleGeometry(address, width, height, mirrored, orientation);
  const content = renderBacksideSvgFragment(geometry, tileBacksideLabel(address, mirrored), ordinal, options);
  const attrs = [
    `xmlns="${SVG_NS}"`,
    `width="${round(width)}"`,
    `height="${round(height)}"`,
    `viewBox="0 0 ${round(width)} ${round(height)}"`,
    `data-face="${address.face}"`,
    `data-variant="${address.variant ?? 0}"`,
    `data-root="${address.root}"`,
    `data-depth="${address.depth}"`,
    `data-path="${address.path.join("")}"`,
    `data-mirrored="${String(mirrored)}"`,
    `data-backside="true"`,
    `data-global-number="${ordinal}"`,
  ].join(" ");

return `<?xml version="1.0" encoding="UTF-8"?>
<svg ${attrs}>
${content}
</svg>
`;
}

export function renderBacksideSvgFragment(geometry, label, ordinal, options = {}) {
  const trianglePath = pathFromPoints(geometry.trianglePath);
  const center = centroid2(geometry.trianglePath);
  const bounds = boundsForPoints(geometry.trianglePath);
  const size = Math.max(1, Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY));
  const color = options.backside?.color ?? options.style?.coast ?? "#111111";
  const strokeWidth = options.backside?.strokeWidth ?? Math.max(0.6, size * 0.003);
  const numberSize = Math.max(8, size * 0.105);
  const labelSize = Math.max(6, size * 0.052);
  const numberText = `#${ordinal}`;

return `
  <g id="backside" data-label="${escapeAttr(label)}" data-global-number="${ordinal}">
    <path d="${trianglePath}" fill="none" stroke="${escapeAttr(color)}" stroke-width="${round(strokeWidth)}" stroke-linejoin="round"/>
    <text x="${round(center[0])}" y="${round(center[1] - labelSize * 0.58)}" fill="${escapeAttr(color)}" font-family="monospace" font-size="${round(numberSize)}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeText(numberText)}</text>
    <text x="${round(center[0])}" y="${round(center[1] + labelSize * 1.05)}" fill="${escapeAttr(color)}" font-family="monospace" font-size="${round(labelSize)}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${escapeText(label)}</text>
  </g>
`;
}

export function renderTriangleSvgFragment(address, polygons, options = {}, geometry) {
  const style = options.style;
  const orientation = options.orientation ?? address.orientation;
  const landPaths = [];
  const coastPaths = [];
  const includeBorder = options.border?.enabled !== false;

  if (polygons?.length) {
    for (const polygon of polygons) {
      const fillParts = [];
      for (const ring of polygon) {
        const points = projectRingToTriangle(ring, address.face, geometry.project, orientation);
        const clipped = clipPolygonToConvex(points, geometry.trianglePath);
        if (clipped.length >= 3) fillParts.push(pathFromPoints(clipped));
        if (includeBorder) coastPaths.push(...projectRingCoastToTriangle(ring, address.face, geometry.project, geometry.trianglePath, orientation));
      }
      if (fillParts.length) landPaths.push(fillParts.join(" "));
    }
  }

  const trianglePath = pathFromPoints(geometry.trianglePath);
  const graticulePaths = options.graticule?.enabled
    ? buildGraticulePaths(address.face, geometry.project, geometry.trianglePath, options.graticule, orientation)
    : [];

return `
  <g id="ocean">
    <path d="${trianglePath}" fill="${escapeAttr(style.ocean)}"/>
  </g>
  <g id="land">
    ${landPaths.map((path) => `<path d="${path}" fill="${escapeAttr(style.land)}" stroke="none" fill-rule="evenodd"/>`).join("\n    ")}
  </g>
  ${includeBorder ? `<g id="coastlines" fill="none" stroke="${escapeAttr(style.coast)}" stroke-width="${round(style.coastWidth)}" stroke-linejoin="round" stroke-linecap="round">
    ${coastPaths.map((path) => `<path d="${path}"/>`).join("\n    ")}
  </g>` : ""}
  ${options.graticule?.enabled ? `<g id="graticule" fill="none" stroke="${escapeAttr(options.graticule.color)}" stroke-width="${round(options.graticule.width)}" stroke-linejoin="round" stroke-linecap="round">
    ${graticulePaths.map((path) => `<path d="${path}"/>`).join("\n    ")}
  </g>` : ""}
  ${renderEclipseSvgLayer(address, options, geometry)}
`;
}

function renderEclipseSvgLayer(address, options = {}, geometry) {
  const eclipses = normalizeEclipses(options);
  if (!eclipses.length) return "";
  if (eclipses.length === 1) {
    return renderEclipseSvgFragment(address, { ...options, eclipse: eclipses[0] }, geometry);
  }
  const fragments = eclipses.map((eclipse, index) => (
    renderEclipseSvgFragment(address, { ...options, eclipse }, geometry).replaceAll('id="', `id="eclipse${index + 1}-`)
  )).filter(Boolean);
  if (!fragments.length) return "";
  return `<g id="eclipses">
    ${fragments.join("\n    ")}
  </g>`;
}

export function renderEclipseSvgFragment(address, options = {}, geometry) {
  const eclipse = options.eclipse;
  if (!eclipse?.geometry || eclipse.enabled === false) return "";
  const orientation = options.orientation ?? address.orientation;
  const lineOnly = eclipse.lineOnly ?? (isPartialEclipseType(eclipse.type) || /LineString$/.test(eclipse.geometry.type));
  const fillPaths = [];
  const strokePaths = [];

  for (const rings of geometryRingSets(eclipse.geometry)) {
    if (lineOnly) {
      for (const ring of rings) {
        strokePaths.push(...projectRingCoastToTriangle(ring, address.face, geometry.project, geometry.trianglePath, orientation));
      }
      continue;
    }

    const fillParts = [];
    for (const ring of rings) {
      const points = projectRingToTriangle(ring, address.face, geometry.project, orientation);
      const clipped = clipPolygonToConvex(points, geometry.trianglePath);
      if (clipped.length >= 3) fillParts.push(pathFromPoints(clipped));
      strokePaths.push(...projectRingCoastToTriangle(ring, address.face, geometry.project, geometry.trianglePath, orientation));
    }
    if (fillParts.length) fillPaths.push(fillParts.join(" "));
  }

  if (!fillPaths.length && !strokePaths.length) return "";
  const fill = eclipse.fill ?? "#ffd16c";
  const stroke = eclipse.stroke ?? "#ffd16c";
  const width = Number(eclipse.width) || 4;
  const fillOpacity = eclipse.fillOpacity ?? 0.28;

return `<g id="eclipse" data-saros="${escapeAttr(eclipse.sarosNumber ?? "")}" data-position="${escapeAttr(eclipse.sarosPosition ?? "")}" data-date="${escapeAttr(eclipse.datetime_utc ?? "")}" data-type="${escapeAttr(eclipse.type ?? "")}">
    ${fillPaths.length && !lineOnly ? `<g id="eclipse-fill" fill="${escapeAttr(fill)}" fill-opacity="${round(fillOpacity)}" stroke="none" fill-rule="evenodd">
      ${fillPaths.map((path) => `<path d="${path}"/>`).join("\n      ")}
    </g>` : ""}
    <g id="eclipse-path" fill="none" stroke="${escapeAttr(stroke)}" stroke-width="${round(width)}" stroke-linejoin="round" stroke-linecap="round">
      ${strokePaths.map((path) => `<path d="${path}"/>`).join("\n      ")}
    </g>
  </g>`;
}

export async function renderTrianglePng(address, polygons, options = {}) {
  const resolution = Number(options.pngResolution) || 512;
  const svg = renderTriangleSvg(address, polygons, {
    ...options,
    svgScale: resolution,
  });
  return svgToPngBytes(svg, resolution, resolution);
}

export async function renderBacksidePng(address, options = {}, ordinal = 1) {
  const resolution = Number(options.pngResolution) || 512;
  const svg = renderBacksideSvg(address, {
    ...options,
    svgScale: resolution,
  }, ordinal);
  return svgToPngBytes(svg, resolution, resolution);
}

export async function exportSelectedTriangle(address, polygons, options) {
  if (options.mirror || options.backside?.enabled) {
    const files = [{
      name: "manifest.json",
      data: encoder.encode(JSON.stringify(createTriangleManifest([address], options), null, 2)),
    }];
    await addTriangleFile(files, address, false, polygons, options, 1);
    if (options.mirror) await addTriangleFile(files, address, true, polygons, options, 2);
    return {
      filename: `${triangleFileBase(address, false)}${options.mirror ? "_with_mirror" : ""}${options.backside?.enabled ? "_with_backside" : ""}.zip`.replaceAll("/", "_"),
      blob: buildZip(files),
    };
  }
  const base = triangleFileBase(address, options.mirrored).replaceAll("/", "_");
  if (options.type === "png") {
    const data = await renderTrianglePng(address, polygons, options);
    return { filename: `${base}.png`, blob: new Blob([data], { type: "image/png" }) };
  }
  const svg = renderTriangleSvg(address, polygons, options);
  return { filename: `${base}.svg`, blob: new Blob([svg], { type: "image/svg+xml" }) };
}

export async function exportAllTriangles(polygons, options, onProgress = () => {}) {
  const addresses = enumerateTriangleAddresses(options.depth, options.orientation);
  const files = [];
  const manifest = createTriangleManifest(addresses, options);
  files.push({
    name: "manifest.json",
    data: encoder.encode(JSON.stringify(manifest, null, 2)),
  });

  let completed = 0;
  let ordinal = 1;
  const tileTotal = addresses.length * (options.mirror ? 2 : 1);
  const total = tileTotal * (options.backside?.enabled ? 2 : 1);
  for (const address of addresses) {
    completed += await addTriangleFile(files, address, false, polygons, options, ordinal++);
    onProgress(completed, total);
    if (completed % 12 === 0) await yieldFrame();
    if (options.mirror) {
      completed += await addTriangleFile(files, address, true, polygons, options, ordinal++);
      onProgress(completed, total);
      if (completed % 12 === 0) await yieldFrame();
    }
  }

  return {
    filename: `sphere-cube-triangles-d${options.depth}-${options.type}${options.mirror ? "-mirror" : ""}${options.backside?.enabled ? "-backside" : ""}.zip`,
    blob: buildZip(files),
    count: tileTotal,
    fileCount: total,
  };
}

function collectAddresses(face, variant, root, path, targetDepth, out, orientation) {
  if (path.length === targetDepth) {
    const vertices = path.reduce(
      (current, child) => childTriangleVertices(current, child),
      rootTriangleVertices(face, root, orientation, variant),
    );
    const centroid = [
      (vertices[0][0] + vertices[1][0] + vertices[2][0]) / 3,
      (vertices[0][1] + vertices[1][1] + vertices[2][1]) / 3,
    ];
    out.push({
      ...uvToTriAddress(face, centroid[0], centroid[1], targetDepth, orientation, variant),
      path: path.slice(),
      root,
      rootName: rootTriangleName(face, root, orientation, variant),
      depth: targetDepth,
      pathBits: packPath(path).toString(),
      barycentric: [1 / 3, 1 / 3, 1 / 3],
      uv: centroid,
      variant,
    });
    return;
  }
  for (let child = 0; child < 4; child += 1) {
    collectAddresses(face, variant, root, path.concat(child), targetDepth, out, orientation);
  }
}

async function addTriangleFile(files, address, mirrored, polygons, options, ordinal = 1) {
  const base = triangleFileBase(address, mirrored);
  if (options.type === "png") {
    files.push({
      name: `${base}.png`,
      data: await renderTrianglePng(address, polygons, { ...options, mirrored }),
    });
  } else {
    files.push({
      name: `${base}.svg`,
      data: encoder.encode(renderTriangleSvg(address, polygons, { ...options, mirrored })),
    });
  }
  if (options.backside?.enabled) {
    if (options.type === "png") {
      files.push({
        name: `${base}_backside.png`,
        data: await renderBacksidePng(address, { ...options, mirrored }, ordinal),
      });
    } else {
      files.push({
        name: `${base}_backside.svg`,
        data: encoder.encode(renderBacksideSvg(address, { ...options, mirrored }, ordinal)),
      });
    }
    return 2;
  }
  return 1;
}

function manifestTriangle(address, mirrored, options, ordinal = 1) {
  const orientation = options.orientation ?? address.orientation;
  const vertices = triangleVerticesFromAddress(address, orientation);
  const id = triangleId(address, mirrored);
  const base = triangleFileBase(address, mirrored);
  return {
    id,
    globalNumber: ordinal,
    file: `${base}.${options.type}`,
    backsideFile: options.backside?.enabled ? `${base}_backside.${options.type}` : null,
    backsideLabel: tileBacksideLabel(address, mirrored),
    mirrored,
    chirality: mirrored ? "mirror" : "original",
    reflectionOf: mirrored ? triangleId(address, false) : null,
    face: address.face,
    variant: address.variant ?? 0,
    faceName: FACE_NAMES[address.face],
    root: address.root,
    rootName: address.rootName,
    depth: address.depth,
    path: address.path,
    pathString: address.path.join(""),
    pathBits: address.pathBits,
    barycentric: address.barycentric,
    uv: address.uv,
    vertices,
    poleAlignedVertices: vertices.map(([u, v]) => faceUVToPoleAlignedUV(address.face, u, v, orientation)),
    splitDiagonal: splitDiagonalForFace(address.face, orientation, address.variant ?? 0),
  };
}

function adjacencyForAddress(address, mirrored, orientation) {
  const sameChirality = [0, 1, 2].map((edge) => {
    const probe = neighborTriangleAddress(address, edge, address.depth, orientation, address.variant ?? 0);
    const variants = probe.face === address.face ? [address.variant ?? 0] : [0, 1];
    const resolved = variants.map((variant) => neighborTriangleAddress(address, edge, address.depth, orientation, variant));
    return {
      edge,
      to: triangleId(resolved[0], mirrored),
      variants: resolved.map((addr) => triangleId(addr, mirrored)),
      face: probe.face,
      root: probe.root,
      path: probe.path,
      chirality: mirrored ? "mirror" : "original",
    };
  });
  return {
    reflection: triangleId(address, !mirrored),
    sameChirality,
  };
}

function triangleId(address, mirrored) {
  const path = address.path.length ? address.path.join("") : "root";
  return `f${address.face}:v${address.variant ?? 0}:r${address.root}:d${address.depth}:${path}${mirrored ? ":m" : ""}`;
}

function triangleGeometry(address, width, height, mirrored, orientation) {
  const vertices = triangleVerticesFromAddress(address, orientation);
  const variant = address.variant ?? 0;
  const localVertices = vertices.map(([u, v]) => isoProjectFaceUV(address.face, u, v, variant));
  const bounds = boundsForPoints(localVertices);
  const scale = Math.min(
    (width - 8) / Math.max(0.001, bounds.maxX - bounds.minX),
    (height - 8) / Math.max(0.001, bounds.maxY - bounds.minY),
  );
  const centerX = (bounds.minX + bounds.maxX) * 0.5;
  const centerY = (bounds.minY + bounds.maxY) * 0.5;
  const offsetX = width * 0.5;
  const offsetY = height * 0.5;

  const project = (u, v) => {
    const raw = isoProjectFaceUV(address.face, u, v, variant);
    const point = [
      (raw[0] - centerX) * scale,
      (raw[1] - centerY) * scale,
    ];
    const x = point[0] + offsetX;
    const y = point[1] + offsetY;
    return mirrored ? [width - x, y] : [x, y];
  };

  return {
    vertices,
    trianglePath: vertices.map(([u, v]) => project(u, v)),
    project,
  };
}

function normalizeEclipses(options) {
  if (Array.isArray(options.eclipses) && options.eclipses.length) return options.eclipses;
  return options.eclipse ? [options.eclipse] : [];
}

function geometryRingSets(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  if (geometry.type === "LineString") return [[geometry.coordinates]];
  if (geometry.type === "MultiLineString") return geometry.coordinates.map((line) => [line]);
  return [];
}

function isPartialEclipseType(type) {
  return ["P", "Pb", "Pe", "Aminus", "Aplus", "Tminus", "Tplus"].includes(type);
}

function projectRingToTriangle(ring, face, projectUV, orientation) {
  const xyz = ring.map(([lon, lat]) => toFaceXYZ(face, lonLatToCubeVector(lon, lat, orientation)));
  const clipped = clipRingByZ(xyz, FACE_CLIP_EPS);
  const points = [];
  for (const point of clipped) {
    const vector = faceVectorFromXYZ(face, point);
    const projected = vectorToFaceUV(face, vector);
    if (!Number.isFinite(projected.u) || !Number.isFinite(projected.v)) continue;
    points.push(projectUV(projected.u, projected.v));
  }
  return points;
}

function projectRingCoastToTriangle(ring, face, projectUV, triangle, orientation) {
  const paths = [];
  if (ring.length < 2) return paths;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const a = toFaceXYZ(face, lonLatToCubeVector(ring[index][0], ring[index][1], orientation));
    const b = toFaceXYZ(face, lonLatToCubeVector(ring[index + 1][0], ring[index + 1][1], orientation));
    const clipped3 = clipSegmentByZ(a, b, FACE_CLIP_EPS);
    if (!clipped3) continue;
    const projected = clipped3.map((point) => {
      const uv = vectorToFaceUV(face, faceVectorFromXYZ(face, point));
      return projectUV(uv.u, uv.v);
    });
    const clipped2 = clipSegmentToConvex(projected[0], projected[1], triangle);
    if (!clipped2) continue;
    paths.push(openPathFromPoints(clipped2));
  }
  return paths;
}

function buildGraticulePaths(face, projectUV, triangle, graticule, orientation) {
  const paths = [];
  const step = Number(graticule.step) || 15;
  const sampleStep = Number(graticule.sampleStep) || 1;
  for (let lat = -90 + step; lat < 90; lat += step) {
    paths.push(...projectLonLatLineToTriangle(sampleParallel(lat, sampleStep), face, projectUV, triangle, orientation));
  }
  for (let lon = -180; lon < 180; lon += step) {
    paths.push(...projectLonLatLineToTriangle(sampleMeridian(lon, sampleStep), face, projectUV, triangle, orientation));
  }
  return paths;
}

function projectLonLatLineToTriangle(points, face, projectUV, triangle, orientation) {
  const paths = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = toFaceXYZ(face, lonLatToCubeVector(points[index][0], points[index][1], orientation));
    const b = toFaceXYZ(face, lonLatToCubeVector(points[index + 1][0], points[index + 1][1], orientation));
    const clipped3 = clipSegmentByZ(a, b, FACE_CLIP_EPS);
    if (!clipped3) continue;
    const projected = clipped3.map((point) => {
      const uv = vectorToFaceUV(face, faceVectorFromXYZ(face, point));
      return projectUV(uv.u, uv.v);
    });
    const clipped2 = clipSegmentToConvex(projected[0], projected[1], triangle);
    if (!clipped2) continue;
    paths.push(openPathFromPoints(clipped2));
  }
  return paths;
}

function faceVectorFromXYZ(face, xyz) {
  const frame = FACE_FRAMES_FOR_EXPORT[face];
  return [
    frame.east[0] * xyz[0] + frame.north[0] * xyz[1] + frame.normal[0] * xyz[2],
    frame.east[1] * xyz[0] + frame.north[1] * xyz[1] + frame.normal[1] * xyz[2],
    frame.east[2] * xyz[0] + frame.north[2] * xyz[1] + frame.normal[2] * xyz[2],
  ];
}

const FACE_FRAMES_FOR_EXPORT = [
  { east: [0, 1, 0], north: [-1, 0, 0], normal: [0, 0, 1] },
  { east: [0, 1, 0], north: [0, 0, 1], normal: [1, 0, 0] },
  { east: [-1, 0, 0], north: [0, 0, 1], normal: [0, 1, 0] },
  { east: [0, -1, 0], north: [0, 0, 1], normal: [-1, 0, 0] },
  { east: [1, 0, 0], north: [0, 0, 1], normal: [0, -1, 0] },
  { east: [0, -1, 0], north: [-1, 0, 0], normal: [0, 0, -1] },
];

function clipRingByZ(ring, minZ) {
  if (ring.length === 0) return [];
  const out = [];
  let previous = ring[ring.length - 1];
  let previousInside = previous[2] >= minZ;
  for (const current of ring) {
    const currentInside = current[2] >= minZ;
    if (currentInside) {
      if (!previousInside) out.push(interpolateZ(previous, current, minZ));
      out.push(current);
    } else if (previousInside) {
      out.push(interpolateZ(previous, current, minZ));
    }
    previous = current;
    previousInside = currentInside;
  }
  return out;
}

function clipSegmentByZ(a, b, minZ) {
  const aInside = a[2] >= minZ;
  const bInside = b[2] >= minZ;
  if (aInside && bInside) return [a, b];
  if (!aInside && !bInside) return null;
  const intersection = interpolateZ(a, b, minZ);
  return aInside ? [a, intersection] : [intersection, b];
}

function interpolateZ(a, b, z) {
  const denominator = b[2] - a[2];
  const t = Math.abs(denominator) < EPSILON ? 0 : (z - a[2]) / denominator;
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    z,
  ];
}

function boundsForPoints(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point[0]),
    maxX: Math.max(bounds.maxX, point[0]),
    minY: Math.min(bounds.minY, point[1]),
    maxY: Math.max(bounds.maxY, point[1]),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}

function centroid2(points) {
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function pathFromPoints(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${round(point[0])} ${round(point[1])}`).join(" ") + " Z";
}

function openPathFromPoints(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${round(point[0])} ${round(point[1])}`).join(" ");
}

function clipPolygonToConvex(subject, clipPolygon) {
  if (subject.length < 3) return [];
  let output = subject.slice();
  const orientation = Math.sign(polygonArea(clipPolygon)) || 1;
  for (let i = 0; i < clipPolygon.length; i += 1) {
    const a = clipPolygon[i];
    const b = clipPolygon[(i + 1) % clipPolygon.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    let previous = input[input.length - 1];
    let previousInside = insideHalfPlane(previous, a, b, orientation);
    for (const current of input) {
      const currentInside = insideHalfPlane(current, a, b, orientation);
      if (currentInside) {
        if (!previousInside) output.push(lineIntersection(previous, current, a, b));
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, a, b));
      }
      previous = current;
      previousInside = currentInside;
    }
  }
  return dedupePoints(output);
}

function clipSegmentToConvex(a, b, clipPolygon) {
  const orientation = Math.sign(polygonArea(clipPolygon)) || 1;
  let t0 = 0;
  let t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (let i = 0; i < clipPolygon.length; i += 1) {
    const p = clipPolygon[i];
    const q = clipPolygon[(i + 1) % clipPolygon.length];
    const edge = [q[0] - p[0], q[1] - p[1]];
    const numerator = orientation * cross2(edge, [a[0] - p[0], a[1] - p[1]]);
    const denominator = orientation * cross2(edge, d);
    if (Math.abs(denominator) < EPSILON) {
      if (numerator < -EPSILON) return null;
      continue;
    }
    const t = -numerator / denominator;
    if (denominator > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 - t1 > EPSILON) return null;
  }
  return [
    [a[0] + d[0] * t0, a[1] + d[1] * t0],
    [a[0] + d[0] * t1, a[1] + d[1] * t1],
  ];
}

function insideHalfPlane(point, a, b, orientation) {
  return orientation * cross2([b[0] - a[0], b[1] - a[1]], [point[0] - a[0], point[1] - a[1]]) >= -EPSILON;
}

function lineIntersection(p1, p2, p3, p4) {
  const r = [p2[0] - p1[0], p2[1] - p1[1]];
  const s = [p4[0] - p3[0], p4[1] - p3[1]];
  const denominator = cross2(r, s);
  if (Math.abs(denominator) < EPSILON) return p2;
  const t = cross2([p3[0] - p1[0], p3[1] - p1[1]], s) / denominator;
  return [p1[0] + r[0] * t, p1[1] + r[1] * t];
}

function dedupePoints(points) {
  const out = [];
  for (const point of points) {
    const previous = out[out.length - 1];
    if (!previous || Math.hypot(point[0] - previous[0], point[1] - previous[1]) > 0.001) out.push(point);
  }
  if (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 0.001) out.pop();
  return out;
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function cross2(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

function sampleParallel(lat, step) {
  const points = [];
  for (let lon = -180; lon <= 180; lon += step) points.push([lon, lat]);
  return points;
}

function sampleMeridian(lon, step) {
  const points = [];
  for (let lat = -90; lat <= 90; lat += step) points.push([lon, lat]);
  return points;
}

function round(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "");
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function svgToPngBytes(svg, width, height) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(async (pngBlob) => {
        if (!pngBlob) {
          reject(new Error("PNG encode failed"));
          return;
        }
        resolve(new Uint8Array(await pngBlob.arrayBuffer()));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG rasterization failed"));
    };
    img.src = url;
  });
}

function yieldFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
