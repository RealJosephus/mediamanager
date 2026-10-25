import assert from 'node:assert/strict';
import { decodeNativeText } from '../../../../src/core/native-text.js';

export function identityObservation(row) {
  let original = null; if (row.beforeBytes != null) original = decodeNativeText(Buffer.from(row.beforeBytes, 'base64'));
  const generated = original !== row.value;
  if (generated) assert.match(row.value, /^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u);
  assert.equal(row.cachedValue, row.value); assert.equal(row.validGuid, true);
  let savedValue = null;
  if (row.afterBytes != null) savedValue = decodeNativeText(Buffer.from(row.afterBytes, 'base64'));
  const saved = generated && savedValue === row.value;
  const reopenedSame = row.reopenedValue === row.value;
  if (saved) assert.equal(reopenedSame, true);
  else if (row.reopenedValue !== original) assert.match(row.reopenedValue, /^[a-f0-9]{12}4[a-f0-9]{3}[89ab][a-f0-9]{15}$/u);
  return { name: row.name, generated, value: generated ? '{generated}' : row.value,
    saved, reopenedSame, reopenedValue: reopenedSame && generated ? '{generated}' : row.reopenedValue === original ? original : '{regenerated}',
    beforeBytes: row.beforeBytes, afterBytes: saved ? row.afterBytes.replace(Buffer.from(row.value).toString('base64'), '{generated}') : row.afterBytes,
    afterDirectory: row.afterDirectory };
}
