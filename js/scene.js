// Three.js setup: 6 textured face planes with separate map + overlay layers.
// Map layer (faceBase) is updated only when the map source changes.
// Overlay layer (faceOverlay) is a transparent canvas redrawn on every
// graticule / eclipse / highlight change — no map blit needed.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

export function createScene(canvas, container) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a14);
  const a = container.clientWidth / container.clientHeight;
  const camera = new THREE.OrthographicCamera(-a, a, 1, -1, 1, 1000);
  camera.zoom = 1;
  camera.position.set(2.8, 2.0, 2.8);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.AmbientLight(0xffffff, 2));

  // ── Map layer ──────────────────────────────────────────────────────────────
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
    scene.add(mesh);
    return mesh;
  });

  // ── Overlay layer (transparent, always on top) ─────────────────────────────
  const faceOverlay    = FACE_CONFIGS.map(() => makeCanvas(64, true));
  let   faceOverlayTexs = faceOverlay.map(c => makeTexture(c));

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
    scene.add(mesh);
    return mesh;
  });

  function onResize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);
  onResize();

  // Track last-uploaded canvas size per face — tex.image === canvas (same ref),
  // so tex.image.width would always equal base.width after in-place resize.
  const mapUploadedSize    = faceBase.map(c => ({ w: c.width, h: c.height }));
  const overlayUploadedSize = faceOverlay.map(c => ({ w: c.width, h: c.height }));

  // ── compositeMap: refresh map textures after faceBase is updated ───────────
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
      } else {
        faceMapTexs[f].needsUpdate = true;
      }
    }
  }

  // ── compositeOverlay: clear overlay and redraw dynamic content ─────────────
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
      } else {
        faceOverlayTexs[f].needsUpdate = true;
      }
    }
  }

  return {
    renderer, scene, camera, controls,
    faceMeshes, overlayMeshes,
    faceBase, faceOverlay,
    wireMesh: (() => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0x334466, wireframe: true }),
      );
      m.visible = false;
      scene.add(m);
      return m;
    })(),
    compositeMap,
    compositeOverlay,
  };
}
