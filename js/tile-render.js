// Self-contained face-tile renderer for the tile-building game.
//
// Given a canvas and a face index, paints:
//   1. the map background (loaded from a folder or explicit URL)
//   2. an optional graticule overlay
//   3. eclipse paths and highlighted graticule cells
// — and optionally mirrors the whole composition along the x-axis.
//
// Why mirror at the canvas-context level?
// A face-mirror is the visual operation of flipping a tile so its eastern
// edge meets a neighbour's western edge (and vice-versa). If we mirrored only
// the map but drew overlays normally, the eclipse path would land at the
// *original* lat/lon's pixel position, leaving overlays out of sync with the
// flipped map. By applying `translate + scale(-1, 1)` once at the top, every
// subsequent ctx.drawImage / ctx.stroke / ctx.fill (map blit, graticule lines,
// eclipse polygons, cell highlights) is mirrored together — stays consistent
// without per-feature flip logic.

import { drawGraticule } from './graticule.js';
import { drawEclipseGeometry } from './eclipse-overlay.js';
import { drawGraticuleCellOnFace } from './graticule-cells.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error(`tile-render: failed to load ${url}`));
    img.src = url;
  });
}

function resolveMapUrl(opts) {
  if (opts.mapUrl) return opts.mapUrl;
  if (opts.mapFolder) {
    const base = opts.mapFolder.replace(/\/+$/, '');
    return `${base}/face_${opts.face}.png`;
  }
  return null;
}

/**
 * Render one cube face into a canvas.
 *
 * @param canvas  HTMLCanvasElement to draw into; resized to size × size.
 * @param opts    {
 *   face:       0..5,                       // which cube face to render
 *   size:       number,                     // output pixel size, default 1024
 *   mirrored:   boolean,                    // flip horizontally, default false
 *
 *   mapUrl:     string,                     // explicit URL to the face image
 *   mapFolder:  string,                     // OR folder; loads `${folder}/face_${face}.png`
 *
 *   graticule:  {                           // optional graticule overlay
 *     enabled, step, width, color, alpha,
 *   },
 *
 *   eclipses:   [                           // optional eclipses
 *     {
 *       geometry,                           // GeoJSON Polygon/MultiPolygon/LineString
 *       type, outline, fill, fillEnabled,   // forwarded to drawEclipseGeometry
 *       width, alpha,
 *       touchedCells,                       // optional [Array<{lonIdx,latIdx}>; 6]
 *       highlightFill,                      // optional cell-highlight overrides
 *       highlightStroke,
 *       highlightWidth,
 *       highlightAlpha,
 *     }
 *   ],
 * }
 * @returns Promise<void> — resolves once the map image has loaded and all
 *          drawing is complete. Rejects if the map image fails to load.
 */
export async function renderFaceTile(canvas, opts) {
  const N        = opts.size ?? 1024;
  const face     = opts.face;
  const mirrored = !!opts.mirrored;

  if (!Number.isInteger(face) || face < 0 || face > 5)
    throw new Error(`tile-render: face must be 0..5, got ${face}`);

  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, N, N);

  ctx.save();
  if (mirrored) {
    // Mirror across the vertical centre axis of the tile.
    ctx.translate(N, 0);
    ctx.scale(-1, 1);
  }

  // 1. Map background (optional — game tiles may be drawn from scratch)
  const mapUrl = resolveMapUrl(opts);
  if (mapUrl) {
    const img = await loadImage(mapUrl);
    ctx.drawImage(img, 0, 0, N, N);
  }

  // 2. Graticule
  if (opts.graticule?.enabled) {
    drawGraticule(ctx, face, N, opts.graticule);
  }

  // 3. Eclipse paths first (under the cell highlights), then highlighted cells
  const step = opts.graticule?.step ?? 15;
  if (opts.eclipses?.length) {
    for (const ec of opts.eclipses) {
      if (ec.geometry) drawEclipseGeometry(ctx, face, N, ec.geometry, ec);
    }
    for (const ec of opts.eclipses) {
      const cells = ec.touchedCells?.[face];
      if (!cells?.length) continue;
      const fillBase = ec.highlightFill ?? (ec.fill ? ec.fill + '22' : null);
      const strokeBase = ec.highlightStroke ?? ec.fill ?? '#ffffff';
      const widthBase  = ec.highlightWidth  ?? 2;
      const alphaBase  = ec.highlightAlpha  ?? 0.5;
      for (const cell of cells) {
        drawGraticuleCellOnFace(ctx, face, cell.lonIdx, cell.latIdx, step, N, {
          fill: fillBase, stroke: strokeBase, width: widthBase, alpha: alphaBase,
        });
      }
    }
  }

  ctx.restore();
}
