import {
  FACE_NAMES,
  addressKey,
  lonLatToTriAddress,
  neighborTriangleAddress,
  projectionOrientation,
  topologyManifest,
} from "./spherecube.js";
import { getLandPolygons } from "./natural-earth.js";
import { drawGlobe, drawTrianglePreview } from "./map-render.js";
import { exportAllTriangles, exportSelectedTriangle } from "./exporter.js";
import { createTileConstructor } from "./constructor.js";
import {
  SAROS_NUMBERS,
  eclipseOptionLabel,
  eclipseSignature,
  eclipseStatusLabel,
  loadSarosSeries,
} from "./saros-eclipses.js";
import {
  faceEdgesForDisplay,
  lonLatForHit,
  pickTile,
  renderAtlas,
} from "./renderer.js";

const canvas = document.querySelector("#atlasCanvas");
const ctx = canvas.getContext("2d");
const constructorCanvas = document.querySelector("#constructorCanvas");
const globeCanvas = document.querySelector("#globeCanvas");
const triangleCanvas = document.querySelector("#triangleCanvas");

const controls = {
  lon: document.querySelector("#lonInput"),
  lat: document.querySelector("#latInput"),
  depth: document.querySelector("#depthInput"),
  anchorLon: document.querySelector("#anchorLonInput"),
  anchorLat: document.querySelector("#anchorLatInput"),
  anchorRoll: document.querySelector("#anchorRollInput"),
  graticule: document.querySelector("#graticuleInput"),
  sampling: document.querySelector("#samplingInput"),
  subdivisions: document.querySelector("#subdivisionInput"),
  labels: document.querySelector("#labelsInput"),
  ocean: document.querySelector("#oceanColorInput"),
  land: document.querySelector("#landColorInput"),
  coast: document.querySelector("#coastColorInput"),
  coastWidth: document.querySelector("#coastWidthInput"),
  exportType: document.querySelector("#exportTypeInput"),
  svgScale: document.querySelector("#svgScaleInput"),
  pngResolution: document.querySelector("#pngResolutionInput"),
  mirror: document.querySelector("#mirrorInput"),
  exportBorder: document.querySelector("#exportBorderInput"),
  exportBackside: document.querySelector("#exportBacksideInput"),
  exportGraticule: document.querySelector("#exportGraticuleInput"),
  exportGraticuleColor: document.querySelector("#exportGraticuleColorInput"),
  exportGraticuleWidth: document.querySelector("#exportGraticuleWidthInput"),
  constructorRotation: document.querySelector("#constructorRotationInput"),
  sarosNumber: document.querySelector("#sarosNumberInput"),
  sarosPosition: document.querySelector("#sarosPositionInput"),
  eclipseStroke: document.querySelector("#eclipseStrokeColorInput"),
  eclipseFill: document.querySelector("#eclipseFillColorInput"),
  eclipseWidth: document.querySelector("#eclipseWidthInput"),
};

const outputs = {
  lon: document.querySelector("#lonValue"),
  lat: document.querySelector("#latValue"),
  depth: document.querySelector("#depthValue"),
  anchorLon: document.querySelector("#anchorLonValue"),
  anchorLat: document.querySelector("#anchorLatValue"),
  anchorRoll: document.querySelector("#anchorRollValue"),
  graticule: document.querySelector("#graticuleValue"),
  sampling: document.querySelector("#samplingValue"),
  coastWidth: document.querySelector("#coastWidthValue"),
  svgScale: document.querySelector("#svgScaleValue"),
  pngResolution: document.querySelector("#pngResolutionValue"),
  exportGraticuleWidth: document.querySelector("#exportGraticuleWidthValue"),
  constructorRotation: document.querySelector("#constructorRotationValue"),
  eclipseWidth: document.querySelector("#eclipseWidthValue"),
  progress: document.querySelector("#exportProgress"),
  probe: document.querySelector("#probeList"),
  address: document.querySelector("#addressList"),
  adjacency: document.querySelector("#adjacencyList"),
  status: document.querySelector("#statusStrip"),
};

const views = {
  atlas: document.querySelector("#atlasView"),
  constructor: document.querySelector("#constructorView"),
};

const tabs = {
  atlas: document.querySelector("#atlasTabButton"),
  constructor: document.querySelector("#constructorTabButton"),
};

const state = {
  lon: 0,
  lat: 0,
  depth: 2,
  activeTab: "atlas",
  anchor: {
    lon: 0,
    lat: 0,
    roll: 0,
  },
  orientation: projectionOrientation(),
  graticuleStep: 15,
  sampleStep: 1,
  showSubdivisions: true,
  showLabels: true,
  landPolygons: null,
  mapStyle: {
    ocean: "#102725",
    land: "#b9b39f",
    coast: "#f0dcc0",
    coastWidth: 0.7,
  },
  export: {
    type: "svg",
    svgScale: 512,
    pngResolution: 1024,
    mirror: false,
    border: {
      enabled: true,
    },
    backside: {
      enabled: false,
    },
    graticule: {
      enabled: false,
      color: "#37c8b1",
      width: 0.6,
    },
  },
  globe: {
    lon: 0,
    lat: 20,
  },
  selectedAddress: null,
  selectedVariant: 0,
  constructorRotation: 0,
  eclipse: {
    sarosNumber: null,
    position: 0,
    series: [],
    record: null,
  },
  eclipseStyle: {
    stroke: "#ffd16c",
    fill: "#ffd16c",
    width: 4,
    fillOpacity: 0.28,
  },
  hoverAddress: null,
};

let layout = [];
let cssWidth = 0;
let cssHeight = 0;
let redrawQueued = false;

const tileConstructor = createTileConstructor({
  canvas: constructorCanvas,
  help: document.querySelector("#constructorHelp"),
  seedInput: document.querySelector("#constructorSeedInput"),
  modeValue: document.querySelector("#constructorModeValue"),
  selectionList: document.querySelector("#constructorSelectionList"),
  setStatus: (message) => { outputs.status.textContent = message; },
  renderDefinitionList,
});

function syncFromControls() {
  state.lon = Number(controls.lon.value);
  state.lat = Number(controls.lat.value);
  state.depth = Number(controls.depth.value);
  state.anchor.lon = Number(controls.anchorLon.value);
  state.anchor.lat = Number(controls.anchorLat.value);
  state.anchor.roll = Number(controls.anchorRoll.value);
  state.orientation = projectionOrientation(state.anchor);
  state.graticuleStep = Number(controls.graticule.value);
  state.sampleStep = Number(controls.sampling.value);
  state.showSubdivisions = controls.subdivisions.checked;
  state.showLabels = controls.labels.checked;
  state.mapStyle.ocean = controls.ocean.value;
  state.mapStyle.land = controls.land.value;
  state.mapStyle.coast = controls.coast.value;
  state.mapStyle.coastWidth = Number(controls.coastWidth.value);
  state.export.type = controls.exportType.value;
  state.export.svgScale = Number(controls.svgScale.value);
  state.export.pngResolution = Number(controls.pngResolution.value);
  state.export.mirror = controls.mirror.checked;
  state.export.border.enabled = controls.exportBorder.checked;
  state.export.backside.enabled = controls.exportBackside.checked;
  state.export.graticule.enabled = controls.exportGraticule.checked;
  state.export.graticule.color = controls.exportGraticuleColor.value;
  state.export.graticule.width = Number(controls.exportGraticuleWidth.value);
  state.constructorRotation = Number(controls.constructorRotation.value);
  state.eclipseStyle.stroke = controls.eclipseStroke.value;
  state.eclipseStyle.fill = controls.eclipseFill.value;
  state.eclipseStyle.width = Number(controls.eclipseWidth.value);
  state.selectedAddress = lonLatToTriAddress(state.lon, state.lat, state.depth, state.orientation, state.selectedVariant);

  outputs.lon.value = state.lon.toFixed(2);
  outputs.lat.value = state.lat.toFixed(2);
  outputs.depth.value = String(state.depth);
  outputs.anchorLon.value = String(state.anchor.lon);
  outputs.anchorLat.value = String(state.anchor.lat);
  outputs.anchorRoll.value = String(state.anchor.roll);
  outputs.graticule.value = String(state.graticuleStep);
  outputs.sampling.value = state.sampleStep.toFixed(2);
  outputs.coastWidth.value = state.mapStyle.coastWidth.toFixed(2);
  outputs.svgScale.value = String(state.export.svgScale);
  outputs.pngResolution.value = String(state.export.pngResolution);
  outputs.exportGraticuleWidth.value = state.export.graticule.width.toFixed(2);
  outputs.constructorRotation.value = String(state.constructorRotation);
  outputs.eclipseWidth.value = state.eclipseStyle.width.toFixed(2);
  syncExportVisibility();
  renderInspector();
  tileConstructor.sync({
    depth: state.depth,
    orientation: state.orientation,
    style: state.mapStyle,
    polygons: state.landPolygons,
    seedAddress: state.selectedAddress,
    viewRotation: state.constructorRotation,
    eclipse: selectedEclipseOverlay(),
    eclipseStyle: state.eclipseStyle,
  });
  queueRender();
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  cssWidth = Math.max(1, rect.width);
  cssHeight = Math.max(1, rect.height);
  canvas.width = Math.floor(cssWidth * ratio);
  canvas.height = Math.floor(cssHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  queueRender();
}

function queueRender() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    layout = renderAtlas(ctx, cssWidth, cssHeight, state);
    renderPreviewCanvases();
  });
}

function renderPreviewCanvases() {
  drawTrianglePreview(triangleCanvas, state.selectedAddress, state.landPolygons, state.mapStyle, state.orientation);
  drawGlobe(globeCanvas, state.landPolygons, state.mapStyle, state.globe, { lon: state.lon, lat: state.lat });
}

function renderInspector() {
  const selected = state.selectedAddress;
  const hover = state.hoverAddress;
  renderDefinitionList(outputs.probe, hover ? addressRows(hover, "hover") : [["tile", "none"], ["cursor", "outside atlas"]]);
  renderDefinitionList(outputs.address, addressRows(selected, "selected"));
  renderDefinitionList(outputs.adjacency, faceEdgesForDisplay(selected.face).map((row) => [row.label, row.value]));
}

function addressRows(address, label) {
  const neighbors = [0, 1, 2].map((edge) => {
    const neighbor = neighborTriangleAddress(address, edge, address.depth, state.orientation);
    return `e${edge}->F${neighbor.face}/${neighbor.root}/${neighbor.path.join("") || "root"}`;
  });
  return [
    ["mode", label],
    ["lon", formatNumber(address.lon ?? 0, 6)],
    ["lat", formatNumber(address.lat ?? 0, 6)],
    ["face", `F${address.face} ${FACE_NAMES[address.face]}`],
    ["variant", String(address.variant ?? 0)],
    ["uv", `${formatNumber(address.uv[0], 6)}, ${formatNumber(address.uv[1], 6)}`],
    ["root", `${address.root} ${address.rootName}`],
    ["depth", String(address.depth)],
    ["path", address.path.join("") || "root"],
    ["bits", address.pathBits],
    ["bary", address.barycentric.map((value) => formatNumber(value, 5)).join(", ")],
    ["key", addressKey(address)],
    ["neighbors", neighbors.join("  ")],
  ];
}

function renderDefinitionList(target, rows) {
  target.replaceChildren();
  for (const [term, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (term === "face" || term === "key") dd.className = "accent";
    if (term === "neighbors") dd.className = "warn";
    target.append(dt, dd);
  }
}

function formatNumber(value, digits) {
  return Number(value).toFixed(digits).replace(/\.?0+$/, "");
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function updateHover(event) {
  const point = canvasPoint(event);
  const hit = pickTile(layout, point.x, point.y, state.orientation);
  if (!hit) {
    state.hoverAddress = null;
    outputs.status.textContent = "outside atlas";
    renderInspector();
    queueRender();
    return;
  }
  const lonLat = lonLatForHit(hit, state.orientation);
  const address = lonLatToTriAddress(lonLat.lon, lonLat.lat, state.depth, state.orientation, hit.variant);
  state.hoverAddress = {
    ...address,
    lon: lonLat.lon,
    lat: lonLat.lat,
    uv: [hit.u, hit.v],
    variant: hit.variant,
  };
  outputs.status.textContent = `tile ${hit.tile.tile}  F${hit.tile.face}.${hit.variant}  lon ${formatNumber(lonLat.lon, 3)}  lat ${formatNumber(lonLat.lat, 3)}`;
  renderInspector();
  queueRender();
}

function commitHover() {
  if (!state.hoverAddress) return;
  state.selectedVariant = state.hoverAddress.variant ?? 0;
  controls.lon.value = state.hoverAddress.lon;
  controls.lat.value = state.hoverAddress.lat;
  syncFromControls();
}

function startGlobeDrag(event) {
  globeCanvas.setPointerCapture(event.pointerId);
  state.globeDrag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    lon: state.globe.lon,
    lat: state.globe.lat,
  };
}

function moveGlobeDrag(event) {
  if (!state.globeDrag || state.globeDrag.id !== event.pointerId) return;
  const dx = event.clientX - state.globeDrag.x;
  const dy = event.clientY - state.globeDrag.y;
  state.globe.lon = state.globeDrag.lon - dx * 0.45;
  state.globe.lat = Math.max(-89, Math.min(89, state.globeDrag.lat + dy * 0.35));
  renderPreviewCanvases();
}

function endGlobeDrag(event) {
  if (state.globeDrag?.id === event.pointerId) state.globeDrag = null;
}

function syncExportVisibility() {
  const png = state.export.type === "png";
  document.querySelectorAll(".export-svg-control").forEach((node) => node.classList.toggle("hidden", png));
  document.querySelectorAll(".export-png-control").forEach((node) => node.classList.toggle("hidden", !png));
  document.querySelectorAll(".export-graticule-control").forEach((node) => node.classList.toggle("hidden", !state.export.graticule.enabled));
}

function exportOptions({ includeEclipse = false } = {}) {
  const eclipse = includeEclipse ? selectedEclipseOverlay() : null;
  return {
    type: state.export.type,
    depth: state.depth,
    mirror: state.export.mirror,
    svgScale: state.export.svgScale,
    pngResolution: state.export.pngResolution,
    orientation: state.orientation,
    border: { ...state.export.border },
    backside: { ...state.export.backside },
    graticule: {
      ...state.export.graticule,
      step: state.graticuleStep,
      sampleStep: state.sampleStep,
    },
    style: { ...state.mapStyle },
    eclipse: eclipse ? {
      ...eclipse,
      stroke: state.eclipseStyle.stroke,
      fill: state.eclipseStyle.fill,
      width: state.eclipseStyle.width,
      fillOpacity: state.eclipseStyle.fillOpacity,
    } : null,
  };
}

async function ensureLandPolygons() {
  if (state.landPolygons) return state.landPolygons;
  outputs.status.textContent = "loading Natural Earth";
  state.landPolygons = await getLandPolygons();
  outputs.status.textContent = `Natural Earth loaded (${state.landPolygons.length} polygons)`;
  return state.landPolygons;
}

async function exportSelected() {
  try {
    outputs.status.textContent = "exporting selected";
    const polygons = await ensureLandPolygons();
    const artifact = await exportSelectedTriangle(state.selectedAddress, polygons, exportOptions());
    downloadBlob(artifact.filename, artifact.blob, artifact.blob.type || "application/octet-stream");
    outputs.status.textContent = `exported ${artifact.filename}`;
  } catch (error) {
    outputs.status.textContent = error.message;
  }
}

async function exportAll() {
  try {
    outputs.status.textContent = "exporting all triangles";
    showProgress(0, 1);
    const polygons = await ensureLandPolygons();
    const artifact = await exportAllTriangles(polygons, exportOptions(), (done, total) => {
      outputs.status.textContent = `exporting ${done}/${total}`;
      showProgress(done, total);
    });
    downloadBlob(artifact.filename, artifact.blob, "application/zip");
    outputs.status.textContent = `exported ${artifact.count} triangles`;
    hideProgress();
  } catch (error) {
    outputs.status.textContent = error.message;
    hideProgress();
  }
}

function copyAddress() {
  const payload = JSON.stringify(state.selectedAddress, null, 2);
  navigator.clipboard?.writeText(payload).then(
    () => { outputs.status.textContent = "address JSON copied"; },
    () => { outputs.status.textContent = payload; },
  );
}

function downloadManifest() {
  downloadBlob("sphere-cube-topology.json", JSON.stringify(topologyManifest(state.orientation), null, 2), "application/json");
}

function downloadPng() {
  canvas.toBlob((blob) => {
    if (blob) downloadBlob("sphere-cube-atlas.png", blob, "image/png");
  }, "image/png");
}

function downloadBlob(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function showProgress(done, total) {
  outputs.progress.classList.remove("hidden");
  outputs.progress.max = total || 1;
  outputs.progress.value = done;
}

function hideProgress() {
  outputs.progress.value = 0;
  outputs.progress.classList.add("hidden");
}

function selectedEclipseOverlay() {
  const record = state.eclipse.record;
  if (!record) return null;
  return {
    ...record,
    signature: eclipseSignature(record),
    label: eclipseStatusLabel(record),
  };
}

function populateSarosOptions() {
  controls.sarosNumber.replaceChildren(new Option("None", ""));
  for (const number of SAROS_NUMBERS) {
    controls.sarosNumber.append(new Option(String(number), String(number)));
  }
  controls.sarosPosition.disabled = true;
  controls.sarosPosition.replaceChildren(new Option("Select saros first", ""));
}

async function handleSarosNumberChange() {
  const value = controls.sarosNumber.value;
  if (!value) {
    state.eclipse = { sarosNumber: null, position: 0, series: [], record: null };
    controls.sarosPosition.disabled = true;
    controls.sarosPosition.replaceChildren(new Option("Select saros first", ""));
    syncFromControls();
    outputs.status.textContent = "eclipse overlay off";
    return;
  }

  const sarosNumber = Number(value);
  controls.sarosPosition.disabled = true;
  controls.sarosPosition.replaceChildren(new Option("Loading...", ""));
  outputs.status.textContent = `loading Saros ${sarosNumber}`;
  try {
    const series = await loadSarosSeries(sarosNumber);
    state.eclipse.sarosNumber = sarosNumber;
    state.eclipse.series = series;
    const preferred = series.findIndex((record) => record.type === "T" || record.type === "A" || record.type === "H");
    const position = Math.max(0, preferred);
    state.eclipse.position = position;
    state.eclipse.record = series[position] ?? null;
    renderSarosPositionOptions(series, position);
    syncFromControls();
    outputs.status.textContent = eclipseStatusLabel(state.eclipse.record);
  } catch (error) {
    state.eclipse = { sarosNumber: null, position: 0, series: [], record: null };
    controls.sarosPosition.replaceChildren(new Option("Unavailable", ""));
    controls.sarosPosition.disabled = true;
    outputs.status.textContent = error.message;
    syncFromControls();
  }
}

function renderSarosPositionOptions(series, selectedPosition) {
  controls.sarosPosition.replaceChildren();
  for (const record of series) {
    controls.sarosPosition.append(new Option(eclipseOptionLabel(record), String(record.sarosPosition)));
  }
  controls.sarosPosition.value = String(selectedPosition);
  controls.sarosPosition.disabled = series.length === 0;
}

function handleSarosPositionChange() {
  const position = Number(controls.sarosPosition.value);
  state.eclipse.position = position;
  state.eclipse.record = state.eclipse.series[position] ?? null;
  syncFromControls();
  outputs.status.textContent = eclipseStatusLabel(state.eclipse.record);
}

function setActiveTab(tabName, updateHash = true) {
  state.activeTab = tabName;
  for (const [name, view] of Object.entries(views)) view.classList.toggle("active", name === tabName);
  for (const [name, button] of Object.entries(tabs)) button.classList.toggle("active", name === tabName);
  if (updateHash) {
    const nextHash = tabName === "constructor" ? "#constructor" : "#atlas";
    if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
  }
  const constructorActive = tabName === "constructor";
  document.querySelectorAll(".atlas-side-panel").forEach((node) => node.classList.toggle("hidden", constructorActive));
  document.querySelector("#constructorPanel").classList.toggle("hidden", !constructorActive);
  document.querySelector("#constructorTreePanel").classList.toggle("hidden", !constructorActive);
  tileConstructor.setActive(constructorActive);
  requestAnimationFrame(() => {
    resizeCanvas();
    tileConstructor.resize();
  });
}

async function exportConstructed() {
  try {
    outputs.status.textContent = "exporting constructed set";
    const polygons = await ensureLandPolygons();
    const artifact = await tileConstructor.exportTileSet(polygons, exportOptions({ includeEclipse: true }));
    downloadBlob(artifact.filename, artifact.blob, artifact.blob.type || "application/octet-stream");
    outputs.status.textContent = `exported ${artifact.filename}`;
  } catch (error) {
    outputs.status.textContent = error.message;
  }
}

function exportTileJson() {
  downloadBlob("constructed-tile-set.json", tileConstructor.exportJson(), "application/json");
  outputs.status.textContent = "exported constructed-tile-set.json";
}

function loadTileJson() {
  document.querySelector("#tileJsonInput").click();
}

async function handleTileJsonFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    tileConstructor.loadJson(await file.text());
    outputs.status.textContent = `loaded ${file.name}`;
  } catch (error) {
    outputs.status.textContent = error.message;
  } finally {
    event.target.value = "";
  }
}

for (const [name, control] of Object.entries(controls)) {
  if (!["constructorRotation", "sarosNumber", "sarosPosition"].includes(name)) {
    control.addEventListener("input", syncFromControls);
  }
}
controls.constructorRotation.addEventListener("input", syncConstructorRotation);
controls.sarosNumber.addEventListener("change", handleSarosNumberChange);
controls.sarosPosition.addEventListener("change", handleSarosPositionChange);

function syncConstructorRotation() {
  state.constructorRotation = Number(controls.constructorRotation.value);
  outputs.constructorRotation.value = String(state.constructorRotation);
  tileConstructor.setViewRotation(state.constructorRotation);
}

document.querySelector("#copyAddressButton").addEventListener("click", copyAddress);
document.querySelector("#downloadManifestButton").addEventListener("click", downloadManifest);
document.querySelector("#exportSelectedButton").addEventListener("click", exportSelected);
document.querySelector("#exportAllButton").addEventListener("click", exportAll);
document.querySelector("#atlasTabButton").addEventListener("click", () => setActiveTab("atlas"));
document.querySelector("#constructorTabButton").addEventListener("click", () => setActiveTab("constructor"));
document.querySelector("#addTileButton").addEventListener("click", () => tileConstructor.placeSeed());
document.querySelector("#reseedButton").addEventListener("click", () => {
  const value = document.querySelector("#constructorSeedInput").value.trim();
  tileConstructor.reseed(value);
});
document.querySelector("#clearConstructorButton").addEventListener("click", () => tileConstructor.clear());
document.querySelector("#exportConstructedButton").addEventListener("click", exportConstructed);
document.querySelector("#exportTileJsonButton").addEventListener("click", exportTileJson);
document.querySelector("#loadTileJsonButton").addEventListener("click", loadTileJson);
document.querySelector("#tileJsonInput").addEventListener("change", handleTileJsonFile);
document.addEventListener("keydown", (event) => {
  tileConstructor.handleKey(event);
});
window.addEventListener("hashchange", () => {
  setActiveTab(window.location.hash === "#constructor" ? "constructor" : "atlas", false);
});
canvas.addEventListener("mousemove", updateHover);
canvas.addEventListener("mouseleave", () => {
  state.hoverAddress = null;
  outputs.status.textContent = "ready";
  renderInspector();
  queueRender();
});
canvas.addEventListener("click", commitHover);
globeCanvas.addEventListener("pointerdown", startGlobeDrag);
globeCanvas.addEventListener("pointermove", moveGlobeDrag);
globeCanvas.addEventListener("pointerup", endGlobeDrag);
globeCanvas.addEventListener("pointercancel", endGlobeDrag);

new ResizeObserver(resizeCanvas).observe(canvas);
new ResizeObserver(() => tileConstructor.resize()).observe(constructorCanvas);
new ResizeObserver(() => queueRender()).observe(globeCanvas);
new ResizeObserver(() => queueRender()).observe(triangleCanvas);
populateSarosOptions();
syncFromControls();
setActiveTab(window.location.hash === "#constructor" ? "constructor" : "atlas", false);

outputs.status.textContent = "loading Natural Earth";
getLandPolygons().then((polygons) => {
  state.landPolygons = polygons;
  outputs.status.textContent = `Natural Earth loaded (${polygons.length} polygons)`;
  tileConstructor.sync({
    depth: state.depth,
    orientation: state.orientation,
    style: state.mapStyle,
    polygons: state.landPolygons,
    seedAddress: state.selectedAddress,
    viewRotation: state.constructorRotation,
    eclipse: selectedEclipseOverlay(),
    eclipseStyle: state.eclipseStyle,
  });
  queueRender();
}).catch((error) => {
  outputs.status.textContent = error.message;
  queueRender();
});
