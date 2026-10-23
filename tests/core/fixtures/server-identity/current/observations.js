import assert from 'node:assert/strict';
import { decodeNativeText } from '../../../../../src/core/native-text.js';

const generatedIdentity = value => assert.match(value, /^[a-f0-9]{32}$/u);
const text = bytes => bytes == null ? null : decodeNativeText(Buffer.from(bytes, 'base64'));

export function identityObservation(row) {
  const original = text(row.beforeBytes), generated = row.value !== original;
  if (generated) generatedIdentity(row.value);
  assert.equal(row.cachedValue, row.value);
  assert.equal(row.validGuid, true);
  const saved = generated && text(row.afterBytes) === row.value;
  const reopenedSame = row.reopenedValue === row.value;
  if (saved) assert.equal(reopenedSame, true);
  if (!reopenedSame && row.reopenedValue !== original) generatedIdentity(row.reopenedValue);
  const reopenedPersisted = text(row.reopenedBytes) === row.reopenedValue;
  return { name: row.name, generated, value: generated ? '{generated}' : row.value,
    saved, reopenedSame, reopenedValue: reopenedSame && generated ? '{generated}'
      : row.reopenedValue === original ? original : '{regenerated}',
    beforeBytes: row.beforeBytes, afterFile: saved ? { identity: '{generated}' } : { bytes: row.afterBytes },
    reopenedPersisted, afterDirectory: row.afterDirectory };
}
