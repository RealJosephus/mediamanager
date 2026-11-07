import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../tools/validation/inventory.js';
import { prepareFrozenVideo } from '../helpers/frozen-av.js';
import { defineDvdScanExchange } from './dvd-scan-exchange-scenario.js';
import { verifyDvd } from './fixtures/real-dvd-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_POSTGRES);

defineDvdScanExchange({ enabled, movieName: 'Compact DVD (2008)', async prepareInput({ root, signal }) {
  const mediaRoot = path.join(root, 'fixture-media');
  await mkdir(path.join(mediaRoot, 'VIDEO_TS'), { recursive: true });
  const stereo = await prepareFrozenVideo(root, { container: 'vob', name: 'stereo', includeAudio: true, signal });
  const video = await prepareFrozenVideo(root, { container: 'vob', name: 'video', signal });
  // The default and missing-title selections group the two _1 files. Title 1
  // also selects _2. The actual VOBs with menu names must never be probed.
  const manifest = [{ path: 'VIDEO_TS', type: 'directory', bytes: 0 }];
  for (const [name, { bytes }] of [['VIDEO_TS.VOB', video], ['VTS_01_0.VOB', video],
    ['VTS_01_1.VOB', stereo], ['VTS_01_2.VOB', stereo], ['VTS_02_1.VOB', video]]) {
    const member = 'VIDEO_TS/' + name;
    await writeFile(path.join(mediaRoot, 'VIDEO_TS', name), bytes, { flag: 'wx', signal });
    manifest.push({ path: member, type: 'file', bytes: bytes.length, sha256: sha256(bytes) });
  }
  const receipt = { kind: 'compact-video-ts', bytes: manifest.reduce((sum, member) => sum + member.bytes, 0),
    remuxEvidence: [stereo.evidence, video.evidence] };
  const supply = { mediaRoot, manifest, receipt };
  return { ...supply, verifyInputs: () => verifyDvd(supply, mediaRoot) };
} });
