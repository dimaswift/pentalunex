import {
  FACE_EDGE_ADJACENCY,
  FACE_NAMES,
  ISO_TILES,
  childTriangleVertices,
  faceUVToLonLat,
  isoProjectFaceUV,
  lonLatToFaceUV,
  poleCornerForFace,
  rootTriangleVertices,
  splitDiagonalForFace,
  triangleVerticesFromAddress,
} from "./spherecube.js";
import { drawLandOnFace } from "./map-render.js";

const FACE_COLORS = [
  "#37c8b1",
  "#f0b35a",
  "#e86f75",
  "#9c8cf0",
  "#71b7f6",
  "#d4d16a",
];

let atlasMapCache = {
  signature: "",
  canvas: null,
};

export function buildAtlasLayout(width, height) {
  const cols = width < 760 ? 2 : width < 1120 ? 3 : 4;
  const rows = Math.ceil(ISO_TILES.length / cols);
  const gutter = Math.max(22, Math.min(width, height) * 0.035);
  const cellW = (width - gutter * (cols + 1)) / cols;
  const cellH = (height - gutter * (rows + 1)) / rows;

  return ISO_TILES.map((tile, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const cx = gutter + cellW * (col + 0.5) + gutter * col;
    const cy = gutter + cellH * (row + 0.5) + gutter * row;
    const rawCorners = [
      isoProjectFaceUV(tile.face, 0, 0, tile.orientation),
      isoProjectFaceUV(tile.face, 1, 0, tile.orientation),
      isoProjectFaceUV(tile.face, 1, 1, tile.orientation),
      isoProjectFaceUV(tile.face, 0, 1, tile.orientation),
    ];
    const bounds = boundsForPoints(rawCorners);
    const center = [
      (bounds.minX + bounds.maxX) * 0.5,
      (bounds.minY + bounds.maxY) * 0.5,
    ];
    const scale = Math.max(20, Math.min(
      (cellW * 0.82) / Math.max(0.001, bounds.maxX - bounds.minX),
      (cellH * 0.72) / Math.max(0.001, bounds.maxY - bounds.minY),
    ));
    const corners = rawCorners.map((point) => [
      cx + (point[0] - center[0]) * scale,
      cy + (point[1] - center[1]) * scale,
    ]);
    return {
      ...tile,
      cx,
      cy,
      scale,
      cellW,
      cellH,
      corners,
      color: FACE_COLORS[tile.face],
      p00: corners[0],
      p10: corners[1],
      p11: corners[2],
      p01: corners[3],
    };
  });
}

export function uvToScreen(tile, u, v) {
  const ux = tile.p10[0] - tile.p00[0];
  const uy = tile.p10[1] - tile.p00[1];
  const vx = tile.p01[0] - tile.p00[0];
  const vy = tile.p01[1] - tile.p00[1];
  return [tile.p00[0] + ux * u + vx * v, tile.p00[1] + uy * u + vy * v];
}

export function screenToUV(tile, x, y) {
  const ux = tile.p10[0] - tile.p00[0];
  const uy = tile.p10[1] - tile.p00[1];
  const vx = tile.p01[0] - tile.p00[0];
  const vy = tile.p01[1] - tile.p00[1];
  const dx = x - tile.p00[0];
  const dy = y - tile.p00[1];
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-9) return null;
  const u = (dx * vy - dy * vx) / det;
  const v = (ux * dy - uy * dx) / det;
  return { u, v };
}

export function pickTile(layout, x, y, orientation) {
  for (let index = layout.length - 1; index >= 0; index -= 1) {
    const tile = layout[index];
    const uv = screenToUV(tile, x, y);
    if (!uv) continue;
    if (uv.u >= -1e-6 && uv.u <= 1 + 1e-6 && uv.v >= -1e-6 && uv.v <= 1 + 1e-6) {
      return {
        tile,
        face: tile.face,
        u: Math.max(0, Math.min(1, uv.u)),
        v: Math.max(0, Math.min(1, uv.v)),
        variant: tile.orientation,
      };
    }
  }
  return null;
}

export function renderAtlas(ctx, width, height, state) {
  const layout = buildAtlasLayout(width, height);
  for (const tile of layout) tile.orientationState = state.orientation;
  ctx.clearRect(0, 0, width, height);
  drawAtlasMapLayer(ctx, width, height, layout, state);
  for (const tile of layout) {
    drawGraticule(ctx, tile, state.graticuleStep, state.sampleStep);
  }
  if (state.showSubdivisions) {
    for (const tile of layout) drawSubdivision(ctx, tile, state.depth);
  }
  if (state.selectedAddress) {
    drawAddressHighlight(ctx, layout, state.selectedAddress, "#f0b35a");
  }
  if (state.hoverAddress) {
    drawAddressHighlight(ctx, layout, state.hoverAddress, "#e86f75");
    drawHoverMarker(ctx, layout, state.hoverAddress);
  }
  if (state.showLabels) {
    for (const tile of layout) drawTileLabel(ctx, tile);
  }

  return layout;
}

function drawAtlasMapLayer(ctx, width, height, layout, state) {
  const style = state.mapStyle;
  const signature = [
    Math.round(width),
    Math.round(height),
    state.orientation?.lon ?? 0,
    state.orientation?.lat ?? 0,
    state.orientation?.roll ?? 0,
    style.ocean,
    style.land,
    style.coast,
    style.coastWidth,
    state.landPolygons ? state.landPolygons.length : "loading",
  ].join(":");

  if (!atlasMapCache.canvas || atlasMapCache.signature !== signature) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
    const cacheCtx = canvas.getContext("2d");
    drawBackground(cacheCtx, width, height);
    for (const tile of layout) drawTileBase(cacheCtx, tile, style);
    if (state.landPolygons) {
      for (const tile of layout) drawLandOnFace(cacheCtx, tile, state.landPolygons, style, uvToScreen, state.orientation);
    }
    atlasMapCache = { signature, canvas };
  }

  ctx.drawImage(atlasMapCache.canvas, 0, 0, width, height);
}

function drawBackground(ctx, width, height) {
  ctx.save();
  ctx.fillStyle = "#0c0c0b";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(255,255,255,0.035)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawTileBase(ctx, tile, style) {
  ctx.save();
  ctx.beginPath();
  tile.corners.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point[0], point[1]);
    else ctx.lineTo(point[0], point[1]);
  });
  ctx.closePath();
  ctx.fillStyle = style.ocean;
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = colorWithAlpha(tile.color, 0.86);
  ctx.stroke();

  ctx.globalAlpha = 0.09;
  ctx.fillStyle = tile.color;
  ctx.fill();
  ctx.restore();
}

function drawTileLabel(ctx, tile) {
  const label = `F${tile.face}.${tile.orientation}`;
  const name = FACE_NAMES[tile.face].replace(" deg", "");
  const pole = poleCornerForFace(tile.face, tile.orientationState);
  ctx.save();
  ctx.font = "700 11px Inter, system-ui, sans-serif";
  ctx.fillStyle = colorWithAlpha(tile.color, 0.95);
  ctx.textAlign = "center";
  ctx.fillText(label, tile.cx, tile.cy - Math.min(tile.cellH * 0.18, 22));
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.fillStyle = "rgba(243,239,230,0.68)";
  ctx.fillText(name, tile.cx, tile.cy - Math.min(tile.cellH * 0.07, 10));
  const polePoint = uvToScreen(tile, pole.u, pole.v);
  ctx.beginPath();
  ctx.arc(polePoint[0], polePoint[1], 3, 0, Math.PI * 2);
  ctx.fillStyle = pole.pole === "north" ? "#37c8b1" : "#e86f75";
  ctx.fill();
  ctx.restore();
}

function drawGraticule(ctx, tile, step, sampleStep) {
  ctx.save();
  ctx.lineWidth = 0.85;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let lat = -90 + step; lat < 90; lat += step) {
    drawLonLatLine(ctx, tile, sampleParallel(lat, sampleStep), "rgba(243,239,230,0.20)");
  }
  for (let lon = -180; lon < 180; lon += step) {
    drawLonLatLine(ctx, tile, sampleMeridian(lon, sampleStep), "rgba(55,200,177,0.25)");
  }
  drawLonLatLine(ctx, tile, sampleParallel(0, sampleStep), "rgba(240,179,90,0.55)", 1.15);
  ctx.restore();
}

function sampleParallel(lat, sampleStep) {
  const points = [];
  for (let lon = -180; lon <= 180 + 1e-6; lon += sampleStep) points.push([lon, lat]);
  return points;
}

function sampleMeridian(lon, sampleStep) {
  const points = [];
  for (let lat = -90; lat <= 90 + 1e-6; lat += sampleStep) points.push([lon, lat]);
  return points;
}

function drawLonLatLine(ctx, tile, points, stroke, width = 0.85) {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = width;
  ctx.beginPath();
  let open = false;
  for (const [lon, lat] of points) {
    const projected = lonLatToFaceUV(lon, lat, null, tile.orientationState);
    if (projected.face !== tile.face) {
      open = false;
      continue;
    }
    const point = uvToScreen(tile, projected.u, projected.v);
    if (!open) {
      ctx.moveTo(point[0], point[1]);
      open = true;
    } else {
      ctx.lineTo(point[0], point[1]);
    }
  }
  ctx.stroke();
}

function drawSubdivision(ctx, tile, depth) {
  const triangles = [];
  for (let root = 0; root < 2; root += 1) collectTriangles(rootTriangleVertices(tile.face, root, tile.orientationState, tile.orientation), depth, triangles);

  ctx.save();
  ctx.strokeStyle = "rgba(243,239,230,0.13)";
  ctx.lineWidth = 0.75;
  for (const vertices of triangles) {
    ctx.beginPath();
    vertices.forEach(([u, v], index) => {
      const point = uvToScreen(tile, u, v);
      if (index === 0) ctx.moveTo(point[0], point[1]);
      else ctx.lineTo(point[0], point[1]);
    });
    ctx.closePath();
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(240,179,90,0.36)";
  ctx.lineWidth = 1;
  const [start, end] = splitDiagonalForFace(tile.face, tile.orientationState, tile.orientation);
  const a = uvToScreen(tile, start[0], start[1]);
  const b = uvToScreen(tile, end[0], end[1]);
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.restore();
}

function collectTriangles(vertices, depth, out) {
  if (depth <= 0) {
    out.push(vertices);
    return;
  }
  for (let child = 0; child < 4; child += 1) {
    collectTriangles(childTriangleVertices(vertices, child), depth - 1, out);
  }
}

function drawAddressHighlight(ctx, layout, address, color) {
  for (const tile of layout) {
    if (tile.face !== address.face) continue;
    if (address.variant != null && tile.orientation !== address.variant) continue;
    const vertices = triangleVerticesFromAddress(address, address.orientation);
    ctx.save();
    ctx.beginPath();
    vertices.forEach(([u, v], index) => {
      const point = uvToScreen(tile, u, v);
      if (index === 0) ctx.moveTo(point[0], point[1]);
      else ctx.lineTo(point[0], point[1]);
    });
    ctx.closePath();
    ctx.fillStyle = colorWithAlpha(color, 0.18);
    ctx.strokeStyle = colorWithAlpha(color, 0.92);
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

function drawHoverMarker(ctx, layout, address) {
  for (const tile of layout) {
    if (tile.face !== address.face) continue;
    if (address.variant != null && tile.orientation !== address.variant) continue;
    const [u, v] = address.uv;
    const point = uvToScreen(tile, u, v);
    ctx.save();
    ctx.beginPath();
    ctx.arc(point[0], point[1], 3.6, 0, Math.PI * 2);
    ctx.fillStyle = "#e86f75";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.82)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

export function faceEdgesForDisplay(face) {
  return Object.entries(FACE_EDGE_ADJACENCY[face]).map(([edge, link]) => ({
    label: edge,
    value: `F${link.toFace} ${link.toEdge}${link.reversed ? " reversed" : ""}`,
  }));
}

export function lonLatForHit(hit, orientation) {
  return faceUVToLonLat(hit.tile.face, hit.u, hit.v, orientation);
}

function boundsForPoints(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point[0]),
    minY: Math.min(bounds.minY, point[1]),
    maxX: Math.max(bounds.maxX, point[0]),
    maxY: Math.max(bounds.maxY, point[1]),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function colorWithAlpha(color, alpha) {
  if (color.startsWith("#")) {
    const r = Number.parseInt(color.slice(1, 3), 16);
    const g = Number.parseInt(color.slice(3, 5), 16);
    const b = Number.parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}
