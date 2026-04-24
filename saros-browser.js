// Browser port of saros/saros.js solar lookup. Backed by the same three binary
// DB files (eclipse_times.db, eclipse_info.db, saros.db) fetched at startup.
// Only solar eclipses are exposed here; add lunar if/when needed.

const TIMES_SIZE = 8;
const INFO_SIZE  = 10;
const SAROS_SIZE = 194;
const NA_DURATION = 65535;

export const SOLAR_TYPE_NAMES = [
  'A', 'A+', 'A-', 'Am', 'An', 'As',
  'H', 'H2', 'H3', 'Hm',
  'P', 'Pb', 'Pe',
  'T', 'T+', 'T-', 'Tm', 'Tn', 'Ts',
];

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

export class SolarEclipseDB {
  static async load(dataDir = './saros/data/solar') {
    const [times, info, saros] = await Promise.all([
      fetchBytes(`${dataDir}/eclipse_times.db`),
      fetchBytes(`${dataDir}/eclipse_info.db`),
      fetchBytes(`${dataDir}/saros.db`),
    ]);
    return new SolarEclipseDB(times, info, saros);
  }

  constructor(times, info, saros) {
    this.times = times;
    this.info  = info;
    this.saros = saros;
    this.count = times.length / TIMES_SIZE;
    this.timesView = new DataView(times.buffer, times.byteOffset, times.byteLength);
    this.infoView  = new DataView(info.buffer,  info.byteOffset,  info.byteLength);
    this.sarosView = new DataView(saros.buffer, saros.byteOffset, saros.byteLength);
  }

  readTime(idx) {
    const o = idx * TIMES_SIZE;
    const lo = this.timesView.getUint32(o, true);
    const hi = this.timesView.getInt32(o + 4, true);
    return hi * 4294967296 + lo;
  }

  makeEntry(idx) {
    const o = idx * INFO_SIZE;
    const dur = this.infoView.getUint16(o + 4, true);
    const eclType = this.info[o + 8];
    return {
      unixTime: this.readTime(idx),
      globalIndex: idx,
      sarosNumber: this.info[o + 6],
      sarosPos: this.info[o + 7],
      type: eclType,
      typeName: SOLAR_TYPE_NAMES[eclType] ?? String(eclType),
      latitude: this.infoView.getInt16(o, true) / 10,
      longitude: this.infoView.getInt16(o + 2, true) / 10,
      centralDuration: dur === NA_DURATION ? null : dur,
      sunAltitude: this.info[o + 9],
    };
  }

  lowerBound(key) {
    let lo = 0, hi = this.count;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (this.readTime(m) < key) lo = m + 1; else hi = m; }
    return lo;
  }

  upperBound(key) {
    let lo = 0, hi = this.count;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (this.readTime(m) <= key) lo = m + 1; else hi = m; }
    return lo;
  }

  findNext(ts) {
    const idx = this.lowerBound(ts);
    return idx < this.count ? this.makeEntry(idx) : null;
  }

  findPast(ts) {
    const idx = this.upperBound(ts);
    return idx > 0 ? this.makeEntry(idx - 1) : null;
  }

  findClosest(ts) {
    const n = this.findNext(ts), p = this.findPast(ts);
    if (!n) return p;
    if (!p) return n;
    return (ts - p.unixTime) < (n.unixTime - ts) ? p : n;
  }

  loadSarosSeries(sarosNumber) {
    if (sarosNumber < 1 || sarosNumber > 180) return { count: 0, indices: [] };
    const off = (sarosNumber - 1) * SAROS_SIZE;
    const count = this.saros[off];
    const indices = [];
    for (let i = 0; i < count; i++) {
      indices.push(this.sarosView.getUint16(off + 2 + i * 2, true));
    }
    return { count, indices };
  }

  // List entries in a saros series ordered by sarosPos.
  seriesEntries(sarosNumber) {
    const { indices } = this.loadSarosSeries(sarosNumber);
    return indices.map(i => this.makeEntry(i));
  }
}
