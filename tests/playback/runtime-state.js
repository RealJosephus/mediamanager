import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function createPlaybackState() {
  const root = await mkdtemp(path.join(tmpdir(), 'playback-instance-'));
  return { root, async close() {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('playback-instance-'));
    await rm(root, { recursive: true, force: true });
  } };
}
