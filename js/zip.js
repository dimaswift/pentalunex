// Minimal "store" (uncompressed) ZIP writer. Spec ref: PKZIP APPNOTE.TXT.
// All multi-byte fields are little-endian. We keep mod-time/date at 0; the
// only real work is computing CRC32 per file and writing the local-header /
// central-directory pair. No streaming, no compression — fine for a handful
// of PNGs that are already compressed.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++)
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name: string, data: Uint8Array }] → Blob('application/zip')
export function buildZip(files) {
  const enc = new TextEncoder();
  const entries = files.map(f => ({
    name: f.name,
    nameBytes: enc.encode(f.name),
    data: f.data,
    crc: crc32(f.data),
    localOffset: 0,
  }));

  // Compute local-header offsets.
  let off = 0;
  for (const e of entries) {
    e.localOffset = off;
    off += 30 + e.nameBytes.length + e.data.length;
  }
  const cdOffset = off;
  let cdSize = 0;
  for (const e of entries) cdSize += 46 + e.nameBytes.length;
  const total = cdOffset + cdSize + 22;

  const buf = new ArrayBuffer(total);
  const u8  = new Uint8Array(buf);
  const dv  = new DataView(buf);
  const u32 = (v, o) => dv.setUint32(o, v, true);
  const u16 = (v, o) => dv.setUint16(o, v, true);

  let p = 0;
  // Local file headers + data.
  for (const e of entries) {
    u32(0x04034b50, p); p += 4;
    u16(20, p); p += 2;        // version needed
    u16(0,  p); p += 2;        // flags
    u16(0,  p); p += 2;        // method (stored)
    u16(0,  p); p += 2;        // mod time
    u16(0,  p); p += 2;        // mod date
    u32(e.crc,         p); p += 4;
    u32(e.data.length, p); p += 4;
    u32(e.data.length, p); p += 4;
    u16(e.nameBytes.length, p); p += 2;
    u16(0, p); p += 2;         // extra length
    u8.set(e.nameBytes, p); p += e.nameBytes.length;
    u8.set(e.data,      p); p += e.data.length;
  }

  // Central directory.
  for (const e of entries) {
    u32(0x02014b50, p); p += 4;
    u16(20, p); p += 2;        // version made by
    u16(20, p); p += 2;        // version needed
    u16(0,  p); p += 2;        // flags
    u16(0,  p); p += 2;        // method
    u16(0,  p); p += 2;        // mod time
    u16(0,  p); p += 2;        // mod date
    u32(e.crc,         p); p += 4;
    u32(e.data.length, p); p += 4;
    u32(e.data.length, p); p += 4;
    u16(e.nameBytes.length, p); p += 2;
    u16(0, p); p += 2;         // extra length
    u16(0, p); p += 2;         // comment length
    u16(0, p); p += 2;         // disk number
    u16(0, p); p += 2;         // internal attrs
    u32(0, p); p += 4;         // external attrs
    u32(e.localOffset, p); p += 4;
    u8.set(e.nameBytes, p); p += e.nameBytes.length;
  }

  // End of central directory.
  u32(0x06054b50, p); p += 4;
  u16(0, p); p += 2;
  u16(0, p); p += 2;
  u16(entries.length, p); p += 2;
  u16(entries.length, p); p += 2;
  u32(cdSize,   p); p += 4;
  u32(cdOffset, p); p += 4;
  u16(0, p); p += 2;

  return new Blob([buf], { type: 'application/zip' });
}
