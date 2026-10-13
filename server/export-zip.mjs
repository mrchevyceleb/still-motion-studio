import { mkdir, readFile, writeFile, stat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MAX_EXTRACT_BYTES = 1024 * 1024 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Read the central directory rather than trusting local headers or shelling out.
function zipEntries(archive) {
  const invalid = () => { throw new Error('The Unreal package contains an invalid or unsupported ZIP entry.'); };
  let end = archive.length - 22;
  for (; end >= Math.max(0, archive.length - 65557); end--) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
  }
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50) invalid();
  const count = archive.readUInt16LE(end + 10), size = archive.readUInt32LE(end + 12), start = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 8) !== count || count === 0xffff || start + size !== end) invalid();
  const entries = [], names = new Set();
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const compressed = archive.readUInt32LE(cursor + 20), unpacked = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28), extra = archive.readUInt16LE(cursor + 30), comment = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42), mode = archive.readUInt32LE(cursor + 38) >>> 16;
    if (cursor + 46 + nameLength + extra + comment > end || flags & 1 || ![0, 8].includes(method) || archive.readUInt16LE(cursor + 34) || (mode & 0xf000) === 0xa000) invalid();
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength).replace(/\\/g, '/');
    const directory = name.endsWith('/'), parts = (directory ? name.slice(0, -1) : name).split('/');
    if (!name || name.startsWith('/') || /[:\u0000-\u001f]/.test(name) || parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('The Unreal package contains an unsafe file path.');
    const key = parts.join('/').toLowerCase();
    if (names.has(key)) invalid();
    names.add(key);
    if (offset + 30 > start || archive.readUInt32LE(offset) !== 0x04034b50 || archive.readUInt16LE(offset + 8) !== method) invalid();
    const dataStart = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    if (dataStart + compressed > start || compressed === 0xffffffff || unpacked === 0xffffffff) invalid();
    total += unpacked;
    if (total > MAX_EXTRACT_BYTES) throw new Error('The extracted Unreal package exceeds 1 GB. Download the ZIP instead.');
    entries.push({ parts, directory, method, unpacked, checksum: archive.readUInt32LE(cursor + 16), data: archive.subarray(dataStart, dataStart + compressed) });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end || !entries.length) invalid();
  return entries;
}

export async function saveExportPackage(filename, folder, name, signal) {
  signal?.throwIfAborted();
  if (typeof folder !== 'string' || !folder || folder.length > 4096 || !path.isAbsolute(folder)) throw new Error('Enter an absolute path to an existing folder on this computer.');
  let parent;
  try {
    parent = await realpath(folder);
    if (!(await stat(parent)).isDirectory()) throw new Error();
  } catch { throw new Error('Choose an existing folder on this computer. Still only creates the export subfolder.'); }
  if ((await stat(filename)).size > MAX_EXTRACT_BYTES) throw new Error('The Unreal ZIP exceeds 1 GB. Download the ZIP instead.');
  const entries = zipEntries(await readFile(filename));
  let safeName = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80).replace(/[. ]+$/, '') || 'Animation';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName)) safeName = `_${safeName}`;
  let savedTo;
  for (let suffix = 1; ; suffix++) {
    signal?.throwIfAborted();
    savedTo = path.join(parent, safeName + (suffix === 1 ? '' : `_${suffix}`));
    try { await mkdir(savedTo); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  try {
    for (const entry of entries) {
      signal?.throwIfAborted();
      const destination = path.join(savedTo, ...entry.parts);
      if (entry.directory) { await mkdir(destination, { recursive: true }); continue; }
      await mkdir(path.dirname(destination), { recursive: true });
      const data = entry.method === 0 ? entry.data : inflateRawSync(entry.data, { maxOutputLength: Math.max(1, entry.unpacked) });
      if (data.length !== entry.unpacked || crc32(data) !== entry.checksum) throw new Error('The Unreal package contains an incomplete or damaged ZIP entry.');
      await writeFile(destination, data, { flag: 'wx' });
    }
    signal?.throwIfAborted();
    return savedTo;
  } catch (error) {
    await rm(savedTo, { recursive: true, force: true });
    throw error;
  }
}
