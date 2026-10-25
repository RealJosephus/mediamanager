import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { writeConfigurationFile } from '../../src/core/configuration-file.js';

export async function createPlaybackState(encodingOptions) {
  const directory = await mkdtemp(path.join(tmpdir(), 'playback-instance-'));
  const root = path.join(directory, 'data'), configurationDirectoryPath = path.join(directory, 'config');
  await mkdir(root); await mkdir(configurationDirectoryPath);
  if (encodingOptions) await writeConfigurationFile(path.join(configurationDirectoryPath, 'encoding.xml'), 'encoding',
    { ...defaultConfiguration('encoding'), ...encodingOptions });
  return { root, configurationDirectoryPath, async close() {
    assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith('playback-instance-'));
    await rm(directory, { recursive: true, force: true });
  } };
}
