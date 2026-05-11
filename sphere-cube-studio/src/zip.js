const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(files) {
  const enc = new TextEncoder();
  const entries = files.map((file) => ({
    name: file.name,
    nameBytes: enc.encode(file.name),
    data: file.data,
    crc: crc32(file.data),
    localOffset: 0,
  }));

  let offset = 0;
  for (const entry of entries) {
    entry.localOffset = offset;
    offset += 30 + entry.nameBytes.length + entry.data.length;
  }
  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;
  for (const entry of entries) centralDirectorySize += 46 + entry.nameBytes.length;
  const total = centralDirectoryOffset + centralDirectorySize + 22;

  const buffer = new ArrayBuffer(total);
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  const u16 = (value, at) => dv.setUint16(at, value, true);
  const u32 = (value, at) => dv.setUint32(at, value, true);

  let p = 0;
  for (const entry of entries) {
    u32(0x04034b50, p); p += 4;
    u16(20, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u32(entry.crc, p); p += 4;
    u32(entry.data.length, p); p += 4;
    u32(entry.data.length, p); p += 4;
    u16(entry.nameBytes.length, p); p += 2;
    u16(0, p); p += 2;
    u8.set(entry.nameBytes, p); p += entry.nameBytes.length;
    u8.set(entry.data, p); p += entry.data.length;
  }

  for (const entry of entries) {
    u32(0x02014b50, p); p += 4;
    u16(20, p); p += 2;
    u16(20, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u32(entry.crc, p); p += 4;
    u32(entry.data.length, p); p += 4;
    u32(entry.data.length, p); p += 4;
    u16(entry.nameBytes.length, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u16(0, p); p += 2;
    u32(0, p); p += 4;
    u32(entry.localOffset, p); p += 4;
    u8.set(entry.nameBytes, p); p += entry.nameBytes.length;
  }

  u32(0x06054b50, p); p += 4;
  u16(0, p); p += 2;
  u16(0, p); p += 2;
  u16(entries.length, p); p += 2;
  u16(entries.length, p); p += 2;
  u32(centralDirectorySize, p); p += 4;
  u32(centralDirectoryOffset, p); p += 4;
  u16(0, p);

  return new Blob([buffer], { type: "application/zip" });
}
