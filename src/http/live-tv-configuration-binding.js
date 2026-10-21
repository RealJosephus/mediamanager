import model from '../core/resources/live-tv-configuration-model.json' with { type: 'json' };
import { httpError } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';

function rule(type) {
  const nullable = ['string', 'object', 'array'].includes(type.kind) || type.nullable === true;
  if (type.kind === 'object') return { type: 'object', reference: type.reference,
    clrType: (type.reference === 'NameValuePair' ? 'MediaBrowser.Model.Dto.' : 'MediaBrowser.Model.LiveTv.') + type.reference, nullable };
  if (type.kind === 'array') return { type: 'array', clrType: 'System.Array', nullable, item: rule(type.item) };
  const clrType = { string: 'System.String', integer: 'System.Int32', boolean: 'System.Boolean' }[type.kind];
  if (!clrType) throw new TypeError('Unsupported Live TV configuration property.');
  return { type: type.kind, clrType, nullable };
}
const schema = { definitions: Object.fromEntries(Object.entries(model.definitions).map(([name, definition]) =>
  [name, { defaults: definition.defaults, fields: Object.fromEntries(Object.entries(definition.fields).map(([name, field]) => [name, rule(field.type)])) }])) };
const root = rule(model.roots.livetv.type);

// MVC binds a JsonDocument before the action performs its own typed decode.
// Valid JSON scalars and arrays reach the action; malformed JSON does not.
export function bindLiveTvConfigurationDocument(body, source) {
  return { source };
}

export function deserializeLiveTvConfiguration({ source }) {
  let configuration;
  try { configuration = bindJsonModel(undefined, { schema, root, source, caseInsensitiveProperties: false }); }
  catch (cause) {
    // These are action exceptions, not MVC model validation failures.
    throw new Error('The Live TV configuration could not be deserialized.', { cause });
  }
  if (configuration === null) throw httpError(400, "Body doesn't contain a valid configuration");
  return configuration;
}
