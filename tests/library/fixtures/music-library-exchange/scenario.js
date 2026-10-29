import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readXml, textOf } from '../../../../src/core/xml.js';
import { optionalFile, ownedPath, sha } from '../../../helpers/library-exchange-state.js';

export const inputBytes = await readFile(new URL('./input.json', import.meta.url));
export const input = JSON.parse(inputBytes);

function riffChunk(name, data) {
  const header = Buffer.alloc(8);
  header.write(name, 0, 4, 'ascii'); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
export function waveBytes(track) {
  const format = Buffer.alloc(16), samples = input.sampleRate * track.seconds;
  format.writeUInt16LE(1, 0); format.writeUInt16LE(1, 2);
  format.writeUInt32LE(input.sampleRate, 4); format.writeUInt32LE(input.sampleRate * 2, 8);
  format.writeUInt16LE(2, 12); format.writeUInt16LE(16, 14);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) pcm.writeInt16LE(((index * (track.number + 1)) % 64 - 32) * 128, index * 2);
  const tags = { INAM: track.title, IART: input.artist, IPRD: input.album,
    ITRK: String(track.number), ICRD: String(input.year), IGNR: input.genre };
  const info = Buffer.concat([Buffer.from('INFO'), ...Object.entries(tags)
    .map(([name, value]) => riffChunk(name, Buffer.from(value + '\0', 'ascii')))]);
  const body = Buffer.concat([Buffer.from('WAVE'), riffChunk('fmt ', format), riffChunk('LIST', info), riffChunk('data', pcm)]);
  return riffChunk('RIFF', body);
}
export async function createMedia(root) {
  const mediaRoot = ownedPath(root, path.join(root, 'media'));
  const artistRoot = path.join(mediaRoot, input.artist), albumRoot = path.join(artistRoot, input.album);
  await mkdir(albumRoot, { recursive: true });
  const sources = input.tracks.map(track => waveBytes(track));
  const files = input.tracks.map(track => path.join(albumRoot, track.filename));
  for (const index of [0, 1]) await writeFile(files[index], sources[index], { flag: 'wx' });
  const sibling = path.join(albumRoot, 'unrelated.keep');
  await writeFile(sibling, input.siblingText, { flag: 'wx' });
  return { root: mediaRoot, artistRoot, albumRoot, files, sources, sibling };
}
export async function addTrack(media, index) {
  await writeFile(media.files[index], media.sources[index], { flag: 'wx' });
}
export async function assetSnapshot(media, present) {
  const tracks = [];
  for (const [index, filename] of media.files.entries()) {
    const file = await optionalFile(filename);
    assert.deepEqual(file, present.includes(index)
      ? { bytes: media.sources[index].length, sha256: sha(media.sources[index]) } : null);
    tracks.push({ index, filename, file });
  }
  const sibling = await optionalFile(media.sibling);
  assert.deepEqual(sibling, { bytes: Buffer.byteLength(input.siblingText), sha256: sha(input.siblingText) });
  return { tracks, sibling };
}
export async function albumNfoSnapshot(media, overview) {
  const filename = path.join(media.albumRoot, 'album.nfo');
  assert.ok(await optionalFile(filename), 'The actual album save must write its NFO through the storage plugin.');
  const bytes = await readFile(filename), root = readXml(bytes.toString('utf8'));
  assert.equal(root.name, 'album');
  assert.equal(textOf(root, 'title'), input.album);
  assert.equal(textOf(root, 'review'), overview);
  return { filename, bytes: bytes.length, sha256: sha(bytes), rawBase64: bytes.toString('base64') };
}

