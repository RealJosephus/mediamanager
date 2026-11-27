import model from '../core/resources/live-tv-configuration-model.json' with { type: 'json' };
import { BindingError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';

function rule(type) {
  const nullable = ['string', 'object', 'array'].includes(type.kind) || type.nullable === true;
  if (type.kind === 'object') return { type: 'object', reference: type.reference,
    clrType: (type.reference === 'NameValuePair' ? 'MediaBrowser.Model.Dto.' : 'MediaBrowser.Model.LiveTv.') + type.reference, nullable };
  if (type.kind === 'array') {
    const item = rule(type.item);
    return { type: 'array', clrType: item.clrType + '[]', nullable, item };
  }
  const clrType = { string: 'System.String', integer: 'System.Int32', boolean: 'System.Boolean' }[type.kind];
  if (!clrType) throw new TypeError('Unsupported Live TV configuration property.');
  return { type: type.kind, clrType, nullable };
}
const schema = { definitions: Object.fromEntries(Object.entries(model.definitions).map(([name, definition]) =>
  [name, { defaults: definition.defaults, fields: Object.fromEntries(Object.entries(definition.fields).map(([name, field]) => [name, rule(field.type)])) }])) };
const root = rule(model.roots.livetv.type);
root.clrType += 'Dto';
schema.definitions.LiveTvOptions.required = ['TunerHosts', 'ListingProviders', 'MediaLocationsCreated', 'RecordingPostProcessorArguments'];

export function bindLiveTvConfiguration(body, source) {
  const configuration = bindJsonModel(body, { schema, root, source });
  if (configuration === null) throw new BindingError('', 'A non-empty request body is required.');
  validateJsonModel(configuration, { schema, root });
  return configuration;
}
