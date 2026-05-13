import { decodeSeries } from "./saros-geo/saros_geo.js";

export const SAROS_NUMBERS = Object.freeze([
  101, 102, 103, 104, 105, 106, 107, 108, 109, 110,
  111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
  121, 122, 123, 124, 125, 126, 127, 128, 129, 130,
  131, 132, 133, 134, 135, 136, 137, 138, 139, 140,
  141, 142, 143, 144, 145, 146, 147, 148, 149, 150,
  151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
  161, 162, 163, 164, 165, 166, 167, 168, 169, 170,
  171, 172, 173,
]);

const PARTIAL_TYPES = new Set(["P", "Pb", "Pe", "Aminus", "Aplus", "Tminus", "Tplus"]);
const seriesCache = new Map();

export async function loadSarosSeries(sarosNumber) {
  const number = Number(sarosNumber);
  if (!SAROS_NUMBERS.includes(number)) throw new Error(`Saros ${sarosNumber} is not available`);
  if (seriesCache.has(number)) return seriesCache.get(number);

  const url = new URL(`./saros-geo/data/${number}.bin`, import.meta.url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Saros ${number}: ${response.status}`);
  const records = decodeSeries(new Uint8Array(await response.arrayBuffer())).map((record, position) => ({
    ...record,
    sarosNumber: number,
    sarosPosition: position,
  }));
  seriesCache.set(number, records);
  return records;
}

export function eclipseOptionLabel(record) {
  const date = String(record.datetime_utc ?? "").slice(0, 10) || "unknown date";
  return `${record.sarosPosition} · ${date} · ${record.type}`;
}

export function eclipseStatusLabel(record) {
  if (!record) return "eclipse overlay off";
  const date = String(record.datetime_utc ?? "").slice(0, 10) || "unknown date";
  return `Saros ${record.sarosNumber} #${record.sarosPosition} ${date} ${record.type}`;
}

export function eclipseSignature(record) {
  if (!record) return "none";
  return `${record.sarosNumber}:${record.sarosPosition}:${record.datetime_utc}:${record.type}`;
}

export function isPartialEclipse(recordOrType) {
  const type = typeof recordOrType === "string" ? recordOrType : recordOrType?.type;
  return PARTIAL_TYPES.has(type);
}
