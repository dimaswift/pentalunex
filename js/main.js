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
import { extractCenterlines, castReflectorRays } from './reflector.js';
import { drawPolylineOnFace } from './projection.js';

const $ = id => document.getElementById(id);

const canvas = $('three-canvas');
const container = $('canvas-container');
const { renderer, scene, camera, controls, faceMeshes, overlayMeshes,
        cubeGroup, sphereGroup,
        faceBase, faceOverlay, wireMesh, compositeMap, compositeOverlay } =
  createScene(canvas, container);

// ── App state ─────────────────────────────────────────────────────────────────
const gratState = { enabled: false, step: 15, width: 1, color: '#ffffff', alpha: 0.5 };
const reflState = { enabled: true, stepDeg: 2, lengthDeg: 120, side: +1 };
const eclipseState = []; // [{ key, saros, pos, geometry, type, outline, fill, ... }]
const cellHighlight = { face: null, lonIdx: null, latIdx: null };
const exportFaces = new Set(); // face indices selected for SVG export

function compositeAll() {
  compositeOverlay((ctx, f, N) => {
    if (gratState.enabled) drawGraticule(ctx, f, N, gratState);
    for (const ec of eclipseState) {
      if (ec.geometry) drawEclipseGeometry(ctx, f, N, ec.geometry, ec);
    }
    // Reflector rays: perpendicular great circles emitted from each centerline
    if (reflState.enabled) {
      for (const ec of eclipseState) {
        if (!ec.reflectorRays) continue;
        const rayOpts = { stroke: '#000000', width: 1, alpha: 0.7 };
        for (const ray of ec.reflectorRays) drawPolylineOnFace(ctx, f, ray, N, rayOpts);
        if (ec.centerlines) {
          const cOpts = { stroke: '#ff3050', width: 2, alpha: 0.9 };
          for (const cl of ec.centerlines)
            if (cl.length > 1) drawPolylineOnFace(ctx, f, cl, N, cOpts);
        }
      }
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

// ── Reflector controls ────────────────────────────────────────────────────────
function syncReflector() {
  reflState.enabled   = $('refl-on').checked;
  reflState.stepDeg   = parseFloat($('refl-step').value)   || 2;
  reflState.lengthDeg = parseFloat($('refl-length').value) || 120;
  reflState.side      = parseInt($('refl-side').value)     || 1;
  // Recompute rays for every loaded eclipse — rays depend on step/length/side
  // but not on the centerline (which only depends on the geometry).
  for (const ec of eclipseState) {
    if (!ec.centerlines) continue;
    ec.reflectorRays = castReflectorRays(ec.centerlines, {
      stepDeg: reflState.stepDeg, side: reflState.side,
      lengthDeg: reflState.lengthDeg, samplesPerRay: 96,
    });
  }
  compositeAll();
}
['refl-on','refl-step','refl-length','refl-side']
  .forEach(id => $(id).addEventListener('input', syncReflector));

// ── Eclipse list ──────────────────────────────────────────────────────────────
// Saros bins we ship live in ./eclipses/{num}.bin. Lookups outside this range
// surface a warning rather than silently failing.
const SAROS_MIN = 69, SAROS_MAX = 173;
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
    // Auto-orient the cube so the eclipse-relevant faces face the camera
    // when viewed at the standard isometric angle.
    autoOrientCube(entry.touchedCells);
    // Treat the totality polygon as a curved mirror: extract centerlines
    // (one per polygon — antimeridian-split paths produce multiple) and cast
    // great-circle rays perpendicular to each.
    entry.centerlines = extractCenterlines(rec.geometry);
    entry.reflectorRays = castReflectorRays(entry.centerlines, {
      stepDeg: reflState.stepDeg, side: reflState.side,
      lengthDeg: reflState.lengthDeg, samplesPerRay: 96,
    });
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
$('sphere-on').addEventListener('change', e => {
  // Hide the sphere and re-centre the cube on origin so it isn't off-balance
  // in the viewport when shown alone.
  const visible = e.target.checked;
  sphereGroup.visible = visible;
  cubeGroup.position.x = visible ? -0.7 : 0;
});

let autoRotate = false;
$('auto-rotate').addEventListener('change', e => autoRotate = e.target.checked);

// ── Mosaic mode ───────────────────────────────────────────────────────────────
// Replace the single-cube view with a 2×2 grid of cube clones. All four cubes
// share the same canvas-textured materials, so a single compositeAll() updates
// every visible face on every cube simultaneously. The grid is centred on the
// origin and laid out in the X-Z plane; viewed through the isometric camera
// (looking along +(1,1,1)/√3), each cube face projects as a perfect rhombus
// and adjacent cubes' external face edges meet exactly at the seams.
const mosaicCubeGroups = []; // the 3 *additional* cubes (the original is repositioned)
let savedSceneState = null;

// Standard isometric: camera looking along (1,1,1)/√3 with +Y as world up.
// In this view each cube face's normal projects to one of three 60°-spaced
// directions on screen, so all faces appear as identical 60°/120° rhombi.
const ISO_DIR      = new THREE.Vector3( 1, 1,  1).normalize();
const ISO_DIR_BACK = new THREE.Vector3(-1, 1, -1).normalize();
function setIsometricCamera(distance, target, fromBack = false) {
  const dir = fromBack ? ISO_DIR_BACK : ISO_DIR;
  camera.position.copy(target).addScaledVector(dir, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  controls.target.copy(target);
}

// Specific camera orientations for PNG export, given as Three.js 'XYZ'-order
// Euler angles in degrees. The camera's local forward is -Z; we apply the
// Euler to (0,0,-1) to get the world-space forward direction, then position
// the camera at `target − forward·distance` so it looks at `target`.
const EXPORT_CAMERA_EULERS = {
  front: { x: -35.264, y: 135, z: 0 },
  back:  { x:  35.264, y: 315, z: 0 },
};
function setExportCamera(view, target, distance) {
  const e = EXPORT_CAMERA_EULERS[view];
  const euler = new THREE.Euler(
    e.x * DEG_TO_RAD, e.y * DEG_TO_RAD, e.z * DEG_TO_RAD, 'XYZ');
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(euler);
  camera.position.copy(target).addScaledVector(forward, -distance);
  camera.rotation.copy(euler);
  camera.up.set(0, 1, 0);
  camera.updateMatrixWorld();
  controls.target.copy(target);
}

// Clone every face mesh (map + overlay) into a new group. Materials and
// geometry are *shared* — we only need a separate Mesh + Group so the clones
// can sit at their own world positions.
function cloneCubeFaceMeshes() {
  const group = new THREE.Group();
  for (const src of [...faceMeshes, ...overlayMeshes]) {
    const clone = new THREE.Mesh(src.geometry, src.material);
    clone.position.copy(src.position);
    clone.rotation.copy(src.rotation);
    clone.userData.face = src.userData.face;
    clone.renderOrder = src.renderOrder;
    group.add(clone);
  }
  return group;
}

// ── Auto-orient cube to expose the eclipse-relevant faces ────────────────────
// A cube viewed at the standard isometric angle shows exactly 3 mutually
// adjacent faces (one corner). We want those 3 to be the ones the eclipse
// touches most, so the path is maximally visible without rotating.
//
// Constraints from CSC:
//   • Faces 0 (N pole) and 5 (S pole) are opposite; only one can be on top.
//   • Faces 1, 2, 3, 4 sit around the equator at lon = 0, 90, 180, 270°.
//     Adjacent equator pairs (90° apart): {1,2}, {2,3}, {3,4}, {4,1}.
//     A pair across the cube (e.g. {1,3}) cannot both be visible.
//
// Pole choice is by hemisphere (more cells in the N hemisphere → N on top).
// Equator pair is the adjacent pair with the highest combined cell count.

// CSC face index → world axis when cube has identity rotation:
//   0 → +Y, 1 → +Z, 2 → +X, 3 → -Z, 4 → -X, 5 → -Y
// The four adjacent equator pairs and the world-Y rotation that places them
// at (+X, +Z) when the cube is upright (top pole = N, no flip):
const EQ_PAIR_TO_Y_ROT_N = {
  '1,2':   0,   // {2 at +X, 1 at +Z}            ← identity
  '1,4':  90,   // {1 at +X, 4 at +Z}            ← yaw +90°
  '3,4': 180,   // {4 at +X, 3 at +Z}            ← yaw 180°
  '2,3': -90,   // {3 at +X, 2 at +Z}            ← yaw -90°
};
// After flipping the cube around X by 180° (S on top), the equator faces
// permute (face 1 swaps with face 3 across the new +Z axis), so the same
// world-Y rotations give different pairs:
const EQ_PAIR_TO_Y_ROT_S = {
  '2,3':   0,
  '3,4': -90,
  '1,4': 180,
  '1,2':  90,
};

function computeBestOrientation(touchedCells) {
  const cellsPerFace = touchedCells.map(arr => arr.length);
  // Pole by hemisphere. Tie → N.
  const top = cellsPerFace[0] >= cellsPerFace[5] ? 0 : 5;

  const pairs = [[1,2], [2,3], [3,4], [4,1]];
  let bestPair = pairs[0], bestSum = -1;
  for (const p of pairs) {
    const sum = cellsPerFace[p[0]] + cellsPerFace[p[1]];
    if (sum > bestSum) { bestSum = sum; bestPair = p; }
  }
  const key = [...bestPair].sort().join(',');
  const yDeg = (top === 0 ? EQ_PAIR_TO_Y_ROT_N : EQ_PAIR_TO_Y_ROT_S)[key];

  return { top, pair: bestPair, yRotDeg: yDeg };
}

function applyOrientation(group, orientation) {
  // Apply X-flip first (if S pole), then world-Y rotation. With quaternions:
  //   q_total = q_worldY · q_flipX  ⇒ rotates v as q_total · v · q_total⁻¹
  //   which is "first flip, then rotate around world Y" — the order we want.
  const flip = new THREE.Quaternion();
  if (orientation.top === 5)
    flip.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  const yaw = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), orientation.yRotDeg * DEG_TO_RAD);
  group.quaternion.multiplyQuaternions(yaw, flip);
}

function autoOrientCube(touchedCells) {
  // Don't override mosaic transforms — each mosaic slot has its own rotation.
  if (mosaicCubeGroups.length) return;
  if (!touchedCells || !touchedCells.length) return;
  applyOrientation(cubeGroup, computeBestOrientation(touchedCells));
}

// Edge-adjacent stair-step layout — each cube touches at least one neighbour
// along an edge (not a face), with rotations chosen so the visible face data
// flows continuously across those shared edges.
const DEG_TO_RAD = Math.PI / 180;
const MOSAIC_TRANSFORMS = [
  { pos: [1,  1, 2], rot: [180, 0, -90] },
  { pos: [2,  0, 2], rot: [180, 0,  90] },
  { pos: [1,  0, 1], rot: [  0, 0, -90] },
  { pos: [2, -1, 1], rot: [  0, 0,  90] },
];
// Geometric centre of the four cube positions — used as the camera lookAt /
// orbit pivot so the mosaic is framed centrally regardless of front/back view.
const MOSAIC_CENTROID = new THREE.Vector3(1.5, 0, 1.5);

function applyTransform(group, t) {
  group.position.set(t.pos[0], t.pos[1], t.pos[2]);
  group.rotation.set(t.rot[0] * DEG_TO_RAD, t.rot[1] * DEG_TO_RAD, t.rot[2] * DEG_TO_RAD);
}

function enterMosaicMode() {
  if (mosaicCubeGroups.length) return;
  savedSceneState = {
    cubePos:    cubeGroup.position.clone(),
    cubeRot:    cubeGroup.rotation.clone(),
    sphereOn:   sphereGroup.visible,
    cameraPos:  camera.position.clone(),
    cameraZoom: camera.zoom,
    controlTgt: controls.target.clone(),
  };
  sphereGroup.visible = false;

  // The original cube becomes mosaic slot 0
  applyTransform(cubeGroup, MOSAIC_TRANSFORMS[0]);
  // 3 clones fill slots 1..3
  for (let i = 1; i < MOSAIC_TRANSFORMS.length; i++) {
    const g = cloneCubeFaceMeshes();
    applyTransform(g, MOSAIC_TRANSFORMS[i]);
    scene.add(g);
    mosaicCubeGroups.push(g);
  }

  setIsometricCamera(8, MOSAIC_CENTROID);
  camera.zoom = 0.45;
  camera.updateProjectionMatrix();
}

function exitMosaicMode() {
  if (!mosaicCubeGroups.length) return;
  for (const g of mosaicCubeGroups) scene.remove(g);
  mosaicCubeGroups.length = 0;
  if (savedSceneState) {
    cubeGroup.position.copy(savedSceneState.cubePos);
    cubeGroup.rotation.copy(savedSceneState.cubeRot);
    sphereGroup.visible = savedSceneState.sphereOn;
    camera.position.copy(savedSceneState.cameraPos);
    camera.zoom = savedSceneState.cameraZoom;
    camera.updateProjectionMatrix();
    controls.target.copy(savedSceneState.controlTgt);
    savedSceneState = null;
  }
}

$('mosaic-on').addEventListener('change', e =>
  e.target.checked ? enterMosaicMode() : exitMosaicMode());

// ── Export composite PNG ──────────────────────────────────────────────────────
// Renders the scene from a fixed isometric angle into an offscreen render
// target (so the output resolution is independent of the on-screen canvas
// size), then reads the pixels back into a 2D canvas and downloads as PNG.
function exportComposite(view /* 'front' | 'back' */) {
  const size = parseInt($('composite-size').value) || 2048;

  // Save current state — we'll temporarily re-aim the camera and renderer
  const prev = {
    pos:    camera.position.clone(),
    up:     camera.up.clone(),
    zoom:   camera.zoom,
    rtSize: renderer.getSize(new THREE.Vector2()),
    target: controls.target.clone(),
  };

  // Use a render target so we can pick the resolution. Ortho camera framing
  // doesn't depend on aspect (we'll fix left/right/top/bottom below).
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
  });

  // Square camera framing for the square render target. The mosaic bounding
  // box is x∈[0.5,2.5], y∈[-1.5,1.5], z∈[0.5,2.5] — projected isometrically
  // it spans ≈3 units vertically and ≈3 horizontally; ±2.6 is a safe margin.
  const half = 2.6;
  const savedFrustum = { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom };
  camera.left = -half; camera.right = half;
  camera.top  =  half; camera.bottom = -half;
  camera.zoom = 1;

  setExportCamera(view, MOSAIC_CENTROID, 10);
  camera.updateProjectionMatrix();

  // Render into the offscreen target
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x0a0a14, 1);
  renderer.clear();
  renderer.render(scene, camera);

  // Read pixels back
  const pixels = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, pixels);
  renderer.setRenderTarget(null);
  rt.dispose();

  // Restore camera
  camera.left = savedFrustum.left;     camera.right  = savedFrustum.right;
  camera.top  = savedFrustum.top;      camera.bottom = savedFrustum.bottom;
  camera.position.copy(prev.pos);
  camera.up.copy(prev.up);
  camera.zoom = prev.zoom;
  camera.updateProjectionMatrix();
  controls.target.copy(prev.target);

  // Flip Y (render targets are bottom-up, image data is top-down) and write
  // into a 2D canvas for PNG encoding
  const canvas2d = document.createElement('canvas');
  canvas2d.width = canvas2d.height = size;
  const ctx = canvas2d.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = y * size * 4;
    img.data.set(pixels.subarray(srcRow, srcRow + size * 4), dstRow);
  }
  ctx.putImageData(img, 0, 0);

  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const a = document.createElement('a');
  a.href = canvas2d.toDataURL('image/png');
  a.download = `composite_${view}_${stamp}.png`;
  document.body.appendChild(a); a.click(); a.remove();
}

$('btn-export-front').addEventListener('click', () => exportComposite('front'));
$('btn-export-back').addEventListener('click',  () => exportComposite('back'));

// ── Export isometric — one PNG per layer ──────────────────────────────────────
// Renders the cube four times (map / graticule / eclipse path / cells) into
// the same offscreen RT and crop box, producing separate transparent PNGs that
// can be composited in any graphics tool.
function exportIsometric() {
  const size  = parseInt($('composite-size').value) || 2048;
  const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);

  const prev = {
    cubePos:      cubeGroup.position.clone(),
    sphereOn:     sphereGroup.visible,
    cameraPos:    camera.position.clone(),
    cameraRot:    camera.rotation.clone(),
    cameraZoom:   camera.zoom,
    frustum:      { left: camera.left, right: camera.right, top: camera.top, bottom: camera.bottom },
    controlTgt:   controls.target.clone(),
    sceneBg:      scene.background,
    rendererClear: renderer.getClearAlpha(),
  };

  sphereGroup.visible = false;
  cubeGroup.position.set(0, 0, 0);
  scene.background = null;

  const half = 0.9;
  camera.left = -half; camera.right = half;
  camera.top  =  half; camera.bottom = -half;
  camera.zoom = 1;
  setIsometricCamera(5, new THREE.Vector3(0, 0, 0));
  camera.updateProjectionMatrix();
  scene.updateMatrixWorld(true);

  // Compute the pixel crop box from the cube's 8 projected corners — reused
  // for every layer so all PNGs are the same dimensions and register exactly.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const v = new THREE.Vector3(
      (i & 1) ? 0.5 : -0.5,
      (i & 2) ? 0.5 : -0.5,
      (i & 4) ? 0.5 : -0.5,
    ).applyMatrix4(cubeGroup.matrixWorld).project(camera);
    const px = (v.x + 1) * 0.5 * size;
    const py = (1 - v.y) * 0.5 * size;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const cropX = Math.max(0, Math.floor(minX));
  const cropY = Math.max(0, Math.floor(minY));
  const cropW = Math.min(size - cropX, Math.ceil(maxX) - cropX);
  const cropH = Math.min(size - cropY, Math.ceil(maxY) - cropY);
  const rtY   = size - (cropY + cropH); // bottom-up Y for readRenderTargetPixels

  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
  });

  // Render current scene state → cropped, Y-flipped canvas.
  function renderCropped() {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    const pixels = new Uint8Array(cropW * cropH * 4);
    renderer.readRenderTargetPixels(rt, cropX, rtY, cropW, cropH, pixels);
    const out = document.createElement('canvas');
    out.width = cropW; out.height = cropH;
    const ctx = out.getContext('2d');
    const img = ctx.createImageData(cropW, cropH);
    for (let y = 0; y < cropH; y++)
      img.data.set(pixels.subarray((cropH - 1 - y) * cropW * 4, (cropH - y) * cropW * 4), y * cropW * 4);
    ctx.putImageData(img, 0, 0);
    return out;
  }

  function download(canvas2d, name) {
    const a = document.createElement('a');
    a.href = canvas2d.toDataURL('image/png');
    a.download = `isometric_${name}_${stamp}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ── Layer 1: map ─────────────────────────────────────────────────────────────
  overlayMeshes.forEach(m => m.visible = false);
  compositeOverlay(() => {});           // clear overlay canvases
  download(renderCropped(), 'map');
  overlayMeshes.forEach(m => m.visible = true);

  // ── Layer 2: graticule lines ──────────────────────────────────────────────────
  faceMeshes.forEach(m => m.visible = false);
  compositeOverlay((ctx, f, N) => {
    if (gratState.enabled) drawGraticule(ctx, f, N, gratState);
  });
  download(renderCropped(), 'graticule');
  faceMeshes.forEach(m => m.visible = true);

  // ── Layer 3: eclipse path (geometry + reflector rays) ─────────────────────────
  faceMeshes.forEach(m => m.visible = false);
  compositeOverlay((ctx, f, N) => {
    for (const ec of eclipseState)
      if (ec.geometry) drawEclipseGeometry(ctx, f, N, ec.geometry, ec);
    if (reflState.enabled) {
      for (const ec of eclipseState) {
        if (!ec.reflectorRays) continue;
        const rayOpts = { stroke: '#000000', width: 1, alpha: 0.7 };
        for (const ray of ec.reflectorRays) drawPolylineOnFace(ctx, f, ray, N, rayOpts);
        if (ec.centerlines) {
          const cOpts = { stroke: '#ff3050', width: 2, alpha: 0.9 };
          for (const cl of ec.centerlines)
            if (cl.length > 1) drawPolylineOnFace(ctx, f, cl, N, cOpts);
        }
      }
    }
  });
  download(renderCropped(), 'eclipse_path');
  faceMeshes.forEach(m => m.visible = true);

  // ── Layer 4: graticule cells ──────────────────────────────────────────────────
  faceMeshes.forEach(m => m.visible = false);
  compositeOverlay((ctx, f, N) => {
    for (const ec of eclipseState) {
      if (!ec.touchedCells) continue;
      for (const cell of ec.touchedCells[f])
        drawGraticuleCellOnFace(ctx, f, cell.lonIdx, cell.latIdx, gratState.step, N,
          { fill: ec.fill + '22', stroke: ec.fill, width: 2, alpha: 0.5 });
    }
  });
  download(renderCropped(), 'cells');
  faceMeshes.forEach(m => m.visible = true);

  // ── Cleanup & restore ─────────────────────────────────────────────────────────
  renderer.setRenderTarget(null);
  rt.dispose();
  cubeGroup.position.copy(prev.cubePos);
  sphereGroup.visible = prev.sphereOn;
  scene.background    = prev.sceneBg;
  camera.position.copy(prev.cameraPos);
  camera.rotation.copy(prev.cameraRot);
  camera.zoom         = prev.cameraZoom;
  camera.left = prev.frustum.left;  camera.right  = prev.frustum.right;
  camera.top  = prev.frustum.top;   camera.bottom = prev.frustum.bottom;
  camera.updateProjectionMatrix();
  controls.target.copy(prev.controlTgt);
  renderer.setClearColor(0x0a0a14, prev.rendererClear);
  compositeAll();
}

$('btn-export-iso').addEventListener('click', exportIsometric);

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
