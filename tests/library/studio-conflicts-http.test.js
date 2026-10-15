import test from 'node:test';
import { recordNativeConflictCandidate } from './native-conflict-scenario.js';

const dialects = process.env.MEDIAMANAGER_STUDIO_CONFLICT_DIALECT
  ? [process.env.MEDIAMANAGER_STUDIO_CONFLICT_DIALECT] : ['postgres'];
if (dialects.some(dialect => dialect !== 'postgres')) throw new Error('Invalid Studio conflict dialect.');

test('postgres: Studio name/path conflicts and wrong-type primary key match frozen GET', {
  skip: !process.env.MEDIAMANAGER_TEST_POSTGRES,
}, async () => {
  await recordNativeConflictCandidate('studio', process.env.MEDIAMANAGER_TEST_POSTGRES);
});
