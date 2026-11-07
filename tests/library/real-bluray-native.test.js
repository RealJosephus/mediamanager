import test from 'node:test';
import assert from 'node:assert/strict';
import { blurayReferenceInputs } from '../../tools/validation/bluray-reference-inputs.js';
import { createBlurayScanExchange } from './bluray-scan-exchange-scenario.js';

export const requiredValidationServices = ['blurayReference', 'dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_BLURAY_REFERENCE && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES);

const run = createBlurayScanExchange({ enabled, original: true, movieName: 'Sintel (2010)', async prepareInput() {
  const supply = await blurayReferenceInputs();
  return { ...supply, async verifyInputs() { assert.deepEqual((await blurayReferenceInputs()).inputs, supply.inputs); } };
} });

test('the complete original Blu-ray survives actual Native and Node VFS probing, fresh scans, SQLite continuation and cold PostgreSQL', {
  skip: !enabled, timeout: 900000,
}, run);
