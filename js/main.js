// UI wiring entry point. Owns the mutable app state (graticule settings,
// eclipse list) and connects DOM events to the scene + overlay modules.
import * as THREE from 'three';
import { faceXYToLatLon } from '../csc.js';
import { FACE_NAMES } from './projection.js';
import { createScene } from './scene.js';
import { TILE_SOURCES, renderFaceTiles } from './map-tiles.js';
import { renderFaceSolid, getCoastlineData } from './map-solid.js';
import { drawGraticule } from './graticule.js';
import { getCellAtPixel, drawGraticuleCellOnFace } from './graticule-cells.js';
import { loadSarosBin, ensureSolarDB, drawEclipseGeometry, getCellsByFace } from './eclipse-overlay.js';
import { exportFaces as exportFacesSvg } from './svg-export.js';

const $ = id => document.getElementById(id);

const canvas = $('three-canvas');
const container = $('canvas-container');
const { renderer, scene, camera, controls, faceMeshes, overlayMeshes,
        faceBase, faceOverlay, wireMesh, compositeMap, compositeOverlay } =
  createScene(canvas, container);

// ── App state ─────────────────────────────────────────────────────────────────
const gratState = { enabled: false, step: 15, width: 1, color: '#ffffff', alpha: 0.5 };
const eclipseState = []; // [{ key, saros, pos, geometry, type, outline, fill, ... }]
const cellHighlight = { face: null, lonIdx: null, latIdx: null };
const exportFaces = new Set(); // face indices selected for SVG export

function compositeAll() {
  compositeOverlay((ctx, f, N) => {
    if (gratState.enabled) drawGraticule(ctx, f, N, gratState);
    for (const ec of eclipseState) {
      if (ec.geometry) drawEclipseGeometry(ctx, f, N, ec.geometry, ec);
    }
    // Draw eclipse cell highlights (cells pre-assigned to faces, no extra check needed)
    for (const ec of eclipseState) {
      if (ec.touchedCells) {
        for (const cell of ec.touchedCells[f]) {
          drawGraticuleCellOnFace(ctx, f, cell.lonIdx, cell.latIdx, gratState.step, N, {
            fill: ec.fill + '22',
            stroke: ec.fill,
            width: 2,
            alpha: 0.5
          });
        }
      }
    }
    // Draw hovered graticule cell (on top)
    if (cellHighlight.face === f && cellHighlight.lonIdx !== null) {
      drawGraticuleCellOnFace(ctx, f, cellHighlight.lonIdx, cellHighlight.latIdx,
        gratState.step, N, {
          fill: 'rgba(0, 255, 100, 0.2)',
          stroke: '#00ff64',
          width: 3,
          alpha: 1
        });
    }
  });
}

// ── Graticule controls ────────────────────────────────────────────────────────
function syncGraticule() {
  gratState.enabled = $('grat-on').checked;
  gratState.step = parseFloat($('grat-step').value) || 15;
  gratState.width = parseFloat($('grat-width').value) || 1;
  gratState.color = $('grat-color').value;
  gratState.alpha = parseFloat($('grat-alpha').value);
  $('grat-alpha-val').textContent = gratState.alpha.toFixed(2);
  compositeAll();
}
['grat-on','grat-step','grat-width','grat-color','grat-alpha']
  .forEach(id => $(id).addEventListener('input', syncGraticule));

// ── Eclipse list ──────────────────────────────────────────────────────────────
// Saros bins we ship live in ./eclipses/{num}.bin. Lookups outside this range
// surface a warning rather than silently failing.
const SAROS_MIN = 101, SAROS_MAX = 173;
{
  const sel = $('saros-select');
  for (let s = SAROS_MIN; s <= SAROS_MAX; s++) {
    const o = document.createElement('option');
    o.value = s; o.textContent = `Saros ${s}`;
    sel.appendChild(o);
  }
}

const DEFAULT_COLORS = ['#ff5566','#55aaff','#ffcc55','#66ff99','#cc66ff','#ff99cc','#99ffcc','#ffaa66'];

async function populateEclipseSelect(num, preselectPos = null) {
  const eclSel = $('eclipse-select');
  eclSel.innerHTML = '<option>loading…</option>';
  let records;
  try { records = await loadSarosBin(num); }
  catch (e) { eclSel.innerHTML = `<option>load failed: ${e.message}</option>`; return; }
  eclSel.innerHTML = '';
  records.forEach((rec, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${i}: ${rec.datetime_utc} (${rec.type})`;
    eclSel.appendChild(o);
  });
  if (preselectPos != null && preselectPos < records.length) eclSel.value = preselectPos;
}

$('saros-select').addEventListener('change', e =>
  populateEclipseSelect(parseInt(e.target.value)));

async function addEclipse(saros, pos) {
  const key = `${saros}-${pos}`;
  if (eclipseState.some(e => e.key === key)) return;
  const idx = eclipseState.length;
  const color = DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
  const entry = {
    key, saros, pos,
    geometry: null, type: null,
    touchedCells: [], // Cache touched cells to avoid recomputation
    outline: color, fill: color, fillEnabled: true,
    width: 2, alpha: 0.9,
    label: `S${saros}-${pos} loading…`,
  };
  eclipseState.push(entry);
  renderEclipseList();
  try {
    const records = await loadSarosBin(saros);
    const rec = records[pos];
    if (!rec) throw new Error(`no record at pos ${pos}`);
    entry.geometry = rec.geometry;
    entry.type = rec.type;
    entry.touchedCells = getCellsByFace(rec.geometry, gratState.step);
    entry.label = `S${saros}-${pos} ${rec.datetime_utc} (${rec.type})`;
    autoSelectEclipseFaces(entry.touchedCells);
    renderEclipseList();
    compositeAll();
  } catch (e) {
    entry.label = `S${saros}-${pos} — ${e.message}`;
    renderEclipseList();
  }
}

function renderEclipseList() {
  const listEl = $('eclipse-list');
  listEl.innerHTML = '';
  eclipseState.forEach((ec, i) => {
    const el = document.createElement('div');
    el.className = 'eclipse-item';
    el.innerHTML = `
      <div class="head">
        <span class="id" title="${ec.label}">${ec.label}</span>
        <button class="danger" data-remove="${i}">×</button>
      </div>
      <div class="row">
        <label>Outline</label><input type="color" data-field="outline" data-i="${i}" value="${ec.outline}">
        <label>Fill</label><input type="color" data-field="fill" data-i="${i}" value="${ec.fill}">
        <label><input type="checkbox" data-field="fillEnabled" data-i="${i}" ${ec.fillEnabled ? 'checked' : ''}> on</label>
      </div>
      <div class="row">
        <label>Width</label>
        <input type="number" data-field="width" data-i="${i}" min="0.5" max="10" step="0.5" value="${ec.width}">
        <label>Alpha</label>
        <input type="range" data-field="alpha" data-i="${i}" min="0" max="1" step="0.05" value="${ec.alpha}">
      </div>
    `;
    listEl.appendChild(el);
  });
  listEl.querySelectorAll('button[data-remove]').forEach(b => b.addEventListener('click', e => {
    eclipseState.splice(parseInt(e.currentTarget.dataset.remove), 1);
    renderEclipseList();
    compositeAll();
  }));
  listEl.querySelectorAll('input[data-field]').forEach(inp => inp.addEventListener('input', e => {
    const i = parseInt(e.currentTarget.dataset.i);
    const f = e.currentTarget.dataset.field;
    const t = e.currentTarget.type;
    const v = t === 'checkbox' ? e.currentTarget.checked
            : (t === 'number' || t === 'range') ? parseFloat(e.currentTarget.value)
            : e.currentTarget.value;
    eclipseState[i][f] = v;
    compositeAll();
  }));
}

$('btn-add-eclipse').addEventListener('click', () => {
  const saros = parseInt($('saros-select').value);
  const pos = parseInt($('eclipse-select').value);
  if (Number.isFinite(saros) && Number.isFinite(pos)) addEclipse(saros, pos);
});

populateEclipseSelect(141, 21);
 $('saros-select').value = 141;
// ── Eclipse search by date ────────────────────────────────────────────────────
// Accepts "YYYY-MM-DD", optional "[ T]HH:MM[:SS]", with optional negative year
// for antiquity (e.g. "-1000-06-15").
function parseSearchDate(s) {
  s = s.trim();
  if (!s) return null;
  const m = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(s);
  if (!m) return null;
  const [, Y, M, D, h='0', mm='0', ss='0'] = m;
  return Math.floor(Date.UTC(+Y, +M - 1, +D, +h, +mm, +ss) / 1000);
}

$('btn-search').addEventListener('click', async () => {
  const resEl = $('search-result');
  const ts = parseSearchDate($('search-date').value);
  if (ts == null) { resEl.textContent = 'bad date'; return; }
  resEl.textContent = 'searching…';
  try {
    const db = await ensureSolarDB();
    const hit = db.findClosest(ts);
    if (!hit) { resEl.textContent = 'no match'; return; }
    const d = new Date(hit.unixTime * 1000).toISOString().replace('T',' ').slice(0,19);
    resEl.textContent = `closest: ${d} (${hit.typeName}) — Saros ${hit.sarosNumber} #${hit.sarosPos}`;
    if (hit.sarosNumber >= SAROS_MIN && hit.sarosNumber <= SAROS_MAX) {
      $('saros-select').value = hit.sarosNumber;
      await populateEclipseSelect(hit.sarosNumber, hit.sarosPos);
    } else {
      resEl.textContent += ` (no bin for Saros ${hit.sarosNumber})`;
    }
  } catch (e) {
    resEl.textContent = `error: ${e.message}`;
  }
});

// ── Map render pipeline ───────────────────────────────────────────────────────
async function renderAllFaces() {
  const N        = parseInt($('tex-res').value);
  const zoom     = parseInt($('zoom-level').value);
  const srcKey   = $('tile-source').value;
  const noLabels = $('no-labels').checked;

  const loading  = $('loading');
  const progress = $('progress');
  const title    = $('loading-title');
  loading.style.display = 'block';

  if (srcKey === 'solid') {
    title.textContent = 'Fetching coastlines…';
    const colors = {
      ocean:      $('ocean-color').value,
      ground:     $('ground-color').value,
      coast:      $('coast-color').value,
      coastWidth: $('coast-width').value,
    };
    try { await getCoastlineData(); }
    catch { progress.textContent = 'Coastline fetch failed'; return; }
    for (let f = 0; f < 6; f++) {
      progress.textContent = `Drawing face ${f+1}/6 — ${FACE_NAMES[f]}…`;
      await renderFaceSolid(faceBase[f], f, N, colors);
    }
  } else {
    const src = TILE_SOURCES[srcKey];
    const tileUrlFn = (noLabels && src.hasNoLabels) ? src.urlNoLabels : src.url;
    for (let f = 0; f < 6; f++) {
      progress.textContent = `Rendering face ${f+1}/6 — ${FACE_NAMES[f]}…`;
      await renderFaceTiles(faceBase[f], f, N, zoom, tileUrlFn);
    }
  }

  compositeMap();
  compositeAll();
  loading.style.display = 'none';
}

$('btn-render').addEventListener('click', renderAllFaces);

function updateSourceVisibility() {
  $('solid-colors').classList.toggle('hidden', $('tile-source').value !== 'solid');
}
$('tile-source').addEventListener('change', updateSourceVisibility);
updateSourceVisibility();

$('tex-res').addEventListener('input', e => $('res-val').textContent = e.target.value);
$('zoom-level').addEventListener('input', e => $('zoom-val').textContent = e.target.value);
$('wire-toggle').addEventListener('change', e => wireMesh.visible = e.target.checked);

let autoRotate = false;
$('auto-rotate').addEventListener('change', e => autoRotate = e.target.checked);

// ── SVG export ────────────────────────────────────────────────────────────────
function renderExportFaces() {
  const container = $('export-faces');
  container.innerHTML = '';
  FACE_NAMES.forEach((name, f) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = exportFaces.has(f);
    cb.addEventListener('change', () => {
      if (cb.checked) exportFaces.add(f); else exportFaces.delete(f);
    });
    label.appendChild(cb);
    label.append(` ${name}`);
    container.appendChild(label);
  });
}
renderExportFaces();

function autoSelectEclipseFaces(touchedCells) {
  // touchedCells is array of 6 arrays; select faces with any touched cells
  touchedCells.forEach((cells, f) => {
    if (cells.length > 0) exportFaces.add(f);
  });
  renderExportFaces();
}

$('btn-export-svg').addEventListener('click', () => {
  const faces = [...exportFaces].sort();
  if (!faces.length) { alert('Select at least one face to export.'); return; }
  const N = faceOverlay[0].width;
  const hatchInterval = parseFloat($('hatch-interval').value) || 0;
  exportFacesSvg(faces, N, gratState, eclipseState, hatchInterval);
});

// ── Import / export ───────────────────────────────────────────────────────────
$('import-files').addEventListener('change', async e => {
  const files = [...e.target.files];
  if (files.length === 0) return;
  if (files.length !== 6) {
    alert(`Select exactly 6 images (got ${files.length}). Order: N, +X, +Y, −X, −Y, S.`);
    return;
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (let i = 0; i < 6; i++) {
    const bmp = await createImageBitmap(files[i]);
    const n = bmp.width;
    faceBase[i].width = faceBase[i].height = n;
    faceBase[i].getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, n, n);
    bmp.close();
  }
  compositeMap();
  compositeAll();
});

$('btn-export').addEventListener('click', () => {
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  for (let i = 0; i < 6; i++) {
    // Composite map + overlay into a temp canvas for PNG export
    const tmp = document.createElement('canvas');
    tmp.width = faceBase[i].width; tmp.height = faceBase[i].height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(faceBase[i], 0, 0);
    ctx.drawImage(faceOverlay[i], 0, 0);
    const url = tmp.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `face_${i}_${stamp}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
});

// ── Hover ray-casting ─────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();
const coordsDiv = $('coords');

function updateCellHighlight(newFace, newLonIdx, newLatIdx) {
  const changed = cellHighlight.face !== newFace ||
                  cellHighlight.lonIdx !== newLonIdx ||
                  cellHighlight.latIdx !== newLatIdx;
  if (changed) {
    cellHighlight.face = newFace;
    cellHighlight.lonIdx = newLonIdx;
    cellHighlight.latIdx = newLatIdx;
    compositeAll();
  }
}

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
  mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(faceMeshes);
  if (hits.length) {
    const hit  = hits[0];
    const face = hit.object.userData.face;
    const xF   = hit.uv.x * 2 - 1;
    const yF   = hit.uv.y * 2 - 1;
    const { lat, lon } = faceXYToLatLon(face, xF, yF);

    // Convert UV coordinates to pixel coordinates and detect cell
    const N = faceOverlay[face].width;
    const px = hit.uv.x * N;
    const py = (1 - hit.uv.y) * N;
    const cell = getCellAtPixel(face, px, py, N, gratState.step);
    updateCellHighlight(face, cell.lonIdx, cell.latIdx);

    coordsDiv.innerHTML =
      `<span>Face:</span> ${face} — ${FACE_NAMES[face]}<br>` +
      `<span>x, y:</span> ${xF.toFixed(3)}, ${yF.toFixed(3)}<br>` +
      `<span>Lat/Lon:</span> ${lat.toFixed(3)}°, ${lon.toFixed(3)}°<br>` +
      `<span>Cell:</span> [${cell.lonIdx}, ${cell.latIdx}]`;
  } else {
    updateCellHighlight(null, null, null);
    coordsDiv.innerHTML = 'Hover over cube…<br><span>Face:</span> —<br><span>x, y:</span> —<br><span>Lat/Lon:</span> —';
  }
});

// ── Render loop ───────────────────────────────────────────────────────────────
let lastTime = 0;
let loadedMap = false;
async function animate(t) {
  if (!loadedMap) {
    await renderAllFaces();
    syncGraticule();
    loadedMap = true;
  }
  requestAnimationFrame(animate);
  controls.update();
  if (autoRotate) {
    const dt = (t - lastTime) / 1000;
    scene.rotation.y += 0.12 * dt;
  }
  lastTime = t;
  renderer.render(scene, camera);
}
animate(0);

$('loading-title').textContent = 'Click "Render Textures" to begin.';
$('progress').textContent = '';
