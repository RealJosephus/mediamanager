import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { blurayReferenceInputs } from '../../../../tools/validation/bluray-reference-inputs.js';
import { sha256 } from '../../../../tools/validation/inventory.js';
import { readFrozenAv } from '../../../helpers/frozen-av.js';
import { makeBlurayFiles } from '../../../storage/fixtures/bluray-disc-info/fixture.js';
import { verifyBluray } from './scenario.js';

const layout = new URL('../../../storage/fixtures/bluray-disc-info/input.json', import.meta.url);

export async function prepareBlurayInput({ root, signal, original }) {
  if (original) {
    const supply = await blurayReferenceInputs();
    return { ...supply, async verifyInputs() { assert.deepEqual((await blurayReferenceInputs()).inputs, supply.inputs); } };
  }
  const mediaRoot = path.join(root, 'fixture-media');
  const layoutBytes = await readFile(layout, { signal });
  const { bytes: media, source } = await readFrozenAv('source.m2ts', { signal });
  const files = makeBlurayFiles(JSON.parse(layoutBytes), media);
  const manifest = ['BDMV', 'BDMV/CLIPINF', 'BDMV/PLAYLIST', 'BDMV/STREAM']
    .map(member => ({ path: member, kind: 'directory', bytes: 0 }));
  for (const directory of manifest) await mkdir(path.join(mediaRoot, ...directory.path.split('/')), { recursive: true });
  for (const [member, bytes] of files) {
    await writeFile(path.join(mediaRoot, ...member.split('/')), bytes, { flag: 'wx', signal });
    manifest.push({ path: member, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) });
  }
  manifest.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const receipt = { kind: 'compact-bdmv', bytes: manifest.reduce((sum, member) => sum + member.bytes, 0),
    layoutSha256: sha256(layoutBytes), source };
  const supply = { mediaRoot, manifest, receipt };
  return { ...supply, verifyInputs: () => verifyBluray(supply, mediaRoot) };
}
