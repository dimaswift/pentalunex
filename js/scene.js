// Three.js setup: 6 textured face planes, orbit controls, and a composite()
// helper that re-blits each face's base canvas + overlays into its display
// canvas and refreshes the GL texture.
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

function makeCanvas(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0,0,n,n);
  ctx.strokeStyle = '#334'; ctx.lineWidth = 2; ctx.strokeRect(2,2,n-4,n-4);
  return c;
}

export function createScene(canvas, container) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a14);
  const a = container.clientWidth / container.clientHeight;
  const camera = new THREE.OrthographicCamera(-a, a, 1, -1, 1, 1000 );
  camera.zoom = 1;

  //const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(2.8, 2.0, 2.8);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.AmbientLight(0xffffff, 2));
  //const dLight = new THREE.DirectionalLight(0xffffff, 1);
  //dLight.position.set(3, 5, 3);
  //scene.add(dLight);

  const faceBase    = FACE_CONFIGS.map(() => makeCanvas(64));
  const faceDisplay = FACE_CONFIGS.map(() => makeCanvas(64));
  const faceTextures = faceDisplay.map(cvs => {
    const t = new THREE.CanvasTexture(cvs);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
  const faceMeshes = [];

  FACE_CONFIGS.forEach((cfg, i) => {
    const geo = new THREE.PlaneGeometry(FACE_SIZE, FACE_SIZE);
    const mat = new THREE.MeshLambertMaterial({ map: faceTextures[i], side: THREE.FrontSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...cfg.pos);
    mesh.rotation.set(...cfg.rot);
    mesh.userData.face = i;
    scene.add(mesh);
    faceMeshes.push(mesh);
  });

  const wireMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0x334466, wireframe: true }),
  );
  wireMesh.visible = false;
  scene.add(wireMesh);

  function onResize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);
  onResize();

  // Re-blit base + overlays into display, then refresh GL texture. If the
  // display canvas was resized we must dispose & recreate the texture —
  // CanvasTexture cannot survive a backing-canvas resize on some drivers.
  function composite(drawOverlays) {
    for (let f = 0; f < 6; f++) {
      const base = faceBase[f];
      const disp = faceDisplay[f];
      const sizeChanged = disp.width !== base.width || disp.height !== base.height;
      if (sizeChanged) { disp.width = base.width; disp.height = base.height; }
      const ctx = disp.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, disp.width, disp.height);
      ctx.drawImage(base, 0, 0);
      drawOverlays(ctx, f, disp.width);

      if (sizeChanged) {
        faceTextures[f].dispose();
        const tex = new THREE.CanvasTexture(disp);
        tex.colorSpace = THREE.SRGBColorSpace;
        faceTextures[f] = tex;
        faceMeshes[f].material.map = tex;
        faceMeshes[f].material.needsUpdate = true;
      } else {
        faceTextures[f].needsUpdate = true;
      }
    }
  }

  // Note: faceTextures is intentionally not exported — composite() may
  // replace entries on resize, so a captured reference would go stale.
  return { renderer, scene, camera, controls, faceMeshes, faceBase, faceDisplay, wireMesh, composite };
}
