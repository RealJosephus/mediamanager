import { tokenizeJson } from '../../src/core/json-tokens.js';
import { nativeItemJsonContract, nativeItemJsonValidationManifest } from '../../src/library/native-item-data.js';
import { dateText } from '../../src/library/records.js';

const manifest = nativeItemJsonValidationManifest();
const baseContract = nativeItemJsonContract('MediaBrowser.Controller.Entities.Folder').filter(field => field.name !== 'IsRoot');
const pathFields = new Set(['ShortcutPath', 'AdditionalParts', 'LocalAlternateVersions', 'SubtitleFiles', 'AudioFiles',
  'LyricFiles', 'PhysicalLocationsList']);
const nestedContract = kind => kind === 'entity' ? baseContract : manifest.nested[kind]
  && Object.entries(manifest.nested[kind]).map(([name, field]) => ({ name, ...field }));
const unsupported = Symbol('unprojected typed token');

/** Compare only newly saved typed Data through its existing reader contract.
 * Existing TEXT and invalid documents remain literal. Unknown occurrences keep
 * their complete property spans, ancestry and relative order independently of
 * the last-known-property value. The projection reads lossless source tokens,
 * never a candidate entity decoder or its constructor defaults. No application
 * clock is erased. */
export function projectPersistedItemData(text, type, {
  created = false, path = value => value, identity = value => value,
} = {}) {
  if (!created || typeof text !== 'string' || !Object.hasOwn(manifest.contracts, type)) return text;
  let root;
  try {
    JSON.parse(text); root = tokenizeJson(text);
    if (!root.properties) return text;
  } catch { return text; }

  const unknown = [];
  const projectObject = (node, contract, role, ancestry = []) => {
    if (!node?.properties) throw unsupported;
    const fields = new Map(contract.map(field => [field.name, field])), occurrences = new Map(), values = new Map();
    for (const [name, child, span] of node.properties) {
      const occurrence = occurrences.get(name) ?? 0; occurrences.set(name, occurrence + 1);
      const location = [...ancestry, { field: name, occurrence }], field = fields.get(name);
      if (!field) {
        unknown.push({ path: location, raw: text.slice(span.start, child.end) });
        continue;
      }
      values.set(name, project(child, field, role, location));
    }
    return Object.fromEntries(contract.filter(field => values.has(field.name)).map(field => [field.name, values.get(field.name)]));
  };
  const project = (node, field, role, ancestry) => {
    const value = node.value;
    if (value === null) {
      if (field.nullable || field.kind === 'string' || field.kind.endsWith('[]')) return null;
      throw unsupported;
    }
    const kind = field.kind.replace(/\[\]$/u, '');
    if (field.kind.endsWith('[]')) {
      if (!node.items) throw unsupported;
      return node.items.map((entry, index) => project(entry, { ...field, kind }, role, [...ancestry, index]));
    }
    const context = { kind: role, field: field.name };
    const nested = nestedContract(kind);
    if (nested) return projectObject(node, nested, kind, ancestry);
    if (kind === 'string') {
      // JsonStringConverter reads scalar number spellings literally; using
      // Number(value).toString() here would destroy that business value.
      if (node.properties || node.items) throw unsupported;
      const source = typeof value === 'string' ? value : text.slice(node.start, node.end);
      return pathFields.has(field.name) || role === 'LinkedChild' && field.name === 'Path' ? path(source, context) : source;
    }
    if (kind === 'guid') {
      if (typeof value !== 'string') throw unsupported;
      return identity(value, context);
    }
    if (kind === 'date') {
      // UTC text may differ in fractional padding without changing any tick.
      // Preserve other DateTime spellings literally; their kind/offset can
      // affect a later persisted write.
      if (typeof value !== 'string') throw unsupported;
      try { return value.endsWith('Z') ? dateText(value) : value; }
      catch { throw unsupported; }
    }
    if (kind === 'bool') {
      if (typeof value !== 'boolean') throw unsupported;
      return value;
    }
    if (kind === 'int' || kind === 'long') {
      // JsonDefaults.Options permits quoted numbers. Canonical decimal integer
      // tokens stay exact through Int64 boundaries, independently of Number.
      const source = typeof value === 'string' ? value : text.slice(node.start, node.end);
      if (!/^-?(?:0|[1-9]\d*)$/u.test(source)) throw unsupported;
      const integer = BigInt(source), bound = kind === 'int' ? 2147483648n : 9223372036854775808n;
      if (integer < -bound || integer >= bound) throw unsupported;
      return kind === 'int' ? Number(integer) : integer;
    }
    if (kind === 'double' || kind === 'single') {
      const source = typeof value === 'string' ? value : text.slice(node.start, node.end);
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(source)) throw unsupported;
      const number = kind === 'single' ? Math.fround(Number(source)) : Number(source);
      if (!Number.isFinite(number)) throw unsupported;
      return number;
    }
    // Current serializers use declared enum names. Preserve other enum tokens
    // literally; this helper does not invent flag/default converter behavior.
    if (Object.hasOwn(manifest.enums, kind)) {
      if (!['string', 'number'].includes(typeof value)) throw unsupported;
      return value;
    }
    throw unsupported;
  };
  try { return { value: projectObject(root, nativeItemJsonContract(type), type), unknown }; }
  catch (reason) { if (reason !== unsupported) throw reason; return text; }
}
