import model from '../core/resources/configuration-model.json' with { type: 'json' };
import { defaultConfiguration } from '../core/configuration-xml.js';
import { namedConfigurationRoot } from '../core/named-configuration-store.js';
import { httpError } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { networkConfigurationBaseUrl } from '../core/network-configuration.js';

const configurationType = name => name === 'NetworkConfiguration' ? name : 'MediaBrowser.Model.Configuration.' + name;
function rule(type) {
  const nullable = ['string', 'object', 'array'].includes(type.kind) || type.nullable === true;
  if (type.kind === 'object') return { type: 'object', reference: type.reference, clrType: configurationType(type.reference), nullable };
  if (type.kind === 'array') {
    const item = rule(type.item);
    return { type: 'array', clrType: item.clrType + '[]', nullable, item };
  }
  if (type.kind === 'enum') return { type: 'enum', nullable,
    clrType: 'MediaBrowser.Model.' + (type.name === 'HlsAudioSeekStrategy' ? 'Configuration.' : 'Entities.') + type.name,
    values: Object.fromEntries(type.members.map(member => [member.name, member.value])) };
  const kind = type.kind === 'number' ? type.single ? 'float' : 'double' : type.kind;
  const clrType = { string: 'System.String', boolean: 'System.Boolean', integer: 'System.Int32', double: 'System.Double', float: 'System.Single' }[kind];
  if (!clrType) throw new TypeError('Unsupported named configuration field.');
  return { type: kind, clrType, nullable };
}
const schema = { definitions: Object.fromEntries(['EncodingOptions', 'MetadataConfiguration', 'XbmcMetadataOptions', 'NetworkConfiguration'].map(name => [name, {
  defaults: model.definitions[name].defaults,
  fields: Object.fromEntries(Object.entries(model.definitions[name].fields).map(([name, field]) => [name, rule(field.type)])),
  ...(name === 'NetworkConfiguration' && { assign(result, name, value) { networkConfigurationBaseUrl(result); result[name] = value; } }),
}])) };

// MVC owns the JsonDocument syntax boundary. The action decodes its contents
// with JsonDefaults rather than typed MVC reference validation.
export function bindNamedConfigurationDocument(_body, source) { return { source }; }

export function deserializeNamedConfiguration(key, { source }) {
  const name = namedConfigurationRoot(key);
  if (!name) throw Object.assign(new Error('No configuration factory is registered for ' + key + '.'), { code: 'configuration-factory-not-found' });
  const type = model.roots[name].type.reference;
  let value;
  try {
    value = bindJsonModel(undefined, { source, caseInsensitiveProperties: false,
      root: { ...rule(model.roots[name].type), nullable: true },
      schema: { definitions: { ...schema.definitions, [type]: { ...schema.definitions[type], defaults: defaultConfiguration(name) } } } });
  } catch (cause) { throw new Error('The named configuration could not be deserialized.', { cause }); }
  if (value === null) throw httpError(400, "Body doesn't contain a valid configuration");
  if (name === 'network') networkConfigurationBaseUrl(value);
  return value;
}
