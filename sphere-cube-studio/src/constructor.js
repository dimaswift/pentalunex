import {
  FACE_NAMES,
  addressKey,
  childTriangleVertices,
  isoChirality,
  isoProjectFaceUV,
  neighborTriangleAddress,
  packPath,
  rootTriangleName,
  rootTriangleVertices,
  triangleVerticesFromAddress,
  uvToTriAddress,
} from "./spherecube.js";
import {
  renderBacksideSvgFragment,
  renderEclipseSvgFragment,
  renderTriangleSvgFragment,
  tileBacksideLabel,
} from "./exporter.js";
import { drawEclipseOnTriangle, drawLandOnTriangle } from "./map-render.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const EDGE_KEYS = ["1", "2", "3"];
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 4;
const MAX_MAP_CACHE_ITEMS = 180;

export function createTileConstructor(config) {
  const state = {
    pieces: [],
    selectedPieceId: null,
    seedAddress: null,
    seedKey: "",
    mirrorMode: false,
    depth: 0,
    orientation: null,
    style: null,
    polygons: null,
    eclipses: [],
    eclipseStyle: { stroke: "#ffd16c", fill: "#ffd16c", width: 4, fillOpacity: 0.28 },
    mapCache: new Map(),
    cacheSignature: "",
    active: false,
    nextId: 1,
    gridSide: 80,
    unitScale: 320,
    view: { x: 0, y: 0, scale: 1, rotation: 0 },
    visibleBounds: { minX: -1, minY: -1, maxX: 1, maxY: 1 },
    candidateCache: { signature: "", candidates: [] },
    pan: null,
    size: { width: 1, height: 1, ratio: 1 },
  };

  config.canvas.addEventListener("pointerdown", handlePointerDown);
  config.canvas.addEventListener("pointermove", handlePointerMove);
  config.canvas.addEventListener("pointerup", handlePointerUp);
  config.canvas.addEventListener("pointercancel", handlePointerUp);
  config.canvas.addEventListener("wheel", handleWheel, { passive: false });
  config.seedInput.addEventListener("input", () => {
    state.seedKey = config.seedInput.value.trim();
    updateSelectionList();
  });

  return {
    sync,
    setViewRotation,
    setActive,
    resize,
    render,
    placeSeed,
    reseed,
    clear,
    exportJson,
    loadJson,
    exportTileSet,
    handleKey,
  };

  function sync(next) {
    state.depth = next.depth;
    state.orientation = next.orientation;
    state.view.rotation = Number(next.viewRotation ?? state.view.rotation ?? 0);
    state.style = next.style;
    state.polygons = next.polygons;
    state.eclipses = normalizeEclipses(next);
    state.eclipseStyle = next.eclipseStyle ?? state.eclipseStyle;
    state.gridSide = gridSideForDepth(state.depth);
    state.unitScale = state.gridSide * (2 ** state.depth);
    const cacheSignature = [
      state.polygons?.length ?? 0,
      state.eclipses.map((eclipse) => eclipse.signature).join(",") || "no-eclipse",
      state.eclipseStyle?.stroke,
      state.eclipseStyle?.fill,
      state.eclipseStyle?.width,
      state.eclipseStyle?.fillOpacity,
      state.style?.ocean,
      state.style?.land,
      state.style?.coast,
      state.style?.coastWidth,
      state.orientation?.lon,
      state.orientation?.lat,
      state.orientation?.roll,
      state.gridSide,
    ].join(":");
    if (cacheSignature !== state.cacheSignature) {
      state.cacheSignature = cacheSignature;
      state.mapCache.clear();
    }

    if (next.seedAddress && state.pieces.length === 0) {
      state.seedAddress = cloneAddress(next.seedAddress);
      state.seedKey = addressVariantKey(state.seedAddress);
      config.seedInput.value = state.seedKey;
    }

    renderHelp();
    updateSelectionList();
    render();
  }

  function setActive(active) {
    state.active = active;
    render();
  }

  function setViewRotation(rotation) {
    state.view.rotation = Number(rotation) || 0;
    render();
  }

  function resize() {
    measureCanvas();
    render();
  }

  function measureCanvas() {
    const rect = config.canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    state.size = {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
      ratio,
    };
    config.canvas.width = Math.floor(state.size.width * ratio);
    config.canvas.height = Math.floor(state.size.height * ratio);
  }

  function render() {
    const ctx = config.canvas.getContext("2d");
    const { width, height, ratio } = state.size;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawBackground(ctx, width, height);

    ctx.save();
    ctx.translate(state.view.x, state.view.y);
    ctx.scale(state.view.scale, state.view.scale);
    ctx.rotate(state.view.rotation * Math.PI / 180);
    state.visibleBounds = visibleWorldBounds();
    drawTriangularGrid(ctx, state.visibleBounds);
    const candidates = buildCandidates();
    for (const candidate of candidates) {
      if (isPieceVisible(candidate.piece)) drawCandidate(ctx, candidate);
    }
    for (const piece of state.pieces) {
      if (isPieceVisible(piece)) drawPiece(ctx, piece);
    }
    const selected = selectedPiece();
    if (selected) drawEdgeLabels(ctx, selected);
    ctx.restore();

    if (!state.pieces.length) {
      drawEmptyState(ctx, width, height);
    }
  }

  function renderHelp() {
    config.help.replaceChildren();
    const rows = [
      ["Grid", `depth ${state.depth}, cell ${Math.round(state.gridSide)}px`],
      ["Seed", "uses the selected atlas triangle by default"],
      ["Click", "empty legal cell paints a tile"],
      ["Shift click", "deletes an existing tile"],
      ["Wheel", "zooms toward the cursor"],
      ["Drag", "pans from empty canvas space"],
      ["Rotate", "uses the constructor orientation slider"],
      ["Space", "toggles regular/mirror paint mode"],
      ["1 2 3", "paint from selected edge"],
    ];
    for (const [label, value] of rows) {
      const item = document.createElement("div");
      const strong = document.createElement("strong");
      const span = document.createElement("span");
      strong.textContent = label;
      span.textContent = value;
      item.append(strong, span);
      config.help.append(item);
    }
  }

  function placeSeed() {
    measureCanvas();
    let address;
    try {
      address = parseSeedKey(state.seedKey || config.seedInput.value.trim());
    } catch (error) {
      config.setStatus(error.message);
      return;
    }
    state.pieces = [];
    state.nextId = 1;
    const piece = createPiece(address, state.mirrorMode, 0, 0, 0);
    const center = screenToWorldPoint({ x: state.size.width * 0.5, y: state.size.height * 0.5 });
    centerPiece(piece, center.x, center.y);
    state.pieces.push(piece);
    state.selectedPieceId = piece.id;
    state.candidateCache.signature = "";
    updateSelectionList();
    render();
    config.setStatus(`seeded ${pieceLabel(piece)}`);
  }

  function clear() {
    state.pieces = [];
    state.selectedPieceId = null;
    state.nextId = 1;
    state.candidateCache.signature = "";
    updateSelectionList();
    render();
    config.setStatus("constructor cleared");
  }

  function reseed(newSeedKey) {
    if (!state.pieces.length) {
      config.setStatus("no tiles to reseed");
      return;
    }
    let newSeedAddress;
    try {
      newSeedAddress = parseSeedKey(newSeedKey ?? state.seedKey);
    } catch (error) {
      config.setStatus(error.message);
      return;
    }
    const anchor = selectedPiece() ?? state.pieces[0];
    // BFS from the anchor, recomputing each piece's address based on the chain of
    // geometric adjacencies. Pieces that share an address with their neighbour and
    // differ only in chirality are treated as mirror pairs (same new address).
    const newAddresses = new Map();
    newAddresses.set(anchor.id, newSeedAddress);
    const queue = [anchor.id];
    while (queue.length) {
      const pieceId = queue.shift();
      const piece = state.pieces.find((p) => p.id === pieceId);
      const newAddr = newAddresses.get(pieceId);
      for (let edge = 0; edge < 3; edge += 1) {
        const adj = adjacentPlacedPiece(piece, edge);
        if (!adj || newAddresses.has(adj.id)) continue;
        const sameAddress = addressKey(adj.address) === addressKey(piece.address);
        const oppositeMirror = Boolean(adj.mirrored) !== Boolean(piece.mirrored);
        const adjAddr = sameAddress && oppositeMirror
          ? cloneAddress(newAddr)
          : neighborTriangleAddress(
              newAddr,
              edge,
              newAddr.depth,
              state.orientation,
              adj.address.variant ?? adj.variant ?? 0,
            );
        newAddresses.set(adj.id, adjAddr);
        queue.push(adj.id);
      }
    }
    const unreached = state.pieces.filter((piece) => !newAddresses.has(piece.id));
    for (const piece of state.pieces) {
      const addr = newAddresses.get(piece.id);
      if (!addr) continue;
      piece.address = cloneAddress({ ...piece.address, ...addr, orientation: state.orientation });
      piece.variant = addr.variant ?? piece.variant ?? 0;
    }
    state.seedKey = addressVariantKey(newSeedAddress);
    state.seedAddress = newSeedAddress;
    config.seedInput.value = state.seedKey;
    state.mapCache.clear();
    state.candidateCache.signature = "";
    updateSelectionList();
    render();
    const warning = unreached.length ? ` (${unreached.length} disconnected piece${unreached.length === 1 ? "" : "s"} kept old address)` : "";
    config.setStatus(`re-seeded to ${state.seedKey}${warning}`);
  }

  function handleKey(event) {
    if (!state.active) return false;
    if (event.key === " ") {
      state.mirrorMode = !state.mirrorMode;
      state.candidateCache.signature = "";
      updateSelectionList();
      render();
      config.setStatus(`paint mode ${state.mirrorMode ? "mirror" : "regular"}`);
      event.preventDefault();
      return true;
    }
    const edge = EDGE_KEYS.indexOf(event.key);
    if (edge < 0) return false;
    const selected = selectedPiece();
    if (!selected) return false;
    const candidate = candidateForEdge(selected, edge);
    if (candidate) placeCandidate(candidate);
    event.preventDefault();
    return true;
  }

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    const screen = canvasPoint(event);
    const point = screenToWorldPoint(screen);
    const piece = pickPiece(point.x, point.y);
    if (piece) {
      if (event.shiftKey) {
        deletePiece(piece);
        return;
      }
      if (cyclePieceVariant(piece)) return;
      state.selectedPieceId = piece.id;
      updateSelectionList();
      render();
      return;
    }

    const candidate = pickCandidate(point.x, point.y);
    if (!candidate) {
      state.pan = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        viewX: state.view.x,
        viewY: state.view.y,
      };
      config.canvas.setPointerCapture(event.pointerId);
      return;
    }
    placeCandidate(candidate);
  }

  function handlePointerMove(event) {
    if (!state.pan || state.pan.id !== event.pointerId) return;
    state.view.x = state.pan.viewX + event.clientX - state.pan.x;
    state.view.y = state.pan.viewY + event.clientY - state.pan.y;
    render();
  }

  function handlePointerUp(event) {
    if (state.pan?.id !== event.pointerId) return;
    state.pan = null;
    try {
      config.canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone after tab switches or canceled drags.
    }
  }

  function handleWheel(event) {
    event.preventDefault();
    const screen = canvasPoint(event);
    const world = screenToWorldPoint(screen);
    const nextScale = clamp(state.view.scale * Math.exp(-event.deltaY * 0.0012), MIN_ZOOM, MAX_ZOOM);
    const rotated = rotatePoint([world.x, world.y], state.view.rotation);
    state.view.scale = nextScale;
    state.view.x = screen.x - rotated[0] * nextScale;
    state.view.y = screen.y - rotated[1] * nextScale;
    updateSelectionList();
    render();
  }

  function placeCandidate(candidate) {
    const existing = findPieceAtCell(candidate.piece);
    if (existing) {
      state.selectedPieceId = existing.id;
      updateSelectionList();
      render();
      config.setStatus(`selected existing ${pieceLabel(existing)}`);
      return;
    }
    const piece = {
      ...candidate.piece,
      id: `p${state.nextId++}`,
    };
    state.pieces.push(piece);
    state.selectedPieceId = piece.id;
    state.candidateCache.signature = "";
    updateSelectionList();
    render();
    config.setStatus(`painted ${pieceLabel(piece)} from edge ${candidate.edge + 1}`);
  }

  function deletePiece(piece) {
    state.pieces = state.pieces.filter((item) => item.id !== piece.id);
    if (state.selectedPieceId === piece.id) state.selectedPieceId = state.pieces[0]?.id ?? null;
    state.candidateCache.signature = "";
    updateSelectionList();
    render();
    config.setStatus(`deleted ${pieceLabel(piece)}`);
  }

  function buildCandidates() {
    const signature = candidateCacheSignature();
    if (state.candidateCache.signature === signature) return state.candidateCache.candidates;
    const candidates = [];
    if (!state.pieces.length) {
      state.candidateCache = { signature, candidates };
      return candidates;
    }
    for (const piece of state.pieces) {
      for (let edge = 0; edge < 3; edge += 1) {
        const candidate = candidateForEdge(piece, edge);
        if (!candidate) continue;
        if (findPieceAtCell(candidate.piece)) continue;
        if (candidates.some((item) => sameCandidate(item.piece, candidate.piece))) continue;
        candidates.push(candidate);
      }
    }
    state.candidateCache = { signature, candidates };
    return candidates;
  }

  function candidateCacheSignature() {
    return [
      state.mirrorMode ? "m" : "r",
      state.depth,
      state.orientation?.lon,
      state.orientation?.lat,
      state.orientation?.roll,
      state.gridSide,
      ...state.pieces.map((piece) => [
        piece.id,
        addressKey(piece.address),
        piece.mirrored ? 1 : 0,
        round(piece.x),
        round(piece.y),
        round(piece.rotation),
      ].join(",")),
    ].join("|");
  }

  function candidateForEdge(basePiece, edge) {
    return candidateOptionsForEdge(basePiece, edge, state.mirrorMode)[0] ?? null;
  }

  function candidateOptionsForEdge(basePiece, edge, mirrorMode = state.mirrorMode, ignoredPieceId = null) {
    if (mirrorMode) {
      const address = cloneAddress(basePiece.address);
      const piece = createPiece(address, !basePiece.mirrored, 0, 0, 0, "candidate", basePiece.variant);
      alignAcrossEdge(piece, edge, transformedEdge(basePiece, edge), transformedTriangle(basePiece)[edge]);
      const candidate = { piece, source: basePiece, edge, alignEdge: edge, mirrorMode, mode: "self-reflection" };
      return isCandidateConsistent(candidate, ignoredPieceId) ? [candidate] : [];
    }

    // Outside mirror mode we consider two adjacency families:
    //   - regular adjacent: the geometric neighbour with matching chirality.
    //   - mirror adjacent: same address as regular but flipped chirality. The
    //     coast seam is continuous iff the candidate's chirality matches the
    //     basePiece's (the two iso projections walk the shared world edge in the
    //     same on-screen direction). We pick the mirror flag that makes this so.
    const baseChir = effectiveChirality(basePiece);
    const probeNeighbor = neighborTriangleAddress(basePiece.address, edge, basePiece.address.depth, state.orientation);
    const variants = probeNeighbor.face === basePiece.address.face ? [basePiece.variant] : [0, 1];
    const candidates = variants.map((variant) => {
      const address = neighborTriangleAddress(basePiece.address, edge, basePiece.address.depth, state.orientation, variant);
      const alignEdge = backEdgeFor(address, basePiece.address);
      const naturalChir = isoChirality(address.face, variant);
      const needsMirror = (naturalChir * (basePiece.mirrored ? -1 : 1)) !== baseChir;
      const mirrored = needsMirror ? !basePiece.mirrored : basePiece.mirrored;
      const piece = createPiece(address, mirrored, 0, 0, 0, "candidate", variant);
      alignAcrossEdge(piece, alignEdge, transformedEdge(basePiece, edge), transformedTriangle(basePiece)[edge]);
      return {
        piece,
        source: basePiece,
        edge,
        alignEdge,
        mirrorMode,
        mode: needsMirror ? "mirror-adjacent" : "regular",
      };
    });
    candidates.sort((a, b) => angleDistance(a.piece.rotation, basePiece.rotation) - angleDistance(b.piece.rotation, basePiece.rotation));
    return candidates.filter((candidate) => isCandidateConsistent(candidate, ignoredPieceId));
  }

  function cyclePieceVariant(piece) {
    const options = placementVariantsForCell(piece);
    if (options.length <= 1) return false;
    const current = pieceVariantSignature(piece);
    const index = options.findIndex((candidate) => pieceVariantSignature(candidate.piece) === current);
    const nextIndex = index < 0 ? 0 : (index + 1) % options.length;
    const next = options[nextIndex].piece;
    piece.address = cloneAddress(next.address);
    piece.variant = next.variant ?? next.address.variant ?? 0;
    piece.mirrored = next.mirrored;
    piece.x = next.x;
    piece.y = next.y;
    piece.rotation = next.rotation;
    state.selectedPieceId = piece.id;
    state.mapCache.clear();
    state.candidateCache.signature = "";
    updateSelectionList();
    render();
    config.setStatus(`cycled ${piece.id} to ${pieceLabel(piece)} (${nextIndex + 1}/${options.length})`);
    return true;
  }

  function placementVariantsForCell(piece) {
    const options = [];
    addPlacementOption(options, { piece: cloneVariantPiece(piece), source: piece, mode: "current" });
    for (const source of state.pieces) {
      if (source.id === piece.id) continue;
      for (let edge = 0; edge < 3; edge += 1) {
        for (const mirrorMode of [false, true]) {
          for (const candidate of candidateOptionsForEdge(source, edge, mirrorMode, piece.id)) {
            if (sameCell(candidate.piece, piece)) addPlacementOption(options, candidate);
          }
        }
      }
    }
    options.sort((a, b) => pieceVariantSignature(a.piece).localeCompare(pieceVariantSignature(b.piece)));
    return options;
  }

  function addPlacementOption(options, candidate) {
    const signature = pieceVariantSignature(candidate.piece);
    if (!options.some((item) => pieceVariantSignature(item.piece) === signature)) options.push(candidate);
  }

  function cloneVariantPiece(piece) {
    return createPiece(piece.address, piece.mirrored, piece.x, piece.y, piece.rotation, "candidate", piece.variant);
  }

  function pieceVariantSignature(piece) {
    return `${addressKey(piece.address)}:${piece.mirrored ? "L" : "R"}`;
  }

  function effectiveChirality(piece) {
    return isoChirality(piece.address.face, piece.variant ?? piece.address.variant ?? 0) * (piece.mirrored ? -1 : 1);
  }

  function isCandidateConsistent(candidate, ignoredPieceId = null) {
    // For each edge of the candidate, if a placed piece is geometrically adjacent on
    // that edge, the relationship between them must be one of the three permitted
    // adjacencies (regular, self-reflection, or mirror-adjacent). Otherwise placing
    // the candidate would produce a seam mismatch with the existing tile.
    const piece = candidate.piece;
    for (let edge = 0; edge < 3; edge += 1) {
      const adjacent = adjacentPlacedEdge(piece, edge, ignoredPieceId);
      if (!adjacent) continue;
      const expected = neighborTriangleAddress(
        piece.address,
        edge,
        piece.address.depth,
        state.orientation,
        adjacent.piece.address.variant ?? adjacent.piece.variant ?? 0,
      );
      const back = neighborTriangleAddress(
        adjacent.piece.address,
        adjacent.edge,
        adjacent.piece.address.depth,
        state.orientation,
        piece.address.variant ?? piece.variant ?? 0,
      );
      const isGeometricNeighbour = addressKey(expected) === addressKey(adjacent.piece.address)
        && addressKey(back) === addressKey(piece.address);
      const isSelfReflection = addressKey(piece.address) === addressKey(adjacent.piece.address)
        && Boolean(piece.mirrored) !== Boolean(adjacent.piece.mirrored);
      // For a regular or mirror-adjacent seam to be continuous, the candidate and
      // its placed neighbour must produce the same effective chirality.
      const chiralitiesMatch = effectiveChirality(piece) === effectiveChirality(adjacent.piece);
      const matchesRegularFamily = isGeometricNeighbour && chiralitiesMatch;
      if (!matchesRegularFamily && !isSelfReflection) return false;
    }
    return true;
  }

  function adjacentPlacedPiece(piece, edge, ignoredPieceId = null) {
    return adjacentPlacedEdge(piece, edge, ignoredPieceId)?.piece ?? null;
  }

  function adjacentPlacedEdge(piece, edge, ignoredPieceId = null) {
    const target = transformedEdge(piece, edge);
    const threshold = edgeMatchTolerance();
    for (const other of state.pieces) {
      if (other.id === ignoredPieceId || other.id === piece.id) continue;
      for (let otherEdge = 0; otherEdge < 3; otherEdge += 1) {
        if (edgesCoincide(target, transformedEdge(other, otherEdge), threshold)) {
          return { piece: other, edge: otherEdge };
        }
      }
    }
    return null;
  }

  function edgeMatchTolerance() {
    return Math.max(0.5, state.gridSide * 0.035);
  }

  function edgesCoincide(a, b, threshold) {
    const direct = Math.hypot(a[0][0] - b[0][0], a[0][1] - b[0][1])
      + Math.hypot(a[1][0] - b[1][0], a[1][1] - b[1][1]);
    const reversed = Math.hypot(a[0][0] - b[1][0], a[0][1] - b[1][1])
      + Math.hypot(a[1][0] - b[0][0], a[1][1] - b[0][1]);
    return Math.min(direct, reversed) <= threshold * 2;
  }

  function alignAcrossEdge(piece, alignEdge, targetEdge, baseOpposite) {
    const local = localEdge(piece, alignEdge);
    applyEdgeAlignment(piece, local[0], local[1], targetEdge[1], targetEdge[0]);
    if (isOppositeSide(baseOpposite, transformedTriangle(piece)[alignEdge], targetEdge)) return;
    applyEdgeAlignment(piece, local[0], local[1], targetEdge[0], targetEdge[1]);
  }

  function exportJson() {
    return JSON.stringify(compactJson(), null, 2);
  }

  function loadJson(payload) {
    const data = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!data || ![2, 3].includes(data.version) || !Array.isArray(data.pieces)) {
      throw new Error("Unsupported tile JSON");
    }
    state.depth = Number(data.depth ?? state.depth);
    state.mirrorMode = !!data.mirrorMode;
    state.pieces = data.pieces.map((item, index) => {
      const v3 = data.version === 3;
      const face = Number(item[0]);
      const variant = v3 ? Number(item[1] ?? 0) : 0;
      const root = Number(v3 ? item[2] : item[1]);
      const pathString = String(v3 ? item[3] ?? "" : item[2] ?? "");
      const path = pathString === "root" ? [] : pathString.split("").filter(Boolean).map(Number);
      const address = addressFromNode(face, variant, root, path, state.orientation);
      return {
        id: `p${index + 1}`,
        address,
        variant,
        mirrored: item[v3 ? 4 : 3] === 1,
        x: Number(item[v3 ? 5 : 4] ?? state.size.width * 0.5),
        y: Number(item[v3 ? 6 : 5] ?? state.size.height * 0.5),
        rotation: Number(item[v3 ? 7 : 6] ?? 0),
      };
    });
    state.nextId = state.pieces.length + 1;
    state.selectedPieceId = state.pieces[0]?.id ?? null;
    state.mapCache.clear();
    state.candidateCache.signature = "";
    updateSelectionList();
    render();
  }

  async function exportTileSet(polygons, options) {
    if (!state.pieces.length) throw new Error("Constructor has no tiles to export");
    const svg = renderConstructedSvg(polygons, options);
    if (options.type === "png") {
      const resolution = Number(options.pngResolution) || 1024;
      return {
        filename: "constructed-tile-set.png",
        blob: new Blob([await svgToPngBytes(svg, resolution, resolution)], { type: "image/png" }),
      };
    }
    return {
      filename: "constructed-tile-set.svg",
      blob: new Blob([svg], { type: "image/svg+xml" }),
    };
  }

  function renderConstructedSvg(polygons, options) {
    const exportRotation = Number(options.viewRotation ?? state.view.rotation ?? 0);
    const baseBounds = boundsForPieces(state.pieces);
    const exportCenter = [
      (baseBounds.minX + baseBounds.maxX) * 0.5,
      (baseBounds.minY + baseBounds.maxY) * 0.5,
    ];
    const rotateForExport = (point) => rotateAround(point, exportCenter, exportRotation);
    const frontBounds = boundsForPoints(state.pieces.flatMap((piece) => transformedTriangle(piece).map(rotateForExport)));
    const frontHeight = Math.max(1, frontBounds.maxY - frontBounds.minY);
    const backsideOffset = options.backside?.enabled ? frontHeight + state.unitScale * 0.42 : 0;
    const bounds = options.backside?.enabled
      ? { ...frontBounds, maxY: frontBounds.maxY + backsideOffset }
      : frontBounds;
    const padding = 8;
    const targetSize = options.type === "png"
      ? Number(options.pngResolution) || 1024
      : Number(options.svgScale) || 1024;
    const sourceWidth = Math.max(1, bounds.maxX - bounds.minX);
    const sourceHeight = Math.max(1, bounds.maxY - bounds.minY);
    const scale = (targetSize - padding * 2) / Math.max(sourceWidth, sourceHeight);
    const offsetX = (targetSize - sourceWidth * scale) * 0.5;
    const offsetY = (targetSize - sourceHeight * scale) * 0.5;
    const projectScreen = (point) => [
      (point[0] - bounds.minX) * scale + offsetX,
      (point[1] - bounds.minY) * scale + offsetY,
    ];
    const projectFrontPoint = (point) => projectScreen(rotateForExport(point));
    const projectBackPoint = (point) => {
      const rotated = rotateForExport(point);
      return projectScreen([rotated[0], rotated[1] + backsideOffset]);
    };
    const parts = state.pieces.map((piece, index) => {
      const geometry = {
        trianglePath: transformedTriangle(piece).map(projectFrontPoint),
        project: (u, v) => projectFrontPoint(screenPointForUV(piece, u, v)),
      };
      const fragment = renderTriangleSvgFragment(piece.address, polygons, {
        ...options,
        orientation: state.orientation,
        mirrored: piece.mirrored,
        eclipse: null,
      }, geometry).replaceAll('id="', `id="piece${index + 1}-`);
      return `<g data-piece="${piece.id}" data-address="${escapeAttr(addressVariantKey(piece.address))}" data-variant="${piece.variant}" data-mirrored="${piece.mirrored ? "1" : "0"}">${fragment}</g>`;
    });
    const eclipses = normalizeEclipseOptions(options);
    const eclipseLayers = eclipses.map((eclipse, eclipseIndex) => {
      const eclipseParts = state.pieces.map((piece, pieceIndex) => {
        const geometry = {
          trianglePath: transformedTriangle(piece).map(projectFrontPoint),
          project: (u, v) => projectFrontPoint(screenPointForUV(piece, u, v)),
        };
        return renderEclipseSvgFragment(piece.address, {
          ...options,
          eclipse,
          orientation: state.orientation,
          mirrored: piece.mirrored,
        }, geometry).replaceAll('id="', `id="eclipse${eclipseIndex + 1}-piece${pieceIndex + 1}-`);
      }).filter(Boolean);
      return `<g id="eclipse-${eclipseIndex + 1}" data-saros="${escapeAttr(eclipse.sarosNumber ?? "")}" data-position="${escapeAttr(eclipse.sarosPosition ?? "")}" data-type="${escapeAttr(eclipse.type ?? "")}">
${eclipseParts.join("\n")}
</g>`;
    });
    if (eclipseLayers.length) {
      parts.push(`<g id="eclipses">
${eclipseLayers.join("\n")}
</g>`);
    }
    if (options.backside?.enabled) {
      parts.push(...state.pieces.map((piece, index) => {
        const geometry = {
          trianglePath: transformedTriangle(piece).map(projectBackPoint),
          project: (u, v) => projectBackPoint(screenPointForUV(piece, u, v)),
        };
        const label = tileBacksideLabel(piece.address, piece.mirrored);
        const fragment = renderBacksideSvgFragment(geometry, label, index + 1, options).replaceAll('id="', `id="piece${index + 1}-`);
        return `<g data-piece="${piece.id}" data-address="${escapeAttr(addressVariantKey(piece.address))}" data-backside="1" data-global-number="${index + 1}">${fragment}</g>`;
      }));
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="${SVG_NS}" width="${round(targetSize)}" height="${round(targetSize)}" viewBox="0 0 ${round(targetSize)} ${round(targetSize)}">
${parts.join("\n")}
</svg>
`;
  }

  function compactJson() {
    return {
      version: 3,
      mode: "grid-painter",
      depth: state.depth,
      anchor: state.orientation?.offsets ?? { lon: 0, lat: 0, roll: 0 },
      mirrorMode: state.mirrorMode,
      seedKey: state.seedKey,
      pieces: state.pieces.map((piece) => [
        piece.address.face,
        piece.variant,
        piece.address.root,
        piece.address.path.join(""),
        piece.mirrored ? 1 : 0,
        round(piece.x),
        round(piece.y),
        round(piece.rotation),
      ]),
    };
  }

  function updateSelectionList() {
    const rows = [
      ["seed", state.seedKey || "none"],
      ["mode", state.mirrorMode ? "mirror" : "regular"],
      ["zoom", `${Math.round(state.view.scale * 100)}%`],
      ["depth", String(state.depth)],
      ["eclipses", state.eclipses.length ? String(state.eclipses.length) : "none"],
      ["tiles", String(state.pieces.length)],
    ];
    const piece = selectedPiece();
    if (piece) {
      rows.splice(5, 0, ["piece", piece.id], ["tile", pieceLabel(piece)], ["mirror", piece.mirrored ? "yes" : "no"]);
    } else {
      rows.splice(5, 0, ["piece", "none"]);
    }
    config.renderDefinitionList(config.selectionList, rows);
    config.modeValue.textContent = state.mirrorMode ? "mirror" : "regular";
  }

  function drawPiece(ctx, piece) {
    const vertices = transformedTriangle(piece);
    if (state.polygons?.length || state.eclipses.length) {
      drawCachedPieceMap(ctx, piece);
    } else {
      ctx.save();
      pathPolygon(ctx, vertices);
      ctx.fillStyle = state.style?.ocean ?? "#102725";
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    pathPolygon(ctx, vertices);
    ctx.strokeStyle = piece.id === state.selectedPieceId ? "#f0b35a" : "rgba(243,239,230,0.42)";
    ctx.lineWidth = worldLineWidth(piece.id === state.selectedPieceId ? 1.8 : 1);
    ctx.stroke();
    const center = centroid(vertices);
    ctx.fillStyle = piece.mirrored ? "#e86f75" : "#37c8b1";
    ctx.font = `700 ${worldFontSize(11)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${piece.address.face}.${piece.variant}:${piece.address.path.join("") || "r"}`, center[0], center[1]);
    ctx.restore();
  }

  function drawCachedPieceMap(ctx, piece) {
    const rasterScale = pieceRasterScale();
    const cacheKey = [
      addressKey(piece.address),
      piece.variant,
      piece.mirrored ? "m" : "o",
      round(piece.rotation),
      rasterScale,
      state.cacheSignature,
    ].join(":");
    let cached = state.mapCache.get(cacheKey);
    if (!cached) {
      cached = renderPieceMap(piece, rasterScale);
      state.mapCache.set(cacheKey, cached);
      trimMapCache();
    }
    ctx.drawImage(
      cached.canvas,
      piece.x + cached.bounds.minX,
      piece.y + cached.bounds.minY,
      cached.width,
      cached.height,
    );
  }

  function pieceRasterScale() {
    const target = (state.size.ratio || 1) * state.view.scale * 1.35;
    if (target <= 1.25) return 1;
    if (target <= 1.75) return 1.5;
    if (target <= 2.5) return 2;
    if (target <= 3.5) return 3;
    return 4;
  }

  function trimMapCache() {
    while (state.mapCache.size > MAX_MAP_CACHE_ITEMS) {
      const oldest = state.mapCache.keys().next().value;
      state.mapCache.delete(oldest);
    }
  }

  function renderPieceMap(piece, rasterScale = 1) {
    const angle = piece.rotation;
    const rotatedVertices = localTriangle(piece).map((point) => rotatePoint(point, angle));
    const bounds = boundsForPoints(rotatedVertices);
    const padding = Math.max(3, state.style.coastWidth + 2);
    const widthWorld = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
    const heightWorld = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
    const width = Math.max(1, Math.ceil(widthWorld * rasterScale));
    const height = Math.max(1, Math.ceil(heightWorld * rasterScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const localCtx = canvas.getContext("2d");
    const toCachePoint = (point) => [
      (point[0] - bounds.minX + padding) * rasterScale,
      (point[1] - bounds.minY + padding) * rasterScale,
    ];
    const trianglePath = rotatedVertices.map(toCachePoint);
    pathPolygon(localCtx, trianglePath);
    localCtx.fillStyle = state.style.ocean;
    localCtx.fill();
    const scaledStyle = {
      ...state.style,
      coastWidth: state.style.coastWidth * rasterScale,
    };
    drawLandOnTriangle(
      localCtx,
      piece.address,
      trianglePath,
      (u, v) => toCachePoint(rotatePoint(localPointForUV(piece, u, v), angle)),
      state.polygons,
      scaledStyle,
      state.orientation,
      true,
    );
    for (const eclipse of state.eclipses) {
      drawEclipseOnTriangle(
        localCtx,
        piece.address,
        trianglePath,
        (u, v) => toCachePoint(rotatePoint(localPointForUV(piece, u, v), angle)),
        eclipse,
        {
          fill: eclipse.fill ?? state.eclipseStyle?.fill ?? "#ffd16c",
          fillOpacity: eclipse.fillOpacity ?? state.eclipseStyle?.fillOpacity ?? 0.28,
          stroke: eclipse.stroke ?? state.eclipseStyle?.stroke ?? "#ffd16c",
          width: Math.max(1.2, (eclipse.width ?? state.eclipseStyle?.width ?? 4) * rasterScale),
        },
        state.orientation,
      );
    }
    return {
      canvas,
      bounds: {
        minX: bounds.minX - padding,
        minY: bounds.minY - padding,
      },
      width: widthWorld,
      height: heightWorld,
    };
  }

  function drawCandidate(ctx, candidate) {
    const vertices = transformedTriangle(candidate.piece);
    ctx.save();
    pathPolygon(ctx, vertices);
    ctx.fillStyle = candidate.mirrorMode ? "rgba(232,111,117,0.12)" : "rgba(55,200,177,0.1)";
    ctx.strokeStyle = candidate.mirrorMode ? "rgba(232,111,117,0.56)" : "rgba(55,200,177,0.5)";
    ctx.lineWidth = worldLineWidth(1);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawEdgeLabels(ctx, piece) {
    ctx.save();
    ctx.font = `700 ${worldFontSize(12)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let edge = 0; edge < 3; edge += 1) {
      const points = transformedEdge(piece, edge);
      const mid = midpoint(points[0], points[1]);
      ctx.fillStyle = state.mirrorMode ? "#e86f75" : "#f0b35a";
      ctx.fillText(EDGE_KEYS[edge], mid[0], mid[1]);
    }
    ctx.restore();
  }

  function drawBackground(ctx, width, height) {
    ctx.fillStyle = "#0c0c0b";
    ctx.fillRect(0, 0, width, height);
  }

  function drawTriangularGrid(ctx, bounds) {
    const spacing = state.gridSide * Math.sqrt(3) * 0.5;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    const length = Math.hypot(width, height) * 1.4;
    const center = [(bounds.minX + bounds.maxX) * 0.5, (bounds.minY + bounds.maxY) * 0.5];
    ctx.save();
    ctx.strokeStyle = "rgba(243,239,230,0.055)";
    ctx.lineWidth = worldLineWidth(1);
    for (const direction of [[0, 1], [Math.sqrt(3) * 0.5, 0.5], [-Math.sqrt(3) * 0.5, 0.5]]) {
      const normal = [-direction[1], direction[0]];
      for (let offset = -length; offset <= length; offset += spacing) {
        const cx = center[0] + normal[0] * offset;
        const cy = center[1] + normal[1] * offset;
        ctx.beginPath();
        ctx.moveTo(cx - direction[0] * length, cy - direction[1] * length);
        ctx.lineTo(cx + direction[0] * length, cy + direction[1] * length);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawEmptyState(ctx, width, height) {
    ctx.save();
    ctx.fillStyle = "rgba(243,239,230,0.42)";
    ctx.font = "600 13px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Place the seed tile, then paint legal neighboring cells.", width * 0.5, height * 0.5);
    ctx.restore();
  }

  function selectedPiece() {
    return state.pieces.find((piece) => piece.id === state.selectedPieceId) ?? null;
  }

  function findPieceAtCell(target) {
    return state.pieces.find((piece) => sameCell(piece, target)) ?? null;
  }

  function pickPiece(x, y) {
    for (let index = state.pieces.length - 1; index >= 0; index -= 1) {
      const piece = state.pieces[index];
      if (pointInPolygon([x, y], transformedTriangle(piece))) return piece;
    }
    return null;
  }

  function pickCandidate(x, y) {
    return buildCandidates().find((candidate) => pointInPolygon([x, y], transformedTriangle(candidate.piece))) ?? null;
  }

  function parseSeedKey(value) {
    const [faceToken, rootRaw, pathRaw = ""] = value.split(":");
    const [faceRaw, variantRaw = "0"] = faceToken.split(".");
    const face = Number(faceRaw);
    const variant = Number(variantRaw);
    const root = Number(rootRaw);
    const path = pathRaw === "root" ? [] : pathRaw.split("").filter(Boolean).map(Number);
    if (!Number.isInteger(face) || face < 0 || face > 5) throw new Error("Seed face must be 0..5");
    if (!Number.isInteger(variant) || variant < 0 || variant > 1) throw new Error("Seed variant must be 0..1");
    if (!Number.isInteger(root) || root < 0 || root > 1) throw new Error("Seed root must be 0..1");
    if (path.some((child) => !Number.isInteger(child) || child < 0 || child > 3)) throw new Error("Seed path must contain only 0..3");
    if (path.length !== state.depth) throw new Error(`Seed path depth must be ${state.depth}`);
    return addressFromNode(face, variant, root, path, state.orientation);
  }

  function createPiece(address, mirrored, x, y, rotation, id = `p${state.nextId++}`, variant = address.variant ?? 0) {
    const pieceAddress = cloneAddress({ ...address, variant });
    return {
      id,
      address: pieceAddress,
      variant,
      mirrored,
      x,
      y,
      rotation,
    };
  }

  function centerPiece(piece, x, y) {
    const current = centroid(transformedTriangle(piece));
    piece.x += x - current[0];
    piece.y += y - current[1];
  }

  function addressFromNode(face, variant, root, path, orientation) {
    const vertices = path.reduce(
      (current, child) => childTriangleVertices(current, child),
      rootTriangleVertices(face, root, orientation, variant),
    );
    const uv = centroid(vertices);
    return {
      ...uvToTriAddress(face, uv[0], uv[1], path.length, orientation, variant),
      root,
      rootName: rootTriangleName(face, root, orientation, variant),
      path: path.slice(),
      depth: path.length,
      pathBits: packPath(path).toString(),
      barycentric: [1 / 3, 1 / 3, 1 / 3],
      uv,
      variant,
      orientation,
    };
  }

  function pieceLabel(piece) {
    return `F${piece.address.face}.${piece.variant}/r${piece.address.root}/${piece.address.path.join("") || "root"}`;
  }

  function cloneAddress(address) {
    return {
      ...address,
      path: [...(address.path ?? [])],
      uv: [...(address.uv ?? [])],
      barycentric: [...(address.barycentric ?? [])],
      variant: address.variant ?? 0,
      orientation: state.orientation,
    };
  }

  function sameCandidate(a, b) {
    return sameCell(a, b);
  }

  function localTriangle(piece) {
    return triangleVerticesFromAddress(piece.address, state.orientation).map(([u, v]) => localPointForUV(piece, u, v));
  }

  function transformedTriangle(piece) {
    return localTriangle(piece).map((point) => transformLocal(piece, point));
  }

  function localPointForUV(piece, u, v) {
    const variant = piece.variant ?? piece.address.variant ?? 0;
    const center = isoProjectFaceUV(piece.address.face, 0.5, 0.5, variant);
    const edgeA = isoProjectFaceUV(piece.address.face, 0, 0, variant);
    const edgeB = isoProjectFaceUV(piece.address.face, 1, 0, variant);
    const side = Math.hypot(edgeB[0] - edgeA[0], edgeB[1] - edgeA[1]) || 1;
    const scale = state.unitScale / side;
    const projected = isoProjectFaceUV(piece.address.face, u, v, variant);
    const point = [
      (projected[0] - center[0]) * scale,
      (projected[1] - center[1]) * scale,
    ];
    return piece.mirrored ? [-point[0], point[1]] : point;
  }

  function screenPointForUV(piece, u, v) {
    return transformLocal(piece, localPointForUV(piece, u, v));
  }

  function localEdge(piece, edge) {
    const vertices = localTriangle(piece);
    return [vertices[(edge + 1) % 3], vertices[(edge + 2) % 3]];
  }

  function transformedEdge(piece, edge) {
    const vertices = transformedTriangle(piece);
    return [vertices[(edge + 1) % 3], vertices[(edge + 2) % 3]];
  }

  function transformLocal(piece, point) {
    const angle = piece.rotation * Math.PI / 180;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [
      point[0] * c - point[1] * s + piece.x,
      point[0] * s + point[1] * c + piece.y,
    ];
  }

  function applyEdgeAlignment(piece, localA, localB, targetA, targetB) {
    const localAngle = Math.atan2(localB[1] - localA[1], localB[0] - localA[0]);
    const targetAngle = Math.atan2(targetB[1] - targetA[1], targetB[0] - targetA[0]);
    piece.rotation = (targetAngle - localAngle) * 180 / Math.PI;
    const rotatedA = rotatePoint(localA, piece.rotation);
    piece.x = targetA[0] - rotatedA[0];
    piece.y = targetA[1] - rotatedA[1];
  }

  function backEdgeFor(address, targetAddress) {
    for (let edge = 0; edge < 3; edge += 1) {
      const neighbor = neighborTriangleAddress(address, edge, address.depth, state.orientation, targetAddress.variant ?? 0);
      if (addressKey(neighbor) === addressKey(targetAddress)) return edge;
    }
    return 0;
  }

  function screenToWorldPoint(point) {
    const scaled = {
      x: (point.x - state.view.x) / state.view.scale,
      y: (point.y - state.view.y) / state.view.scale,
    };
    const rotated = rotatePoint([scaled.x, scaled.y], -state.view.rotation);
    return { x: rotated[0], y: rotated[1] };
  }

  function visibleWorldBounds() {
    const corners = [
      screenToWorldPoint({ x: 0, y: 0 }),
      screenToWorldPoint({ x: state.size.width, y: 0 }),
      screenToWorldPoint({ x: state.size.width, y: state.size.height }),
      screenToWorldPoint({ x: 0, y: state.size.height }),
    ];
    return corners.reduce((bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }

  function worldLineWidth(px) {
    return px / state.view.scale;
  }

  function worldFontSize(px) {
    return px / state.view.scale;
  }

  function sameCell(a, b) {
    const ca = pieceCenter(a);
    const cb = pieceCenter(b);
    return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) < Math.max(1, state.gridSide * 0.2);
  }

  function isPieceVisible(piece) {
    const bounds = boundsForPoints(transformedTriangle(piece));
    const margin = state.unitScale * 0.15;
    return bounds.maxX >= state.visibleBounds.minX - margin
      && bounds.minX <= state.visibleBounds.maxX + margin
      && bounds.maxY >= state.visibleBounds.minY - margin
      && bounds.minY <= state.visibleBounds.maxY + margin;
  }

  function pieceCenter(piece) {
    return centroid(transformedTriangle(piece));
  }

  function boundsForPieces(pieces) {
    const all = pieces.flatMap((piece) => transformedTriangle(piece));
    return all.reduce((bounds, point) => ({
      minX: Math.min(bounds.minX, point[0]),
      minY: Math.min(bounds.minY, point[1]),
      maxX: Math.max(bounds.maxX, point[0]),
      maxY: Math.max(bounds.maxY, point[1]),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }
}

function gridSideForDepth(depth) {
  return Math.max(24, Math.min(108, 320 / (2 ** depth)));
}

function normalizeEclipses(next) {
  if (Array.isArray(next.eclipses) && next.eclipses.length) return next.eclipses;
  return next.eclipse ? [next.eclipse] : [];
}

function normalizeEclipseOptions(options) {
  if (Array.isArray(options.eclipses) && options.eclipses.length) return options.eclipses;
  return options.eclipse ? [options.eclipse] : [];
}

function addressVariantKey(address) {
  return `${address.face}.${address.variant ?? 0}:${address.root}:${(address.path ?? []).join("") || "root"}`;
}

function canvasPoint(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function centroid(points) {
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function midpoint(a, b) {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
}

function boundsForPoints(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point[0]),
    minY: Math.min(bounds.minY, point[1]),
    maxX: Math.max(bounds.maxX, point[0]),
    maxY: Math.max(bounds.maxY, point[1]),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function rotatePoint(point, deg) {
  const angle = deg * Math.PI / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    point[0] * c - point[1] * s,
    point[0] * s + point[1] * c,
  ];
}

function rotateAround(point, center, deg) {
  const rotated = rotatePoint([point[0] - center[0], point[1] - center[1]], deg);
  return [rotated[0] + center[0], rotated[1] + center[1]];
}

function isOppositeSide(a, b, edge) {
  const edgeVector = [edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]];
  const ca = cross2(edgeVector, [a[0] - edge[0][0], a[1] - edge[0][1]]);
  const cb = cross2(edgeVector, [b[0] - edge[0][0], b[1] - edge[0][1]]);
  return ca * cb < 0;
}

function cross2(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

function angleDistance(a, b) {
  const delta = ((((a - b + 180) % 360) + 360) % 360) - 180;
  return Math.abs(delta);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = ((a[1] > point[1]) !== (b[1] > point[1]))
      && (point[0] < (b[0] - a[0]) * (point[1] - a[1]) / ((b[1] - a[1]) || 1e-9) + a[0]);
    if (crosses) inside = !inside;
  }
  return inside;
}

function pathPolygon(ctx, points) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point[0], point[1]);
    else ctx.lineTo(point[0], point[1]);
  });
  ctx.closePath();
}

function svgToPngBytes(svg, width, height) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(async (pngBlob) => {
        if (!pngBlob) {
          reject(new Error("PNG encode failed"));
          return;
        }
        resolve(new Uint8Array(await pngBlob.arrayBuffer()));
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG rasterization failed"));
    };
    img.src = url;
  });
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function round(value) {
  return Number(value).toFixed(3).replace(/\.?0+$/, "");
}
