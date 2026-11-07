import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../tools/validation/inventory.js';
import { readFrozenAv } from '../helpers/frozen-av.js';
import { makeBlurayFiles } from '../storage/fixtures/bluray-disc-info/fixture.js';
import { createBlurayScanExchange } from './bluray-scan-exchange-scenario.js';
import { verifyBluray } from './fixtures/real-bluray-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_POSTGRES);
const layout = new URL('../storage/fixtures/bluray-disc-info/input.json', import.meta.url);

const run = createBlurayScanExchange({ enabled, movieName: 'Compact Blu-ray (2010)', async prepareInput({ root, signal }) {
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
} });

test('the compact BDMV fixture survives actual Native and Node VFS probing, fresh scans, SQLite continuation and cold PostgreSQL', {
  skip: !enabled, timeout: 900000,
}, run);
