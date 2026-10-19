import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyNativeStaticAudioSourcePermissionBinding } from './native-static-audio-source-evidence.js';

const binding = JSON.parse(await readFile(new URL('./fixtures/native-query-inputs/static-audio-source-permissions.json', import.meta.url)));

test('static Audio evidence rejects a changed native policy case', async () => {
  const changed = structuredClone(binding);
  changed.cases[0].transcodingPolicy.EnableAudioPlaybackTranscoding = true;
  await assert.rejects(verifyNativeStaticAudioSourcePermissionBinding(changed), /Static Audio matrix inputs/u);
});

test('static Audio evidence rejects a changed neutral input hash', async () => {
  const changed = structuredClone(binding);
  changed.neutralFixture.sha256 = '0'.repeat(64);
  await assert.rejects(verifyNativeStaticAudioSourcePermissionBinding(changed), /Static Audio input hash/u);
});

test('static Audio evidence rejects an undeclared neutral fixture change', async () => {
  const changed = structuredClone(binding);
  changed.neutralFixture = structuredClone(binding.originalNeutralFixture);
  await assert.rejects(verifyNativeStaticAudioSourcePermissionBinding(changed), /Static Audio neutral fixture/u);
});

test('static Audio evidence rejects a changed recording directory seal', async () => {
  const changed = structuredClone(binding);
  changed.recordings[0].directory.entriesSha256 = '0'.repeat(64);
  await assert.rejects(verifyNativeStaticAudioSourcePermissionBinding(changed), /Current static Audio recording directory/u);
});

test('static Audio evidence rejects a changed oracle artifact hash', async () => {
  const changed = structuredClone(binding);
  changed.recordings[0].oracle.sha256 = '0'.repeat(64);
  await assert.rejects(verifyNativeStaticAudioSourcePermissionBinding(changed), /Static Audio input hash/u);
});
