import {open} from 'node:fs/promises';
import {gunzip, gzipSync} from 'node:zlib';
import {promisify} from 'node:util';

const inflate = promisify(gunzip);
const headerLength = 127;
const maximumTileBytes = 8 * 1024 * 1024;

export function tileId(z, x, y) {
 const size = 2 ** z;
 if (!Number.isInteger(z) || z < 0 || z > 20 ||
     !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
  throw new RangeError('Invalid tile coordinate');
 }
 let order = (size * size - 1) / 3;
 for (let step = size / 2; step >= 1; step /= 2) {
  const right = Number((x & step) !== 0);
  const upper = Number((y & step) !== 0);
  order += step * step * ((3 * right) ^ upper);
  if (upper === 0) {
   if (right === 1) {
    x = step - 1 - x;
    y = step - 1 - y;
   }
   [x,y] = [y,x];
  }
 }
 return order;
}

function writeVarint(output, n) {
 while (n >= 128) {
  output.push(n % 128 + 128);
  n = Math.floor(n / 128);
 }
 output.push(n);
}

function encode(entries) {
 const raw = [];
 writeVarint(raw, entries.length);
 let previousId = 0;
 for (const entry of entries) {
  writeVarint(raw, entry.id - previousId);
  previousId = entry.id;
 }
 for (const entry of entries) writeVarint(raw, entry.run);
 for (const entry of entries) writeVarint(raw, entry.length);
 let end = -1;
 for (const entry of entries) {
  writeVarint(raw, entry.offset === end ? 0 : entry.offset + 1);
  end = entry.offset + entry.length;
 }
 return gzipSync(Buffer.from(raw));
}

function decode(raw) {
 let cursor = 0;
 function readVarint() {
  let value = 0;
  for (let shift = 0; shift < 53 && cursor < raw.length; shift += 7) {
   const byte = raw[cursor++];
   value += (byte & 127) * 2 ** shift;
   if (byte < 128 && Number.isSafeInteger(value)) return value;
  }
  throw new Error('Invalid PMTiles directory');
 }
 const count = readVarint();
 if (count > 250000 || count > raw.length / 4) throw new Error('Invalid PMTiles entry count');
 let id = 0;
 const entries = Array.from({length: count}, () => ({id: id += readVarint()}));
 for (const entry of entries) entry.run = readVarint();
 for (const entry of entries) entry.length = readVarint();
 let end = -1;
 for (const entry of entries) {
  const offset = readVarint();
  entry.offset = offset ? offset - 1 : end;
  if (entry.offset < 0 || !Number.isSafeInteger(entry.offset + entry.length)) throw new Error('Invalid PMTiles offset');
  end = entry.offset + entry.length;
 }
 return entries;
}

function lookup(entries, id) {
 let low = 0, high = entries.length;
 while (low < high) {
  const middle = (low + high) >>> 1;
  if (entries[middle].id <= id) low = middle + 1;
  else high = middle;
 }
 const entry = entries[low - 1];
 return entry && (entry.run === 0 || id < entry.id + entry.run) ? entry : null;
}

// PMTiles v3 MVT archive. Tile and directory compression are independent of
// HTTP compression. One archive can be copied to disk or served with ranges.
export function packTiles(tiles, {
 name, minZoom, maxZoom, bounds = [-180,-85,180,85], center = [0,0,minZoom], attribution
}) {
 const ordered = tiles.map(tile => ({...tile, id: tileId(tile.z,tile.x,tile.y)})).sort((a,b) => a.id - b.id);
 if (!ordered.length) throw new Error('Cannot pack an empty map');
 const entries = [], contents = [];
 let tileLength = 0;
 for (const tile of ordered) {
  if (entries.at(-1)?.id === tile.id) throw new Error('Duplicate tile');
  const payload = gzipSync(tile.bytes);
  entries.push({id:tile.id, run:1, offset:tileLength, length:payload.length});
  contents.push(payload);
  tileLength += payload.length;
 }
 const branches = [], leaves = [];
 let leafLength = 0;
 let root = encode(entries);
 if (headerLength + root.length > 16384) {
  for (let i = 0; i < entries.length; i += 512) {
   const leaf = encode(entries.slice(i,i+512));
   branches.push({id:entries[i].id, run:0, offset:leafLength, length:leaf.length});
   leaves.push(leaf);
   leafLength += leaf.length;
  }
  root = encode(branches);
 }
 if (headerLength + root.length > 16384) throw new Error('PMTiles root too large');
 const metadata = gzipSync(Buffer.from(JSON.stringify({name, format:'pbf', attribution, vector_layers:[]})));
 const metadataOffset = headerLength + root.length;
 const leafOffset = metadataOffset + metadata.length;
 const dataOffset = leafOffset + leafLength;
 const header = Buffer.alloc(headerLength);
 header.write('PMTiles', 0, 'ascii');
 header[7] = 3;
 [headerLength,root.length,metadataOffset,metadata.length,leafOffset,leafLength,dataOffset,tileLength,
  entries.length,entries.length,entries.length].forEach((value, index) => header.writeBigUInt64LE(BigInt(value),8+index*8));
 header[96] = 1; // clustered
 header[97] = 2; // gzip directories
 header[98] = 2; // gzip MVT contents
 header[99] = 1;
 header[100] = minZoom;
 header[101] = maxZoom;
 bounds.forEach((value, index) => header.writeInt32LE(Math.round(value * 1e7), 102 + index * 4));
 header[118] = center[2];
 header.writeInt32LE(Math.round(center[0] * 1e7), 119);
 header.writeInt32LE(Math.round(center[1] * 1e7), 123);
 return Buffer.concat([header,root,metadata,...leaves,...contents]);
}

export async function openAtlas(file) {
 const handle = await open(file,'r').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
 });
 if (!handle) return null;
 const size = (await handle.stat()).size;
 async function read(offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || length > maximumTileBytes || offset + length > size) {
   throw new Error('PMTiles range outside archive');
  }
  const data = Buffer.allocUnsafe(length);
  const result = await handle.read(data,0,length,offset);
  if (result.bytesRead !== length) throw new Error('Truncated PMTiles data');
  return data;
 }
 try {
  const header = await read(0,headerLength);
  if (header.toString('ascii',0,7) !== 'PMTiles' || header[7] !== 3 || header[99] !== 1)
   throw new Error('Expected a PMTiles v3 vector archive');
  const range = offset => Number(header.readBigUInt64LE(offset));
  const rootOffset = range(8), rootLength = range(16);
  if (rootOffset + rootLength > 16384) throw new Error('PMTiles root exceeds 16 KiB');
  const compression = value => value === 2 ? data => inflate(data,{maxOutputLength:maximumTileBytes})
   : value === 1 ? data => data : null;
  const directory = compression(header[97]), tileCompression = compression(header[98]);
  if (!directory || !tileCompression) throw new Error('Unsupported PMTiles compression');
  const root = decode(await directory(await read(rootOffset,rootLength)));
  const leafOffset = range(40), tileOffset = range(56);
  const leaves = new Map();
  const minZoom = header[100], maxZoom = header[101];
  return {
   minZoom, maxZoom,
   close: () => handle.close(),
   async tile(z,x,y) {
    if (z < minZoom || z > maxZoom) return null;
    const id = tileId(z,x,y);
    let entry = lookup(root,id);
    for (let depth = 0; entry?.run === 0 && depth < 3; ++depth) {
     const offset = leafOffset + entry.offset, length = entry.length;
     if (!leaves.has(offset)) {
      if (leaves.size >= 64) leaves.delete(leaves.keys().next().value);
      const task = read(offset,length).then(directory).then(decode);
      leaves.set(offset,task);
      task.catch(() => leaves.delete(offset));
     }
     entry = lookup(await leaves.get(offset),id);
    }
    if (!entry || !entry.run) return null;
    return tileCompression(await read(tileOffset + entry.offset,entry.length));
   }
  };
 } catch(error) {
  await handle.close();
  throw error;
 }
}
