import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dvdReferenceInputs } from '../../tools/validation/dvd-reference-inputs.js';
import { sha256 } from '../../tools/validation/inventory.js';
import { prepareFrozenVideo } from '../helpers/frozen-av.js';
import { createDvdScanExchange } from './dvd-scan-exchange-scenario.js';
import { verifyDvd } from './fixtures/real-dvd-current/scenario.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const original = process.env.MEDIAMANAGER_CI_DVD_REFERENCE === 'true';
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_POSTGRES);

async function prepareOriginalInput({ root, report }) {
  const supply = await dvdReferenceInputs();
  report.original = { receipt: supply.receipt, manifest: supply.manifest };
  const refusal = path.join(root, 'empty-disc-refusal'), falseRoot = path.join(refusal, 'mediamanager-disc-reference');
  await mkdir(falseRoot, { recursive: true });
  await cp(supply.evidence, path.join(falseRoot, 'evidence'), { recursive: true, force: false, errorOnExist: true });
  await mkdir(path.join(falseRoot, 'media'));
  const falseReceipt = path.join(falseRoot, 'evidence', 'receipt.json');
  await writeFile(falseReceipt, JSON.stringify({ ...supply.receipt, mediaRoot: path.join(falseRoot, 'media') }) + '\n');
  await assert.rejects(dvdReferenceInputs({ ...process.env, RUNNER_TEMP: refusal, MEDIAMANAGER_TEST_DVD_REFERENCE: falseReceipt }),
    error => Array.isArray(error.actual) && error.actual.length === 0
      && JSON.stringify(error.expected) === JSON.stringify(supply.manifest));
  report.emptyPayloadRejected = true;
  return { ...supply, async verifyInputs() { assert.deepEqual((await dvdReferenceInputs()).inputs, supply.inputs); } };
}

async function prepareCompactInput({ root, signal }) {
  const mediaRoot = path.join(root, 'fixture-media');
  await mkdir(path.join(mediaRoot, 'VIDEO_TS'), { recursive: true });
  const stereo = await prepareFrozenVideo(root, { container: 'vob', name: 'stereo', includeAudio: true, signal });
  const video = await prepareFrozenVideo(root, { container: 'vob', name: 'video', signal });
  // Default and missing-title selections group the two _1 files. Title 1
  // also selects _2. The menu files must be excluded from the selection.
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
}

const run = createDvdScanExchange({ enabled, original, movieName: original ? 'Big Buck Bunny (2008)' : 'Compact DVD (2008)',
  prepareInput: original ? prepareOriginalInput : prepareCompactInput });
const label = original ? 'the complete original DVD' : 'the compact VIDEO_TS fixture';
test(`${label} survives actual Native and Node VFS probing, fresh scans, SQLite continuation and cold PostgreSQL`, {
  skip: !enabled, timeout: 900000,
}, run);
