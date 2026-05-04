// Three.js setup: 6 textured face planes with separate map + overlay layers.
// Map layer (faceBase) is updated only when the map source changes.
// Overlay layer (faceOverlay) is a transparent canvas redrawn on every
// graticule / eclipse / highlight change — no map blit needed.
//
// Two parallel views share the same canvas textures:
//   - cubeGroup:   six flat quads forming a cube (the actual COBE CSC layout)
//   - sphereGroup: six gnomonic-inverse patches forming a unit sphere
//                  (verification view — same map drawn on real geometry)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FACE_FRAMES } from './projection.js';

const FACE_SIZE = 1.0;
const FACE_CONFIGS = [
  { pos: [0, 0.5, 0], rot: [-Math.PI / 2, 0, 0] },
  { pos: [0, 0, 0.5], rot: [0, 0, 0] },
  { pos: [0.5, 0, 0], rot: [0, Math.PI / 2, 0] },
  { pos: [0, 0, -0.5], rot: [0, Math.PI, 0] },
  { pos: [-0.5, 0, 0], rot: [0, -Math.PI / 2, 0] },
  { pos: [0, -0.5, 0], rot: [Math.PI / 2, 0, Math.PI] },
];

function makeCanvas(n, transparent = false) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  if (!transparent) {
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, n, n);
    ctx.strokeStyle = '#334'; ctx.lineWidth = 2; ctx.strokeRect(2, 2, n-4, n-4);
  }
  return c;
}

function makeTexture(canvas, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Build a sphere patch covering one cube face's solid angle. Plane vertices
// at (x,y) ∈ [-1,1]² are projected to the sphere by the gnomonic inverse:
//   normalize(east·x + north·y + normal)
// — exactly matching the cube face's gnomonic forward projection. The
// PlaneGeometry's default UV mapping (xy → uv ∈ [0,1]²) keeps face textures
// aligned. The six patches together tile the unit sphere with no gaps.
function makeSpherePatch(face, segments = 24) {
  const f = FACE_FRAMES[face];
  const geo = new THREE.PlaneGeometry(2, 2, segments, segments);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const dx = f.east[0]*x + f.north[0]*y + f.normal[0];
    const dy = f.east[1]*x + f.north[1]*y + f.normal[1];
    const dz = f.east[2]*x + f.north[2]*y + f.normal[2];
    const len = Math.hypot(dx, dy, dz);
    pos.setXYZ(i, dx/len, dy/len, dz/len);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

export function createScene(canvas, container) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a14);
  const a = container.clientWidth / container.clientHeight;
  const camera = new THREE.OrthographicCamera(-a, a, 1, -1, 1, 1000);
  // Zoomed out a touch so both the cube (left) and sphere (right) fit on
  // most aspect ratios with room for the user to orbit.
  camera.zoom = 0.7;
  camera.updateProjectionMatrix();
  camera.position.set(2.8, 2.0, 2.8);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.AmbientLight(0xffffff, 2));

  // ── Groups ────────────────────────────────────────────────────────────────
  // cube ←→ sphere placed symmetrically about origin so OrbitControls (which
  // pivots on origin) keeps both centred as the user rotates.
  const cubeGroup = new THREE.Group();
  cubeGroup.position.set(-0.7, 0, 0);
  scene.add(cubeGroup);

  const sphereGroup = new THREE.Group();
  sphereGroup.position.set(0.7, 0, 0);
  sphereGroup.scale.setScalar(0.5); // sphere radius 0.5 to match cube half-side
  scene.add(sphereGroup);

  // ── Map layer (shared canvases, two meshes per face) ──────────────────────
  const faceBase     = FACE_CONFIGS.map(() => makeCanvas(64));
  let   faceMapTexs  = faceBase.map(c => makeTexture(c));

  const faceMeshes = FACE_CONFIGS.map((cfg, i) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(FACE_SIZE, FACE_SIZE),
      new THREE.MeshLambertMaterial({ map: faceMapTexs[i], side: THREE.FrontSide }),
    );
    mesh.position.set(...cfg.pos);
    mesh.rotation.set(...cfg.rot);
    mesh.userData.face = i;
    mesh.renderOrder = 0;
    cubeGroup.add(mesh);
    return mesh;
  });

  const spherePatches = FACE_CONFIGS.map((_, i) => makeSpherePatch(i));
  const sphereMapMeshes = spherePatches.map((geo, i) => {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshLambertMaterial({ map: faceMapTexs[i], side: THREE.FrontSide }),
    );
    mesh.userData.face = i;
    mesh.renderOrder = 0;
    sphereGroup.add(mesh);
    return mesh;
  });

  // ── Overlay layer (transparent) ───────────────────────────────────────────
  const faceOverlay     = FACE_CONFIGS.map(() => makeCanvas(64, true));
  let   faceOverlayTexs = faceOverlay.map(c => makeTexture(c));

  // Cube overlay: depthTest off because the overlay quad is coplanar with
  // its map quad — no z-fighting concern, and we want it always on top.
  const overlayMeshes = FACE_CONFIGS.map((cfg, i) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(FACE_SIZE, FACE_SIZE),
      new THREE.MeshBasicMaterial({
        map: faceOverlayTexs[i],
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    );
    mesh.position.set(...cfg.pos);
    mesh.rotation.set(...cfg.rot);
    mesh.userData.face = i;
    mesh.renderOrder = 1;
    cubeGroup.add(mesh);
    return mesh;
  });

  // Sphere overlay: depthTest *on* with a tiny outward scale, so the back
  // hemisphere of the sphere doesn't bleed overlay through the front. The
  // overlay sits ~0.05% outside the map sphere → its depth is closer to the
  // camera than the map, so it always wins on the visible (front) hemisphere.
  const sphereOverlayMeshes = spherePatches.map((geo, i) => {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: faceOverlayTexs[i],
        transparent: true,
        depthTest: true,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    );
    mesh.userData.face = i;
    mesh.renderOrder = 1;
    mesh.scale.setScalar(1.0005);
    sphereGroup.add(mesh);
    return mesh;
  });

  function onResize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    const ar = w / h;
    camera.left = -ar; camera.right = ar;
    camera.top = 1;    camera.bottom = -1;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);
  onResize();

  // Track last-uploaded canvas size per face — tex.image === canvas (same ref),
  // so tex.image.width would always equal base.width after in-place resize.
  const mapUploadedSize     = faceBase.map(c => ({ w: c.width, h: c.height }));
  const overlayUploadedSize = faceOverlay.map(c => ({ w: c.width, h: c.height }));

  // ── compositeMap: refresh map textures after faceBase is updated ──────────
  function compositeMap() {
    for (let f = 0; f < 6; f++) {
      const base = faceBase[f];
      const prev = mapUploadedSize[f];
      const sizeChanged = base.width !== prev.w || base.height !== prev.h;
      if (sizeChanged) {
        prev.w = base.width; prev.h = base.height;
        faceMapTexs[f].dispose();
        faceMapTexs[f] = makeTexture(base);
        faceMeshes[f].material.map = faceMapTexs[f];
        faceMeshes[f].material.needsUpdate = true;
        sphereMapMeshes[f].material.map = faceMapTexs[f];
        sphereMapMeshes[f].material.needsUpdate = true;
      } else {
        faceMapTexs[f].needsUpdate = true;
      }
    }
  }

  // ── compositeOverlay: clear overlay and redraw dynamic content ────────────
  function compositeOverlay(drawOverlays) {
    for (let f = 0; f < 6; f++) {
      const ov   = faceOverlay[f];
      const base = faceBase[f];

      // Resize overlay canvas to match map if needed
      if (ov.width !== base.width || ov.height !== base.height) {
        ov.width = base.width; ov.height = base.height;
      }

      const ctx = ov.getContext('2d');
      ctx.clearRect(0, 0, ov.width, ov.height);
      drawOverlays(ctx, f, ov.width);

      // Use tracked size to detect when WebGL texture needs recreation
      const prev = overlayUploadedSize[f];
      const sizeChanged = ov.width !== prev.w || ov.height !== prev.h;
      if (sizeChanged) {
        prev.w = ov.width; prev.h = ov.height;
        faceOverlayTexs[f].dispose();
        faceOverlayTexs[f] = makeTexture(ov);
        overlayMeshes[f].material.map = faceOverlayTexs[f];
        overlayMeshes[f].material.needsUpdate = true;
        sphereOverlayMeshes[f].material.map = faceOverlayTexs[f];
        sphereOverlayMeshes[f].material.needsUpdate = true;
      } else {
        faceOverlayTexs[f].needsUpdate = true;
      }
    }
  }

  return {
    renderer, scene, camera, controls,
    faceMeshes, overlayMeshes,
    sphereMapMeshes, sphereOverlayMeshes,
    cubeGroup, sphereGroup,
    faceBase, faceOverlay,
    wireMesh: (() => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0x334466, wireframe: true }),
      );
      m.visible = false;
      cubeGroup.add(m);
      return m;
    })(),
    compositeMap,
    compositeOverlay,
  };
}
