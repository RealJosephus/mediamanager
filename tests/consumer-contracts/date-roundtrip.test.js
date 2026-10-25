import test from 'node:test';
import assert from 'node:assert/strict';
import { currentDateRoundtrip } from './current-date-roundtrip.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_TEST_POSTGRES
  && process.env.MEDIAMANAGER_DOTNET && process.env.MEDIAMANAGER_JELLYFIN_DLL);

for (const name of ['utc', 'taipei', 'shanghai']) test(`current Native HTTP, 100ns PostgreSQL dates, Native continuation and fresh reimport: ${name}`,
  { skip: !enabled, timeout: 720000 }, async () => {
    const { input, exchange } = await currentDateRoundtrip();
    const branch = exchange.zones.find(zone => zone.name === name);
    assert.equal(exchange.passed, true); assert.equal(branch.passed, true);
    assert.equal(branch.nodeImportedReads.length, input.cases.length);
    assert.equal(branch.nodeWrites.length, input.cases.length);
    assert.equal(branch.nodeColdReads.length, input.cases.length);
    assert.equal(branch.nativeImportedReads.length, input.cases.length);
    assert.equal(branch.nativeContinued.length, input.cases.length);
    assert.equal(branch.freshNodeReads.length, input.cases.length);
    assert.deepEqual(branch.nodeColdReads, branch.nodeWrites);
    assert.deepEqual(branch.nativeImportedReads, branch.nodeWrites);
    assert.deepEqual(branch.freshNodeReads, branch.nativeContinued);
    assert.deepEqual(branch.postgresRows, branch.sqliteRows);
    assert.deepEqual(branch.nativeReturnedRows, branch.freshPostgresRows);
    assert.deepEqual(exchange.errors, []);
    assert.equal(exchange.fullInstanceVerified, false); assert.equal(exchange.completeLibraryVerified, false);
    assert.equal(exchange.phaseAcceptance, false); assert.equal(exchange.releaseAcceptance, false);
  });
