import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dvdReferenceInputs } from '../../tools/validation/dvd-reference-inputs.js';
import { createDvdScanExchange } from './dvd-scan-exchange-scenario.js';

export const requiredValidationServices = ['dvdReference', 'dotnet', 'jellyfinDll', 'nativeInstance', 'postgres'];
const enabled = Boolean(process.env.MEDIAMANAGER_TEST_DVD_REFERENCE && process.env.MEDIAMANAGER_TEST_NATIVE_INSTANCE
  && process.env.MEDIAMANAGER_JELLYFIN_DLL && process.env.MEDIAMANAGER_TEST_POSTGRES);

const run = createDvdScanExchange({ enabled, original: true, movieName: 'Big Buck Bunny (2008)', async prepareInput({ root, report }) {
  const supply = await dvdReferenceInputs();
  report.original = { receipt: supply.receipt, manifest: supply.manifest };
  const refusal = path.join(root, 'empty-disc-refusal'), falseRoot = path.join(refusal, 'mediamanager-disc-reference');
  await mkdir(falseRoot, { recursive: true });
  await cp(supply.evidence, path.join(falseRoot, 'evidence'), { recursive: true, force: false, errorOnExist: true });
  await mkdir(path.join(falseRoot, 'media'));
  const falseReceipt = path.join(falseRoot, 'evidence', 'receipt.json');
  await writeFile(falseReceipt, JSON.stringify({ ...supply.receipt, mediaRoot: path.join(falseRoot, 'media') }) + '\n');
  await assert.rejects(dvdReferenceInputs({ ...process.env, RUNNER_TEMP: refusal, MEDIAMANAGER_TEST_DVD_REFERENCE: falseReceipt }),
    error => Array.isArray(error.actual) && error.actual.length === 0
      && JSON.stringify(error.expected) === JSON.stringify(supply.manifest));
  report.emptyPayloadRejected = true;
  return { ...supply, async verifyInputs() { assert.deepEqual((await dvdReferenceInputs()).inputs, supply.inputs); } };
} });

test('the complete original DVD survives actual Native and Node VFS probing, fresh scans, SQLite continuation and cold PostgreSQL', {
  skip: !enabled, timeout: 900000,
}, run);
