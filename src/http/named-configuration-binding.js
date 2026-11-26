import model from '../core/resources/configuration-model.json' with { type: 'json' };
import { namedConfigurationRoots } from '../core/named-configuration-store.js';
import { BindingError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { networkConfigurationBaseUrl } from '../core/network-configuration.js';

const configurationType = name => (name === 'NetworkConfiguration' ? 'MediaBrowser.Common.Net.' : 'MediaBrowser.Model.Configuration.') + name + 'Dto';
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
const required = {
  NetworkConfiguration: ['BaseUrl', 'LocalNetworkSubnets', 'LocalNetworkAddresses', 'KnownProxies', 'VirtualInterfaceNames',
    'PublishedServerUriBySubnet', 'RemoteIPFilter'],
  XbmcMetadataOptions: ['ReleaseDateFormat'],
};
const schema = { definitions: Object.fromEntries(namedConfigurationRoots.map(key => model.roots[key].type.reference).map(name => [name, {
  defaults: model.definitions[name].defaults,
  fields: Object.fromEntries(Object.entries(model.definitions[name].fields).map(([name, field]) => [name, rule(field.type)])),
  required: required[name],
}])) };

export function namedConfigurationDto(key, value) {
  const fields = schema.definitions[model.roots[key].type.reference].fields;
  return Object.fromEntries(Object.keys(fields).map(name => [name, value[name]]));
}

export function namedConfigurationBody(key) {
  const root = rule(model.roots[key].type);
  return { body: true, bodyType: root.clrType, bodyParameter: 'configuration', bindBody(body, source) {
    const dto = bindJsonModel(body, { root, schema, source });
    if (dto === null) throw new BindingError('', 'A non-empty request body is required.');
    validateJsonModel(dto, { schema, root });
    return key === 'network' ? networkConfigurationBaseUrl(dto) : dto;
  } };
}
