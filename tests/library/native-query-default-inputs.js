import { readFile } from 'node:fs/promises';
import { createNativeQueryInputs } from './native-query-inputs.js';

// Only consumers of this recorded profile import its binding. Factory and
// explicit-profile consumers must not acquire these historical dependencies.
// Missing original inputs remain failures; no current profile substitutes them.
const binding = JSON.parse(await readFile(new URL('./fixtures/native-query-inputs/binding.json', import.meta.url), 'utf8'));
export const nativeQueryInputs = createNativeQueryInputs({ ...binding, expectedChangedReferences: [
  { table: 'ActivityLogs', column: 'UserId', count: 4 },
  { table: 'Devices', column: 'UserId', count: 1 },
  { table: 'Permissions', column: 'UserId', count: 24 },
  { table: 'Preferences', column: 'UserId', count: 13 },
  { table: 'Users', column: 'Id', count: 1 },
] });
export const nativeQueryReference = nativeQueryInputs.reference;
export const nativeItemFilterRecordedOutputRoot = nativeQueryInputs.recordedOutputRoot;
export const nativeQueryExecutables = nativeQueryInputs.executables;
export const readNativeQueryServerId = nativeQueryInputs.readServerId;
export const verifyNativeQuerySourceBindings = nativeQueryInputs.verifySourceBindings;
export const resolveNativeQueryInput = nativeQueryInputs.resolveInput;
export const readNativeQueryRecorderSource = nativeQueryInputs.readRecorderSource;
