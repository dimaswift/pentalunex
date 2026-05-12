import { generateSVG, parseOctal, toOctalString } from './octal-glyph.js';

const $ = (id) => document.getElementById(id);

const els = {
  octal: $('octal'),
  decimal: $('decimal'),
  size: $('size'),
  sizeOut: $('sizeOut'),
  thickness: $('thickness'),
  thicknessOut: $('thicknessOut'),
  angle: $('angle'),
  angleOut: $('angleOut'),
  padding: $('padding'),
  paddingOut: $('paddingOut'),
  color: $('color'),
  background: $('background'),
  bgEnabled: $('bgEnabled'),
  merge: $('merge'),
  limit: $('limit'),
  rhombic: $('rhombic'),
  ratio: $('ratio'),
  ratioOut: $('ratioOut'),
  ratioField: $('ratioField'),
  miter: $('miter'),
  miterOut: $('miterOut'),
  download: $('download'),
  copy: $('copy'),
  source: $('source'),
  stage: $('stage'),
};

let currentSVG = '';
let currentOctal = '';

function readOptions() {
  return {
    size: Number(els.size.value),
    thickness: Number(els.thickness.value),
    angle: Number(els.angle.value),
    padding: Number(els.padding.value),
    color: els.color.value,
    background: els.bgEnabled.checked ? els.background.value : null,
    merge: els.merge.checked,
    symbolLimit: Math.max(1, Number(els.limit.value) || 1),
    rhombic: els.rhombic.checked,
    rhombicRatio: Number(els.ratio.value),
    miterLimit: Number(els.miter.value),
  };
}

function render() {
  els.sizeOut.textContent = els.size.value;
  els.thicknessOut.textContent = els.thickness.value;
  els.angleOut.textContent = `${els.angle.value}°`;
  els.paddingOut.textContent = els.padding.value;
  els.ratioOut.textContent = Number(els.ratio.value).toFixed(2);
  els.ratioField.style.opacity = els.rhombic.checked ? '1' : '0.4';
  els.ratio.disabled = !els.rhombic.checked;
  els.miterOut.textContent = els.miter.value;

  const raw = els.octal.value.trim();
  els.decimal.classList.remove('error');

  let value;
  try {
    value = raw === '' ? 0n : parseOctal(raw);
  } catch (err) {
    els.decimal.textContent = err.message;
    els.decimal.classList.add('error');
    els.stage.classList.add('empty');
    els.stage.textContent = 'Enter a valid octal number.';
    currentSVG = '';
    els.source.value = '';
    return;
  }

  currentOctal = toOctalString(value);
  els.decimal.textContent = `decimal: ${value.toString()}  •  octal: ${currentOctal}  •  ${currentOctal.length} digits`;

  const svg = generateSVG(value, readOptions());
  currentSVG = svg;
  els.stage.classList.remove('empty');
  els.stage.innerHTML = svg;
  els.source.value = svg;
}

function downloadSVG() {
  if (!currentSVG) return;
  const blob = new Blob([currentSVG], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `octal-glyph-${currentOctal || '0'}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copySVG() {
  if (!currentSVG) return;
  try {
    await navigator.clipboard.writeText(currentSVG);
    const original = els.copy.textContent;
    els.copy.textContent = 'Copied!';
    setTimeout(() => { els.copy.textContent = original; }, 1200);
  } catch {
    els.source.select();
    document.execCommand('copy');
  }
}

const liveInputs = [
  els.octal, els.size, els.thickness, els.angle, els.padding,
  els.color, els.background, els.bgEnabled, els.merge, els.limit,
  els.rhombic, els.ratio, els.miter,
];
for (const el of liveInputs) {
  el.addEventListener('input', render);
  el.addEventListener('change', render);
}
els.download.addEventListener('click', downloadSVG);
els.copy.addEventListener('click', copySVG);

render();
