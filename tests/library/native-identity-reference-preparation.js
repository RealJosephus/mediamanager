import assert from 'node:assert/strict';
import { verifyNativeReferencePreparationContract } from './native-reference-preparation.js';
import { nativeIdentityReference, resolveNativeIdentityInput } from './native-identity-inputs.js';

export function verifyNativeReferencePreparation(options) {
  assert.equal(options.profile, 'http-filter');
  return verifyNativeReferencePreparationContract({ ...options,
    inputPaths: nativeIdentityReference.preparationInputs,
    resolveInput: (profile, filename) => {
      assert.equal(profile, 'http-filter');
      return resolveNativeIdentityInput(filename);
    } });
}
