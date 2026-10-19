import { model } from './codecs.js';

function typed(value, type) {
  if (value == null) return value;
  if (type.kind === 'number' && typeof value === 'bigint') return Number(value);
  if (type.kind === 'number' && typeof value === 'string') {
    return { NaN, Infinity, '-Infinity': -Infinity }[value] ?? value;
  }
  if (type.kind === 'array') return value.map(entry => typed(entry, type.item));
  if (type.kind === 'object') {
    const fields = model.definitions[type.reference].fields;
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, fields[name] ? typed(entry, fields[name].type) : entry]));
  }
  return value;
}

export const configurationValue = (value, root) => typed(value, model.roots[root].type);
export const configurationObservation = row => ({ name: row.name, root: row.root, accepted: row.accepted,
  value: configurationValue(row.value, row.root), beforeBytes: row.beforeBytes, afterBytes: row.afterBytes,
  reread: configurationValue(row.reread, row.root), afterDirectory: row.afterDirectory });

export const configurationJson = value => JSON.stringify(value, (_, entry) => typeof entry === 'bigint' ? JSON.rawJSON(entry.toString())
  : typeof entry === 'number' && !Number.isFinite(entry) ? String(entry) : entry, 2) + '\n';
