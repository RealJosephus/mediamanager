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

export function identityFileAccessObservation(row, access, control, errors) {
  const observed = identityObservation(row), original = text(row.beforeBytes);
  assert.equal(typeof access.read.succeeded, 'boolean');
  assert.equal(typeof access.write.succeeded, 'boolean');
  if (access.read.succeeded) assert.equal(access.read.bytes, row.beforeBytes);
  assert.equal(control.beforeBytes, row.beforeBytes);
  const accessible = identityObservation(control);
  assert.equal(row.afterDirectory, control.afterDirectory);
  assert.equal(accessible.reopenedPersisted, true);
  assert.equal(accessible.reopenedSame, true);
  if (accessible.generated) assert.equal(accessible.saved, true);
  else assert.equal(control.afterBytes, control.beforeBytes);
  const originalIsValid = control.value === original;
  const readOriginal = access.read.succeeded && originalIsValid;
  assert.equal(observed.generated, !readOriginal);
  if (readOriginal) {
    assert.equal(row.value, original);
    assert.equal(row.afterBytes, row.beforeBytes);
    assert.equal(row.reopenedValue, original);
    assert.equal(row.reopenedBytes, row.beforeBytes);
  } else if (access.write.succeeded) {
    assert.equal(text(row.afterBytes), row.value, 'An admitted identity repair must commit the generated ID.');
    assert.equal(row.reopenedValue, row.value);
    assert.equal(text(row.reopenedBytes), row.value);
  } else {
    assert.equal(row.afterBytes, row.beforeBytes, 'A refused identity write must leave the original file unchanged.');
    if (errors) assert.ok(errors.length > 0, 'A real identity access failure must be reported.');
    if (originalIsValid) {
      assert.equal(row.reopenedValue, original);
      assert.equal(row.reopenedBytes, row.beforeBytes);
    } else {
      generatedIdentity(row.reopenedValue);
      assert.notEqual(row.reopenedValue, row.value, 'An uncommitted generated ID must not survive a cold reopen.');
      assert.equal(text(row.reopenedBytes), row.reopenedValue);
    }
  }
  return { readSucceededBeforeOperation: access.read.succeeded, writeSucceededBeforeOperation: access.write.succeeded,
    originalAcceptedByNativeControl: originalIsValid, observation: observed };
}
