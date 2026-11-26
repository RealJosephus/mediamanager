import model from '../core/configuration-model.js';
import { defaultConfiguration, parseConfigurationVersion } from '../core/configuration-xml.js';
import { BindingError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';

const namespaces = { NameValuePair: 'Dto', RepositoryInfo: 'Updates', CastReceiverApplication: 'System', ImageResolution: 'Drawing' };
const objectType = name => `MediaBrowser.Model.${namespaces[name] ?? 'Configuration'}.${name}`;
const required = {
  ServerConfigurationDto: ['MetadataPath', 'PreferredMetadataLanguage', 'MetadataCountryCode', 'SortReplaceCharacters',
    'SortRemoveCharacters', 'SortRemoveWords', 'MetadataOptions', 'ServerName', 'UICulture', 'ContentTypes',
    'CodecsUsed', 'PluginRepositories', 'PathSubstitutions', 'CorsHosts', 'CastReceiverApplications', 'TrickplayOptions'],
  PathSubstitution: ['From', 'To'], CastReceiverApplication: ['Id', 'Name'], TrickplayOptions: ['WidthResolutions'],
};

function rule(type) {
  const nullable = ['string', 'object', 'array'].includes(type.kind) || type.nullable === true;
  if (type.kind === 'object') return { type: 'object', reference: type.reference, clrType: objectType(type.reference), nullable };
  if (type.kind === 'array') {
    const item = rule(type.item);
    return { type: 'array', clrType: item.clrType + '[]', nullable, item };
  }
  if (type.kind === 'enum') return { type: 'enum', clrType: type.name === 'ProcessPriorityClass'
    ? 'System.Diagnostics.ProcessPriorityClass' : objectType(type.name), nullable,
  values: Object.fromEntries(type.members.map(member => [member.name, member.value])) };
  const scalar = type.kind === 'integer' ? type.bits === 64 ? 'long' : 'integer' : type.kind;
  const clrType = { string: 'System.String', boolean: 'System.Boolean', integer: 'System.Int32', long: 'System.Int64' }[scalar];
  if (!clrType) throw new TypeError('Unsupported server configuration property.');
  return { type: scalar, clrType, nullable };
}

const definitionNames = new Set(['MetadataOptions', 'NameValuePair', 'RepositoryInfo',
  'PathSubstitution', 'CastReceiverApplication', 'TrickplayOptions']);
const definitions = Object.fromEntries(Object.entries(model.definitions).filter(([name]) => definitionNames.has(name)).map(([name, definition]) => [name, {
  defaults: definition.defaults, fields: Object.fromEntries(Object.entries(definition.fields).map(([name, field]) => [name, rule(field.type)])),
  required: required[name] ?? [], ...(name === 'CastReceiverApplication' ? { jsonRequired: ['Id', 'Name'] } : {}),
}]));
// ConfigurationJsonTypeInfoModifier seeds the public DTO from a fresh internal
// configuration. bindJsonModel clones these defaults for each request.
const server = model.definitions.ServerConfiguration;
export const serverConfigurationFields = server.order.filter(name => name !== 'EnableObsoleteEndpoints');
const fields = Object.fromEntries(serverConfigurationFields.map(name => [name, rule(server.fields[name].type)]));
definitions.ServerConfigurationDto = {
  fields, defaults: serverConfigurationDto(defaultConfiguration('server')),
  required: required.ServerConfigurationDto,
};
const schema = { definitions };
const root = { type: 'object', reference: 'ServerConfigurationDto', clrType: objectType('ServerConfigurationDto'), nullable: true };

export function bindServerConfiguration(body, source) {
  const value = bindJsonModel(body, { schema, root, source });
  if (value === null) throw new BindingError('', 'A non-empty request body is required.');
  validateJsonModel(value, { schema, root });
  const previousVersion = parseConfigurationVersion(value.PreviousVersionStr);
  return { ...defaultConfiguration('server'), ...value, PreviousVersion: previousVersion, PreviousVersionStr: previousVersion };
}

export function serverConfigurationDto(configuration) {
  const defaults = defaultConfiguration('server');
  const result = Object.fromEntries(serverConfigurationFields.map(name => [name,
    Object.hasOwn(configuration, name) ? configuration[name] : defaults[name]]));
  result.PreviousVersionStr = parseConfigurationVersion(Object.hasOwn(configuration, 'PreviousVersion')
    ? configuration.PreviousVersion : result.PreviousVersionStr);
  return result;
}

export const defaultMetadataOptions = () => structuredClone(model.definitions.MetadataOptions.defaults);
