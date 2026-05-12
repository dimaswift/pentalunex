import {
  DEG,
  faceUVToPoleAlignedUV,
  isoProjectFaceUV,
  lonLatToCubeVector,
  toFaceXYZ,
  triangleVerticesFromAddress,
  vectorToFaceUV,
} from "./spherecube.js";

const FACE_CLIP_EPS = 0.00001;
const GLOBE_CLIP_EPS = 0;

export function drawLandOnFace(ctx, tile, polygons, style, uvToScreen, orientation) {
  if (!polygons?.length) return;
  ctx.save();
  clipToPolygon(ctx, tile.corners);
  ctx.fillStyle = style.land;
  ctx.strokeStyle = style.coast;
  ctx.lineWidth = style.coastWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const polygon of polygons) {
    ctx.beginPath();
    let hasRing = false;
    for (const ring of polygon) {
      const points = projectRingToFace(ring, tile.face, (u, v) => uvToScreen(tile, u, v), orientation);
      if (points.length < 3) continue;
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point[0], point[1]);
        else ctx.lineTo(point[0], point[1]);
      });
      ctx.closePath();
      hasRing = true;
    }
    if (!hasRing) continue;
    ctx.fill("evenodd");
    if (style.coastWidth > 0) ctx.stroke();
  }
  ctx.restore();
}

export function drawLandOnTriangle(ctx, address, trianglePath, projectUV, polygons, style, orientation, includeBorder = true) {
  if (!polygons?.length) return;
  ctx.save();
  clipToPolygon(ctx, trianglePath);
  ctx.fillStyle = style.land;
  ctx.strokeStyle = style.coast;
  ctx.lineWidth = style.coastWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  for (const polygon of polygons) {
    ctx.beginPath();
    let hasRing = false;
    for (const ring of polygon) {
      const points = projectRingToFace(ring, address.face, projectUV, orientation);
      if (points.length < 3) continue;
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point[0], point[1]);
        else ctx.lineTo(point[0], point[1]);
      });
      ctx.closePath();
      hasRing = true;
    }
    if (!hasRing) continue;
    ctx.fill("evenodd");
    if (includeBorder && style.coastWidth > 0) ctx.stroke();
  }
  ctx.restore();
}

export function drawEclipseOnTriangle(ctx, address, trianglePath, projectUV, eclipse, style, orientation) {
  if (!eclipse?.geometry) return;
  const lineOnly = style?.lineOnly ?? (isPartialEclipseType(eclipse.type) || /LineString$/.test(eclipse.geometry.type));
  ctx.save();
  clipToPolygon(ctx, trianglePath);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = style?.stroke ?? "#ffcf66";
  ctx.fillStyle = style?.fill ?? "rgba(240,179,90,0.28)";
  ctx.lineWidth = style?.width ?? 1.2;

  for (const rings of geometryRingSets(eclipse.geometry)) {
    if (lineOnly) {
      for (const ring of rings) {
        const points = projectRingToFace(ring, address.face, projectUV, orientation);
        if (points.length < 2) continue;
        ctx.beginPath();
        points.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point[0], point[1]);
          else ctx.lineTo(point[0], point[1]);
        });
        ctx.closePath();
        ctx.stroke();
      }
      continue;
    }

    ctx.beginPath();
    let hasRing = false;
    for (const ring of rings) {
      const points = projectRingToFace(ring, address.face, projectUV, orientation);
      if (points.length < 3) continue;
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point[0], point[1]);
        else ctx.lineTo(point[0], point[1]);
      });
      ctx.closePath();
      hasRing = true;
    }
    if (!hasRing) continue;
    if (style?.fill !== null) {
      ctx.save();
      ctx.globalAlpha *= style?.fillOpacity ?? 0.28;
      ctx.fill("evenodd");
      ctx.restore();
    }
    if ((style?.width ?? 1.2) > 0) ctx.stroke();
  }
  ctx.restore();
}

export function drawTrianglePreview(canvas, address, polygons, style, orientation = address?.orientation) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0c0c0b";
  ctx.fillRect(0, 0, width, height);

  const vertices = triangleVerticesFromAddress(address, orientation);
  const localVertices = vertices.map(([u, v]) => triangleDisplayPoint(address, u, v, orientation, 1));
  const bounds = boundsForPoints(localVertices);
  const scale = Math.min((width - 30) / Math.max(0.001, bounds.maxX - bounds.minX), (height - 30) / Math.max(0.001, bounds.maxY - bounds.minY));
  const offsetX = width * 0.5 - ((bounds.minX + bounds.maxX) * 0.5) * scale;
  const offsetY = height * 0.5 - ((bounds.minY + bounds.maxY) * 0.5) * scale;
  const project = (u, v) => {
    const point = triangleDisplayPoint(address, u, v, orientation, scale);
    return [point[0] + offsetX, point[1] + offsetY];
  };
  const trianglePath = vertices.map(([u, v]) => project(u, v));

  ctx.save();
  clipToPolygon(ctx, trianglePath);
  ctx.fillStyle = style.ocean;
  ctx.fillRect(0, 0, width, height);
  if (polygons?.length) {
    ctx.fillStyle = style.land;
    ctx.strokeStyle = style.coast;
    ctx.lineWidth = style.coastWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const polygon of polygons) {
      ctx.beginPath();
      let hasRing = false;
      for (const ring of polygon) {
        const points = projectRingToFace(ring, address.face, project, orientation);
        if (points.length < 3) continue;
        points.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point[0], point[1]);
          else ctx.lineTo(point[0], point[1]);
        });
        ctx.closePath();
        hasRing = true;
      }
      if (!hasRing) continue;
      ctx.fill("evenodd");
      if (style.coastWidth > 0) ctx.stroke();
    }
  }
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  trianglePath.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point[0], point[1]);
    else ctx.lineTo(point[0], point[1]);
  });
  ctx.closePath();
  ctx.strokeStyle = "#f0b35a";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();
}

export function drawGlobe(canvas, polygons, style, globeState, marker) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const radius = Math.max(10, Math.min(width, height) * 0.43);
  const cx = width * 0.5;
  const cy = height * 0.5;
  ctx.fillStyle = "#0c0c0b";
  ctx.fillRect(0, 0, width, height);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = style.ocean;
  ctx.fill();

  if (polygons?.length) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = style.land;
    ctx.strokeStyle = style.coast;
    ctx.lineWidth = style.coastWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const polygon of polygons) {
      ctx.beginPath();
      let hasRing = false;
      for (const ring of polygon) {
        const points = projectRingToGlobe(ring, globeState, cx, cy, radius);
        if (points.length < 3) continue;
        points.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point[0], point[1]);
          else ctx.lineTo(point[0], point[1]);
        });
        ctx.closePath();
        hasRing = true;
      }
      if (!hasRing) continue;
      ctx.fill("evenodd");
      if (style.coastWidth > 0) ctx.stroke();
    }
    ctx.restore();
  }

  drawGlobeGraticule(ctx, globeState, cx, cy, radius);
  drawGlobeMarker(ctx, marker, globeState, cx, cy, radius);

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(243,239,230,0.62)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawGlobeGraticule(ctx, globeState, cx, cy, radius) {
  ctx.save();
  ctx.lineWidth = 0.7;
  ctx.strokeStyle = "rgba(243,239,230,0.20)";
  for (let lat = -60; lat <= 60; lat += 30) {
    drawGlobeLine(ctx, sampleParallel(lat, 3), globeState, cx, cy, radius);
  }
  ctx.strokeStyle = "rgba(55,200,177,0.26)";
  for (let lon = -180; lon < 180; lon += 30) {
    drawGlobeLine(ctx, sampleMeridian(lon, 3), globeState, cx, cy, radius);
  }
  ctx.restore();
}

function drawGlobeLine(ctx, ring, globeState, cx, cy, radius) {
  let open = false;
  ctx.beginPath();
  for (const [lon, lat] of ring) {
    const point = orthographicProject(lon, lat, globeState);
    if (point.z < GLOBE_CLIP_EPS) {
      open = false;
      continue;
    }
    const x = cx + point.x * radius;
    const y = cy - point.y * radius;
    if (!open) {
      ctx.moveTo(x, y);
      open = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

function drawGlobeMarker(ctx, marker, globeState, cx, cy, radius) {
  if (!marker) return;
  const point = orthographicProject(marker.lon, marker.lat, globeState);
  if (point.z < 0) return;
  const x = cx + point.x * radius;
  const y = cy - point.y * radius;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#e86f75";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.88)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
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

function projectRingToFace(ring, face, projectUV, orientation) {
  const xyz = ring.map(([lon, lat]) => toFaceXYZ(face, lonLatToCubeVector(lon, lat, orientation)));
  const clipped = clipRingByZ(xyz, FACE_CLIP_EPS);
  const points = [];
  for (const point of clipped) {
    const projected = vectorToFaceUV(face, faceVectorFromXYZ(face, point));
    if (!Number.isFinite(projected.u) || !Number.isFinite(projected.v)) continue;
    points.push(projectUV(projected.u, projected.v));
  }
  return points;
}

function faceVectorFromXYZ(face, xyz) {
  // vectorToFaceUV expects a world/cube vector. Reconstructing via lonLat is
  // wasteful; this local inverse is intentionally scoped to map rendering.
  const frames = FACE_FRAMES_FOR_MAP[face];
  return [
    frames.east[0] * xyz[0] + frames.north[0] * xyz[1] + frames.normal[0] * xyz[2],
    frames.east[1] * xyz[0] + frames.north[1] * xyz[1] + frames.normal[1] * xyz[2],
    frames.east[2] * xyz[0] + frames.north[2] * xyz[1] + frames.normal[2] * xyz[2],
  ];
}

const FACE_FRAMES_FOR_MAP = [
  { east: [0, 1, 0], north: [-1, 0, 0], normal: [0, 0, 1] },
  { east: [0, 1, 0], north: [0, 0, 1], normal: [1, 0, 0] },
  { east: [-1, 0, 0], north: [0, 0, 1], normal: [0, 1, 0] },
  { east: [0, -1, 0], north: [0, 0, 1], normal: [-1, 0, 0] },
  { east: [1, 0, 0], north: [0, 0, 1], normal: [0, -1, 0] },
  { east: [0, -1, 0], north: [-1, 0, 0], normal: [0, 0, -1] },
];

function projectRingToGlobe(ring, globeState, cx, cy, radius) {
  const xyz = ring.map(([lon, lat]) => {
    const projected = orthographicProject(lon, lat, globeState);
    return [projected.x, projected.y, projected.z];
  });
  const clipped = clipRingByZ(xyz, GLOBE_CLIP_EPS);
  return clipped.map(([x, y]) => [cx + x * radius, cy - y * radius]);
}

function orthographicProject(lon, lat, globeState) {
  const lambda = (lon - globeState.lon) * DEG;
  const phi = lat * DEG;
  const phi0 = globeState.lat * DEG;
  const cosPhi = Math.cos(phi);
  return {
    x: cosPhi * Math.sin(lambda),
    y: Math.sin(phi) * Math.cos(phi0) - cosPhi * Math.cos(lambda) * Math.sin(phi0),
    z: Math.sin(phi) * Math.sin(phi0) + cosPhi * Math.cos(lambda) * Math.cos(phi0),
  };
}

function triangleDisplayPoint(address, u, v, orientation, scale) {
  if (address.variant != null) {
    const point = isoProjectFaceUV(address.face, u, v, address.variant);
    return [point[0] * scale, point[1] * scale];
  }
  const display = faceUVToPoleAlignedUV(address.face, u, v, orientation);
  return diamondPoint(display.u, display.v, 0, 0, scale);
}

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

function interpolateZ(a, b, z) {
  const t = (z - a[2]) / (b[2] - a[2] || 1);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    z,
  ];
}

function diamondPoint(u, v, cx, cy, scale) {
  return [
    cx + (Math.sqrt(3) * 0.5) * scale * (u - v),
    cy + scale * (-0.5 + 0.5 * (u + v)),
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

function clipToPolygon(ctx, points) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point[0], point[1]);
    else ctx.lineTo(point[0], point[1]);
  });
  ctx.closePath();
  ctx.clip();
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
