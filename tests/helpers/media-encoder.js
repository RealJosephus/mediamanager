import assert from 'node:assert/strict';
import { MediaEncoder } from '../../src/playback/media-encoder.js';
import { defaultConfiguration } from '../../src/core/configuration-xml.js';
import { validationExecutable } from '../../tools/validation/paths.js';

/** Component fixtures explicitly keep configuration in memory; runtime fixtures
 * use the real named store and its XML save operation. */
export async function createTestMediaEncoder(t, { startupFFmpegPath = validationExecutable('ffmpeg'), skipValidation = false,
  configuration = defaultConfiguration('encoding'), getEncodingOptions = () => configuration,
  saveEncodingOptions = async () => {}, onError = error => { throw error; } } = {}) {
  const encoder = new MediaEncoder({ startupFFmpegPath, skipValidation, getEncodingOptions, saveEncodingOptions, onError });
  t.after(() => encoder.close());
  assert.equal(await encoder.initialize(), true, 'A validated media executable is required by this component fixture.');
  return encoder;
}
