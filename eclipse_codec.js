// Binary codec for compressed eclipse records. See eclipse_binary.py for the
// full format specification. This module works in both Node and the browser.

export const MAGIC = new Uint8Array([0x45, 0x43, 0x4c, 0x50]); // "ECLP"
export const VERSION = 1;

export const TYPE_NAMES = Object.freeze([
  'A', 'Am', 'Aminus', 'An', 'Aplus', 'As',
  'H', 'H2', 'H3', 'Hm',
  'P', 'Pb', 'Pe',
  'T', 'Tm', 'Tminus', 'Tplus', 'Ts',
]);
const TYPE_INDEX = Object.fromEntries(TYPE_NAMES.map((t, i) => [t, i]));

export const BITS = Object.freeze({
  TYPE: 5,
  UNIX: 35,
  LAT: 29,
  LON: 29,
  SUN: 7,
  HAS_DUR: 1,
  DUR: 10,
  NPOLY: 5,
  NPTS: 13,
});
const COORD_SCALE = 1_000_000;
const COORD_MAG_MAX = 1 << 28;

// ---------------------------------------------------------------------------
// Bit-level I/O. All values are written MSB-first within each byte. ``bits``
// is capped at 53 (Number.MAX_SAFE_INTEGER has 53-bit mantissa); 35-bit
// signed timestamps fit comfortably.

export class BitWriter {
  constructor() {
    this.chunks = [];    // Uint8Array chunks, appended lazily
    this.buf = new Uint8Array(256);
    this.len = 0;        // bytes currently valid in ``buf``
    this.bitPos = 0;     // absolute bit position (across already-flushed chunks)
  }

  _ensure(extraBytes) {
    if (this.len + extraBytes <= this.buf.length) return;
    // Preserve current bytes, grow geometrically.
    let cap = Math.max(this.buf.length * 2, this.len + extraBytes);
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }

  writeUint(value, bits) {
    if (bits === 0) return;
    if (bits > 53) throw new Error(`writeUint: bits=${bits} > 53`);
    if (value < 0) throw new Error(`writeUint: negative value`);
    const max = Math.pow(2, bits) - 1;
    if (value > max) throw new Error(`value ${value} does not fit in ${bits} bits`);
    let v = value;
    let remaining = bits;
    while (remaining > 0) {
      const byteIdx = this.bitPos >> 3;
      this._ensure(byteIdx + 1 - this.len);
      if (byteIdx >= this.len) this.len = byteIdx + 1;
      const bitInByte = this.bitPos & 7;
      const can = 8 - bitInByte;
      if (remaining <= can) {
        const shift = can - remaining;
        // Use Math-based shift for values that might exceed 32 bits.
        const chunk = (v * (1 << shift)) & 0xFF;
        this.buf[byteIdx] |= chunk;
        this.bitPos += remaining;
        return;
      }
      const topBits = remaining - can;
      // top = v >>> topBits, but Number-safe for topBits up to 52.
      const top = Math.floor(v / Math.pow(2, topBits)) & 0xFF;
      this.buf[byteIdx] |= top;
      this.bitPos += can;
      remaining = topBits;
      v = v % Math.pow(2, topBits);
    }
  }

  writeInt(value, bits) {
    let v = value;
    if (v < 0) v = Math.pow(2, bits) + v;
    this.writeUint(v, bits);
  }

  padToByte() {
    while (this.bitPos & 7) this.writeUint(0, 1);
  }

  tell() { return this.bitPos; }

  toBytes() {
    return this.buf.slice(0, this.len);
  }
}

export class BitReader {
  constructor(buf, bitOffset = 0) {
    if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
    this.buf = buf;
    this.bitPos = bitOffset;
  }

  readUint(bits) {
    if (bits === 0) return 0;
    if (bits > 53) throw new Error(`readUint: bits=${bits} > 53`);
    let value = 0;
    let remaining = bits;
    while (remaining > 0) {
      const byteIdx = this.bitPos >> 3;
      if (byteIdx >= this.buf.length) throw new Error('read past end');
      const bitInByte = this.bitPos & 7;
      const can = 8 - bitInByte;
      const take = Math.min(can, remaining);
      const shift = can - take;
      const chunk = (this.buf[byteIdx] >> shift) & ((1 << take) - 1);
      value = value * Math.pow(2, take) + chunk;
      this.bitPos += take;
      remaining -= take;
    }
    return value;
  }

  readInt(bits) {
    const v = this.readUint(bits);
    const top = Math.pow(2, bits - 1);
    return v >= top ? v - Math.pow(2, bits) : v;
  }

  tell() { return this.bitPos; }
}

// ---------------------------------------------------------------------------
// Coordinates & timestamps.

export function encodeCoord(bw, value) {
  const scaled = Math.round(value * COORD_SCALE);
  const sign = scaled < 0 ? 1 : 0;
  const mag = Math.abs(scaled);
  if (mag >= COORD_MAG_MAX) throw new Error(`coord out of range: ${value}`);
  bw.writeUint(sign, 1);
  bw.writeUint(mag, 28);
}

export function decodeCoord(br) {
  const sign = br.readUint(1);
  const mag = br.readUint(28);
  const v = mag / COORD_SCALE;
  return sign ? -v : v;
}

export function roundCoord(value) {
  return Math.round(value * COORD_SCALE) / COORD_SCALE;
}

// Format a unix timestamp (seconds since 1970-01-01 UTC) as
// ``YYYY-MM-DD HH:MM:SS``. Supports negative values (dates before the epoch).
export function datetimeFromUnix(unixTime) {
  // Use JavaScript Date for dates within its safe range (~±8.64e15 ms from
  // epoch). 35-bit seconds fits comfortably in that window.
  const d = new Date(unixTime * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const year = d.getUTCFullYear();
  const yearStr = year >= 0 && year < 10000 ? pad(year, 4) : String(year);
  return `${yearStr}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function unixFromDatetime(s) {
  // Strict parse: ``YYYY-MM-DD HH:MM:SS``.
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`bad datetime: ${s}`);
  const [, Y, M, D, h, mm, ss] = m.map((v, i) => i === 0 ? v : Number(v));
  return Math.floor(Date.UTC(Y, M - 1, D, h, mm, ss) / 1000);
}

// ---------------------------------------------------------------------------
// Record-level encode/decode.

export function encodeEclipse(bw, record, unixTime) {
  const typeIdx = TYPE_INDEX[record.type];
  if (typeIdx === undefined) throw new Error(`unknown type ${record.type}`);
  bw.writeUint(typeIdx, BITS.TYPE);
  bw.writeInt(unixTime, BITS.UNIX);
  encodeCoord(bw, record.latitude);
  encodeCoord(bw, record.longitude);
  bw.writeUint(record.sun_altitude | 0, BITS.SUN);
  const hasDur = record.central_duration != null;
  bw.writeUint(hasDur ? 1 : 0, BITS.HAS_DUR);
  if (hasDur) bw.writeUint(record.central_duration | 0, BITS.DUR);
  const polys = record.geometry.coordinates;
  bw.writeUint(polys.length, BITS.NPOLY);
  for (const poly of polys) {
    if (poly.length !== 1) throw new Error('expected exactly one ring per polygon');
    const ring = poly[0];
    bw.writeUint(ring.length, BITS.NPTS);
    for (const [lon, lat] of ring) {
      encodeCoord(bw, lon);
      encodeCoord(bw, lat);
    }
  }
}

export function decodeEclipse(br) {
  const typeIdx = br.readUint(BITS.TYPE);
  const unixTime = br.readInt(BITS.UNIX);
  const latitude = decodeCoord(br);
  const longitude = decodeCoord(br);
  const sun_altitude = br.readUint(BITS.SUN);
  const hasDur = br.readUint(BITS.HAS_DUR);
  const record = {
    type: TYPE_NAMES[typeIdx],
    latitude,
    longitude,
  };
  if (hasDur) record.central_duration = br.readUint(BITS.DUR);
  record.sun_altitude = sun_altitude;
  record.datetime_utc = datetimeFromUnix(unixTime);
  const nPolys = br.readUint(BITS.NPOLY);
  const polys = [];
  for (let i = 0; i < nPolys; i++) {
    const nPts = br.readUint(BITS.NPTS);
    const ring = [];
    for (let j = 0; j < nPts; j++) {
      const lon = decodeCoord(br);
      const lat = decodeCoord(br);
      ring.push([lon, lat]);
    }
    polys.push([ring]);
  }
  record.geometry = { type: 'MultiPolygon', coordinates: polys };
  return record;
}

// ---------------------------------------------------------------------------
// Container-level encode/decode.

function writeUint32LE(arr, offset, value) {
  arr[offset + 0] = value & 0xFF;
  arr[offset + 1] = (value >>> 8) & 0xFF;
  arr[offset + 2] = (value >>> 16) & 0xFF;
  arr[offset + 3] = (value >>> 24) & 0xFF;
}

function readUint32LE(arr, offset) {
  return arr[offset] | (arr[offset + 1] << 8) | (arr[offset + 2] << 16) | (arr[offset + 3] * 0x1000000);
}

function writeUint16LE(arr, offset, value) {
  arr[offset + 0] = value & 0xFF;
  arr[offset + 1] = (value >>> 8) & 0xFF;
}

function readUint16LE(arr, offset) {
  return arr[offset] | (arr[offset + 1] << 8);
}

// ``entries``: Array of [unixTime, record].
export function encodeSeries(entries) {
  const payload = new BitWriter();
  const offsets = [0];
  for (const [ut, rec] of entries) {
    encodeEclipse(payload, rec, ut);
    offsets.push(payload.tell());
  }
  payload.padToByte();
  const data = payload.toBytes();

  const N = entries.length;
  if (N > 255) throw new Error('too many eclipses in series');
  const headerSize = 4 + 4 * (N + 1);
  const out = new Uint8Array(headerSize + data.length);
  out[0] = N;
  for (let i = 0; i <= N; i++) writeUint32LE(out, 4 + 4 * i, offsets[i]);
  out.set(data, headerSize);
  return out;
}

export function decodeSeries(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const N = bytes[0];
  const headerSize = 4 + 4 * (N + 1);
  const offsets = [];
  for (let i = 0; i <= N; i++) offsets.push(readUint32LE(bytes, 4 + 4 * i));
  const data = bytes.subarray(headerSize);
  const out = [];
  for (let i = 0; i < N; i++) {
    out.push(decodeEclipse(new BitReader(data, offsets[i])));
  }
  return out;
}

// ``seriesMap``: Object mapping saros number (string or int) to array of
// [unixTime, record] tuples.
export function encodeSingle(seriesMap) {
  const sarosKeys = Object.keys(seriesMap).map(Number).sort((a, b) => a - b);
  const K = sarosKeys.length;
  if (K > 0xFFFF) throw new Error('too many saros series');

  const sections = [];
  for (const saros of sarosKeys) {
    const entries = seriesMap[saros] ?? seriesMap[String(saros)];
    const payload = new BitWriter();
    const offsets = [0];
    for (const [ut, rec] of entries) {
      encodeEclipse(payload, rec, ut);
      offsets.push(payload.tell());
    }
    payload.padToByte();
    const data = payload.toBytes();
    const N = entries.length;
    const section = new Uint8Array(4 * (N + 1) + data.length);
    for (let i = 0; i <= N; i++) writeUint32LE(section, 4 * i, offsets[i]);
    section.set(data, 4 * (N + 1));
    sections.push({ saros, N, section });
  }

  // Lay out payload and compute bit offsets.
  let payloadLen = 0;
  for (const s of sections) { s.bitOffset = payloadLen * 8; payloadLen += s.section.length; }
  const topSize = 8 + K * 8;
  const out = new Uint8Array(topSize + payloadLen);
  out.set(MAGIC, 0);
  out[4] = VERSION;
  out[5] = 0;
  writeUint16LE(out, 6, K);
  for (let i = 0; i < K; i++) {
    const s = sections[i];
    writeUint16LE(out, 8 + i * 8 + 0, s.saros);
    writeUint16LE(out, 8 + i * 8 + 2, s.N);
    writeUint32LE(out, 8 + i * 8 + 4, s.bitOffset);
  }
  let cursor = topSize;
  for (const s of sections) {
    out.set(s.section, cursor);
    cursor += s.section.length;
  }
  return out;
}

export function decodeSingle(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error('bad magic');
  }
  if (bytes[4] !== VERSION) throw new Error(`unsupported version ${bytes[4]}`);
  const K = readUint16LE(bytes, 6);
  const directory = [];
  for (let i = 0; i < K; i++) {
    const off = 8 + i * 8;
    directory.push({
      saros: readUint16LE(bytes, off),
      N: readUint16LE(bytes, off + 2),
      bitOffset: readUint32LE(bytes, off + 4),
    });
  }
  const payloadStart = 8 + K * 8;
  const payload = bytes.subarray(payloadStart);
  const result = {};
  for (let idx = 0; idx < K; idx++) {
    const { saros, N, bitOffset } = directory[idx];
    const byteOff = bitOffset / 8;
    const offsets = [];
    for (let i = 0; i <= N; i++) offsets.push(readUint32LE(payload, byteOff + 4 * i));
    const dataStart = byteOff + 4 * (N + 1);
    const nextByteOff = idx + 1 < K ? directory[idx + 1].bitOffset / 8 : payload.length;
    const sectionData = payload.subarray(dataStart, nextByteOff);
    const records = [];
    for (let i = 0; i < N; i++) {
      records.push(decodeEclipse(new BitReader(sectionData, offsets[i])));
    }
    result[String(saros)] = records;
  }
  return result;
}
