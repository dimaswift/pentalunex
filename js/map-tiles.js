// Raster tile rendering: per-pixel inverse projection, sample web mercator tiles.
import { DEG, faceXYToLonLat } from './projection.js';

export const TILE_SOURCES = {
  osm:       { url: (z,x,y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, hasNoLabels: false },
  topo:      { url: (z,x,y) => `https://tile.opentopomap.org/${z}/${x}/${y}.png`, hasNoLabels: false },
  positron:  {
    url:         (z,x,y) => `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
    urlNoLabels: (z,x,y) => `https://a.basemaps.cartocdn.com/light_nolabels/${z}/${x}/${y}.png`,
    hasNoLabels: true,
  },
  dark:      {
    url:         (z,x,y) => `https://a.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
    urlNoLabels: (z,x,y) => `https://a.basemaps.cartocdn.com/dark_nolabels/${z}/${x}/${y}.png`,
    hasNoLabels: true,
  },
  voyager:   {
    url:         (z,x,y) => `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
    urlNoLabels: (z,x,y) => `https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/${z}/${x}/${y}.png`,
    hasNoLabels: true,
  },
  satellite: {
    url: (z,x,y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    hasNoLabels: false,
  },
};

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed: ${url}`));
    img.src = url;
  });
}

const tileCache = new Map();
function getTile(url) {
  if (tileCache.has(url)) return tileCache.get(url);
  const p = loadImage(url);
  tileCache.set(url, p);
  return p;
}

const TILE_PX = 256;

export async function renderFaceTiles(canvas, faceIdx, N, zoom, tileUrlFn) {
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const n = Math.pow(2, zoom);

  const needed = new Set();
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const xF = (col + 0.5) / N * 2 - 1;
      const yF = 1 - (row + 0.5) / N * 2;
      const { lat, lon } = faceXYToLonLat(faceIdx, xF, yF);
      const latRad = lat * DEG;
      const tx = Math.floor((lon + 180) / 360 * n);
      const ty = Math.floor((1 - Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI) / 2 * n);
      needed.add(tileUrlFn(zoom, ((tx % n)+n)%n, Math.max(0,Math.min(n-1,ty))));
    }
  }

  const tileImgs = new Map();
  await Promise.all([...needed].map(async url => {
    try { tileImgs.set(url, await getTile(url)); } catch {}
  }));

  const imgData = ctx.createImageData(N, N);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const xF = (col + 0.5) / N * 2 - 1;
      const yF = 1 - (row + 0.5) / N * 2;
      const { lat, lon } = faceXYToLonLat(faceIdx, xF, yF);
      const latRad = lat * DEG;
      const txF = (lon + 180) / 360 * n;
      const tyF = (1 - Math.log(Math.tan(latRad) + 1/Math.cos(latRad)) / Math.PI) / 2 * n;
      const tx = Math.floor(txF), ty = Math.floor(tyF);
      const px = Math.floor((txF - tx) * TILE_PX);
      const py = Math.floor((tyF - ty) * TILE_PX);
      const url = tileUrlFn(zoom, ((tx % n)+n)%n, Math.max(0,Math.min(n-1,ty)));
      const tImg = tileImgs.get(url);
      if (!tImg) continue;

      if (!tImg._ctx) {
        const tc = document.createElement('canvas');
        tc.width = tc.height = TILE_PX;
        tImg._ctx = tc.getContext('2d', { willReadFrequently: true });
        tImg._ctx.drawImage(tImg, 0, 0);
      }
      const pd = tImg._ctx.getImageData(
        Math.max(0, Math.min(TILE_PX-1, px)),
        Math.max(0, Math.min(TILE_PX-1, py)), 1, 1).data;
      const idx = (row * N + col) * 4;
      imgData.data[idx]   = pd[0];
      imgData.data[idx+1] = pd[1];
      imgData.data[idx+2] = pd[2];
      imgData.data[idx+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
}
