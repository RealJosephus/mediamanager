import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { blurayReferenceInputs } from '../../../../tools/validation/bluray-reference-inputs.js';
import { sha256 } from '../../../../tools/validation/inventory.js';
import { readFrozenAv } from '../../../helpers/frozen-av.js';
import { makeBlurayFiles } from '../../../storage/fixtures/bluray-disc-info/fixture.js';
import { verifyBluray } from './scenario.js';

const layout = new URL('../../../storage/fixtures/bluray-disc-info/input.json', import.meta.url);

export async function prepareBlurayInput({ root, signal, original, playback = false }) {
  if (original) {
    const supply = await blurayReferenceInputs();
    return { ...supply, async verifyInputs() { assert.deepEqual((await blurayReferenceInputs()).inputs, supply.inputs); } };
  }
  const mediaRoot = path.join(root, 'fixture-media');
  const layoutBytes = await readFile(layout, { signal });
  const sourceLayout = JSON.parse(layoutBytes);
  const pictureAndAudio = sourceLayout.clips[1].streams.filter(stream => [2, 129].includes(stream.type));
  const selectedLayout = playback ? {
    clips: sourceLayout.clips.slice(0, 2).map(({ id }) => ({ id, streams: pictureAndAudio })),
    playlists: [{ id: '00001', items: sourceLayout.clips.slice(0, 2).map(({ id }) => ({ clip: id, in: 0, out: 90000 })),
      marks: [{ item: 0, time: 0 }, { item: 1, time: 0 }] }],
  } : sourceLayout;
  const { bytes: media, source } = await readFrozenAv('source.m2ts', { signal });
  const files = makeBlurayFiles(selectedLayout, media);
  const manifest = ['BDMV', 'BDMV/CLIPINF', 'BDMV/PLAYLIST', 'BDMV/STREAM']
    .map(member => ({ path: member, kind: 'directory', bytes: 0 }));
  for (const directory of manifest) await mkdir(path.join(mediaRoot, ...directory.path.split('/')), { recursive: true });
  for (const [member, bytes] of files) {
    await writeFile(path.join(mediaRoot, ...member.split('/')), bytes, { flag: 'wx', signal });
    manifest.push({ path: member, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) });
  }
  manifest.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const receipt = { kind: playback ? 'compact-playable-bdmv' : 'compact-bdmv', bytes: manifest.reduce((sum, member) => sum + member.bytes, 0),
    layoutSha256: sha256(playback ? Buffer.from(JSON.stringify(selectedLayout)) : layoutBytes), source };
  const supply = { mediaRoot, manifest, receipt };
  return { ...supply, verifyInputs: () => verifyBluray(supply, mediaRoot) };
}
