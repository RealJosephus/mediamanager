import test from 'node:test';
import { createBlurayScanExchange } from './bluray-scan-exchange-scenario.js';
import { prepareBlurayInput } from './fixtures/real-bluray-current/input.js';

export const requiredValidationServices = ['dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const original = process.env.MEDIAMANAGER_CI_BLURAY_REFERENCE === 'true';
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE && process.env.MEDIAMANAGER_JELLYFIN_DLL
  && process.env.MEDIAMANAGER_TEST_POSTGRES);

const run = createBlurayScanExchange({ enabled, original, movieName: original ? 'Sintel (2010)' : 'Compact Blu-ray (2010)',
  prepareInput: ({ root, signal }) => prepareBlurayInput({ root, signal, original }) });
const label = original ? 'the complete original Blu-ray' : 'the compact BDMV fixture';
test(`${label} survives actual Native and Node VFS probing, fresh scans, SQLite continuation and cold PostgreSQL`, {
  skip: !enabled, timeout: 900000,
}, run);
