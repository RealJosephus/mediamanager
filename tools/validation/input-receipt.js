import { createHash } from 'node:crypto';

export const currentInputSchemaVersion = 3;

const hash = value => createHash('sha256').update(value).digest('hex');
const receiptFields = new Set(['schemaVersion', 'scope', 'entries', 'services', 'tools', 'systemFonts',
  'preflightReady', 'currentReleaseInputReady', 'entriesSha256', 'historicalArchiveComplete', 'historicalArchive']);
const digestPattern = /^[a-f0-9]{64}$/iu;

function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.required !== true || typeof entry.available !== 'boolean') return false;
  const hasExpected = Object.hasOwn(entry, 'expectedDigests');
  if (hasExpected !== Object.hasOwn(entry, 'expectedDigestMatched')) return false;
  if (Object.hasOwn(entry, 'invalidExpectedDigest') && entry.invalidExpectedDigest !== true) return false;
  if (!hasExpected) return !Object.hasOwn(entry, 'invalidExpectedDigest');
  if (!Array.isArray(entry.expectedDigests) || !entry.expectedDigests.every(value => digestPattern.test(value))) return false;
  const actual = entry.sha256 ?? entry.entriesSha256;
  const matched = entry.invalidExpectedDigest !== true
    && entry.expectedDigests.every(value => value === actual);
  return entry.expectedDigestMatched === matched;
}

export function currentEntriesReady(entries, preflightReady) {
  return preflightReady === true && Array.isArray(entries) && entries.length > 0 && entries.every(entry => validEntry(entry)
    && entry.available === true && entry.invalidExpectedDigest !== true && entry.expectedDigestMatched !== false);
}

export function currentInputProjection(receipt) {
  if (receipt?.schemaVersion !== currentInputSchemaVersion || !Array.isArray(receipt.entries) || !receipt.entries.length
    || !Array.isArray(receipt.services) || !Array.isArray(receipt.tools)
    || typeof receipt.preflightReady !== 'boolean' || typeof receipt.currentReleaseInputReady !== 'boolean'
    || Object.keys(receipt).some(name => !receiptFields.has(name))
    || !receipt.entries.every(validEntry)) return null;
  const ready = currentEntriesReady(receipt.entries, receipt.preflightReady);
  if (receipt.currentReleaseInputReady !== ready) return null;
  return { entries: receipt.entries, services: receipt.services, tools: receipt.tools,
    ...(Object.hasOwn(receipt, 'systemFonts') ? { systemFonts: receipt.systemFonts } : {}),
    preflightReady: receipt.preflightReady, currentReleaseInputReady: receipt.currentReleaseInputReady };
}

export function currentInputDigest(receipt) {
  const projection = currentInputProjection(receipt);
  return projection ? hash(JSON.stringify(projection)) : null;
}

export function validCurrentInputReceipt(receipt) {
  return /^[a-f0-9]{64}$/u.test(receipt?.entriesSha256 ?? '')
    && currentInputDigest(receipt) === receipt.entriesSha256;
}
