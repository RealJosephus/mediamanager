import model from '../core/resources/configuration-model.json' with { type: 'json' };
import { defaultConfiguration, parseConfigurationVersion } from '../core/configuration-xml.js';
import { BindingError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';

const namespaces = { NameValuePair: 'Dto', RepositoryInfo: 'Updates', CastReceiverApplication: 'System', ImageResolution: 'Drawing' };
const objectType = name => `MediaBrowser.Model.${namespaces[name] ?? 'Configuration'}.${name}`;
const required = {
  ServerConfiguration: ['MetadataPath', 'PreferredMetadataLanguage', 'MetadataCountryCode', 'SortReplaceCharacters',
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

function readVersion(value, { failure }) {
  if (typeof value !== 'string') return failure();
  const parsed = parseConfigurationVersion(value);
  if (parsed !== null) return parsed;
  const parts = value.split('.');
  const invalidVersion = () => Object.assign(new Error('Invalid version text.'), { status: 400, code: 'invalid-version' });
  if (parts.length < 2 || parts.length > 4) throw invalidVersion();
  const numbers = parts.map(part => /^[ \t\n\v\f\r]*[+-]?\d+[ \t\n\v\f\r]*$/u.test(part) ? Number(part) : NaN);
  if (numbers.every(number => Number.isInteger(number) && number >= -2147483648 && number <= 2147483647)
    && numbers.some(number => number < 0)) {
    throw invalidVersion();
  }
  throw new BindingError('', 'The supplied value is invalid.');
}

const definitionNames = new Set(['ServerConfiguration', 'MetadataOptions', 'NameValuePair', 'RepositoryInfo',
  'PathSubstitution', 'CastReceiverApplication', 'TrickplayOptions']);
const definitions = Object.fromEntries(Object.entries(model.definitions).filter(([name]) => definitionNames.has(name)).map(([name, definition]) => [name, {
  defaults: definition.defaults, fields: Object.fromEntries(Object.entries(definition.fields).map(([name, field]) => [name, rule(field.type)])),
  required: required[name] ?? [], ...(name === 'CastReceiverApplication' ? { jsonRequired: ['Id', 'Name'] } : {}),
}]));
definitions.ServerConfiguration.fields.PreviousVersion = { type: 'version', clrType: 'System.Version', nullable: true, read: readVersion };
definitions.ServerConfiguration.assign = (result, name, value) => {
  if (name === 'PreviousVersionStr') {
    const parsed = parseConfigurationVersion(value);
    if (parsed !== null) result.PreviousVersion = result.PreviousVersionStr = parsed;
  } else {
    result[name] = value;
    if (name === 'PreviousVersion') result.PreviousVersionStr = value;
  }
};
const root = { type: 'object', reference: 'ServerConfiguration', clrType: objectType('ServerConfiguration'), nullable: true };
export const serverConfigurationFields = [...Object.keys(model.definitions.ServerConfiguration.fields), 'PreviousVersion'];

export function bindServerConfiguration(body, source) {
  const schema = { definitions: { ...definitions, ServerConfiguration: {
    ...definitions.ServerConfiguration, defaults: defaultConfiguration('server'),
  } } };
  const value = bindJsonModel(body, { schema, root, source });
  if (value === null) throw new BindingError('', 'A non-empty request body is required.');
  return validateJsonModel(value, { schema, root });
}

export function serverConfigurationDto(configuration) {
  const defaults = defaultConfiguration('server');
  const result = Object.fromEntries(serverConfigurationFields.map(name => [name,
    Object.hasOwn(configuration, name) ? configuration[name] : defaults[name]]));
  const version = parseConfigurationVersion(Object.hasOwn(configuration, 'PreviousVersion')
    ? configuration.PreviousVersion : configuration.PreviousVersionStr);
  result.PreviousVersion = result.PreviousVersionStr = version;
  return result;
}

export const defaultMetadataOptions = () => structuredClone(model.definitions.MetadataOptions.defaults);
