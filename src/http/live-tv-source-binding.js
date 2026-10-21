import model from '../core/resources/live-tv-configuration-model.json' with { type: 'json' };
import { BindingError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';

function rule(type) {
  const nullable = ['string', 'object', 'array'].includes(type.kind) || type.nullable === true;
  if (type.kind === 'object') return { type: 'object', reference: type.reference, nullable,
    clrType: (type.reference === 'NameValuePair' ? 'MediaBrowser.Model.Dto.' : 'MediaBrowser.Model.LiveTv.') + type.reference };
  if (type.kind === 'array') return { type: 'array', clrType: 'System.Array', nullable, item: rule(type.item) };
  return { type: type.kind, nullable, clrType: { string: 'System.String', integer: 'System.Int32', boolean: 'System.Boolean' }[type.kind] };
}
const schema = { definitions: Object.fromEntries(Object.entries(model.definitions).map(([name, definition]) => [name, {
  defaults: definition.defaults, fields: Object.fromEntries(Object.entries(definition.fields).map(([name, field]) => [name, rule(field.type)])),
}])) };
const mappingFields = ['ProviderId', 'TunerChannelId', 'ProviderChannelId'];
schema.definitions.SetChannelMappingDto = { defaults: Object.fromEntries(mappingFields.map(name => [name, ''])),
  fields: Object.fromEntries(mappingFields.map(name => [name, { type: 'string', clrType: 'System.String', nullable: true }])),
  required: mappingFields, nonEmpty: mappingFields };

function bind(name, parameter, clrType) {
  const root = { type: 'object', reference: name, nullable: true, clrType };
  return (body, source) => {
    const value = bindJsonModel(body, { schema, root, source });
    if (value === null) throw new BindingError(parameter, `The ${parameter} field is required.`);
    return validateJsonModel(value, { schema, root });
  };
}

export const bindTunerHostInfo = bind('TunerHostInfo', 'tunerHostInfo', 'MediaBrowser.Model.LiveTv.TunerHostInfo');
export const bindListingsProviderInfo = bind('ListingsProviderInfo', 'listingsProviderInfo', 'MediaBrowser.Model.LiveTv.ListingsProviderInfo');
export const bindSetChannelMapping = bind('SetChannelMappingDto', 'dto', 'Jellyfin.Api.Models.LiveTvDtos.SetChannelMappingDto');
