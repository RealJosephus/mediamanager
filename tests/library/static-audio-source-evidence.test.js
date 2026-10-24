import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyNativeStaticAudioSourcePermissionBinding } from './native-static-audio-source-evidence.js';

const binding = JSON.parse(await readFile(new URL('./fixtures/filter-http-current/static-audio-binding.json', import.meta.url)));

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

test('static Audio evidence rejects changed current Native recorder bytes', async () => {
  const changed = structuredClone(binding);
  changed.nativeRecorder.sha256 = '0'.repeat(64);
  await assert.rejects(verifyNativeStaticAudioSourcePermissionBinding(changed), /Static Audio recorder hash/u);
});

test('static Audio evidence rejects changed current request matrix bytes', async () => {
  const changed = structuredClone(binding);
  changed.requestMatrix.sha256 = '0'.repeat(64);
  await assert.rejects(verifyNativeStaticAudioSourcePermissionBinding(changed), /Static Audio request matrix hash/u);
});
