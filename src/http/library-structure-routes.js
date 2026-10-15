import { BindingError, HttpResult, booleanValue, noContent, notFound, httpError, queryValue } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { defaultLibraryOptions } from '../library/options.js';
import { parseCollectionTypeOption } from '../library/collection-type-options.js';
import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';

const text = { type: 'string', clrType: 'System.String', nullable: true };
const integer = { type: 'integer', clrType: 'System.Int32' };
const object = (reference, clrType = 'MediaBrowser.Model.Configuration.' + reference) => ({ type: 'object', reference, clrType, nullable: true });
const array = item => ({ type: 'array', item, nullable: true, clrType: item.clrType + '[]' });
const enumeration = (clrType, names) => ({ type: 'enum', clrType, values: Object.fromEntries(names.map((name, index) => [name, index])) });
const defaults = defaultLibraryOptions();
const optionFields = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name,
  typeof value === 'boolean' ? { type: 'boolean', clrType: 'System.Boolean' }
    : typeof value === 'number' ? integer : Array.isArray(value) || name.endsWith('Order') || ['MetadataSavers', 'SubtitleDownloadLanguages'].includes(name) ? array(text) : text]));
optionFields.PathInfos = array(object('MediaPathInfo'));
optionFields.TypeOptions = array(object('TypeOptions'));
optionFields.AllowEmbeddedSubtitles = enumeration('MediaBrowser.Model.Configuration.EmbeddedSubtitleOptions', ['AllowAll', 'AllowText', 'AllowImage', 'AllowNone']);
const typeArrays = ['MetadataFetchers', 'MetadataFetcherOrder', 'ImageFetchers', 'ImageFetcherOrder', 'SimilarItemProviders', 'SimilarItemProviderOrder'];
const dto = name => 'Jellyfin.Api.Models.LibraryStructureDto.' + name;
const schema = { definitions: {
  LibraryOptions: { defaults, fields: optionFields,
    required: ['PathInfos', 'SeasonZeroDisplayName', 'DisabledLocalMetadataReaders', 'DisabledSubtitleFetchers', 'SubtitleFetcherOrder',
      'DisabledMediaSegmentProviders', 'MediaSegmentProviderOrder', 'DisabledLyricFetchers', 'LyricFetcherOrder', 'CustomTagDelimiters', 'DelimiterWhitelist', 'TypeOptions'] },
  MediaPathInfo: { defaults: { Path: '' }, fields: { Path: text }, required: ['Path'] },
  TypeOptions: { defaults: { Type: null, ...Object.fromEntries(typeArrays.map(name => [name, []])), ImageOptions: [] },
    fields: { Type: text, ...Object.fromEntries(typeArrays.map(name => [name, array(text)])), ImageOptions: array(object('ImageOption')) } },
  ImageOption: { defaults: { Type: 'Primary', Limit: 1, MinWidth: 0 }, fields: { Type: enumeration('MediaBrowser.Model.Entities.ImageType',
    ['Primary', 'Art', 'Backdrop', 'Banner', 'Logo', 'Thumb', 'Disc', 'Box', 'Screenshot', 'Menu', 'Chapter', 'BoxRear', 'Profile']), Limit: integer, MinWidth: integer } },
  AddVirtualFolderDto: { defaults: { LibraryOptions: null }, fields: { LibraryOptions: object('LibraryOptions') } },
  MediaPathDto: { defaults: { Name: null, Path: null, PathInfo: null }, fields: { Name: text, Path: text, PathInfo: object('MediaPathInfo') },
    jsonRequired: ['Name'], required: ['Name'], nonEmpty: ['Name'] },
  UpdateMediaPathRequestDto: { defaults: { Name: null, PathInfo: null }, fields: { Name: text, PathInfo: object('MediaPathInfo') },
    required: ['Name', 'PathInfo'], nonEmpty: ['Name'] },
  UpdateLibraryOptionsDto: { defaults: { Id: '00000000000000000000000000000000', LibraryOptions: null },
    fields: { Id: { type: 'guid', clrType: 'System.Guid', preserveEmptyGuid: true, nullAsDefault: '00000000000000000000000000000000' }, LibraryOptions: object('LibraryOptions') } },
} };

function bindDto(name, optional = false) {
  return (body, source) => {
    if (body === null) { if (optional) return null; throw new BindingError('', 'A non-empty request body is required.'); }
    const root = object(name, dto(name));
    const result = bindJsonModel(body, { schema, root, source });
    try { return validateJsonModel(result, { schema, root }); }
    catch (error) { error.modelValidated = true; throw error; }
  };
}

const whitespace = new RegExp(`[${clrWhitespace}]`, 'u');
function nameValue(query, key, { required = false, validate = false } = {}) {
  const raw = queryValue(query, key), value = raw == null || clrTrim(raw) === '' ? null : raw;
  if (required && value == null) throw new BindingError(key, `The ${key} field is required.`);
  if (validate && value != null && (whitespace.test(value[0]) || whitespace.test(value.at(-1)) || /\n/.test(value))) {
    throw new BindingError(key, 'Library name cannot be empty or have leading/trailing spaces.');
  }
  return value;
}
function refreshValue(query) {
  const raw = queryValue(query, 'refreshLibrary');
  if (raw !== undefined && clrTrim(raw) === '') throw new BindingError('refreshLibrary', `The value '${raw}' is invalid.`);
  return booleanValue(raw, 'refreshLibrary', false);
}
function bindings(values) {
  const result = {}, errors = {};
  for (const [key, bind] of Object.entries(values)) {
    try { result[key] = bind(); }
    catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
  }
  if (Object.keys(errors).length) { const error = new BindingError('', 'Library request binding failed.'); error.errors = errors; throw error; }
  return result;
}
function pathValues(query) {
  const values = [...query].filter(([key]) => key.toLowerCase() === 'paths').map(([, value]) => value);
  return (values.length > 1 ? values : values[0]?.split(',').filter(value => value !== '') ?? []).map(clrTrim);
}

export function registerLibraryStructureRoutes(add, { libraryConfiguration }) {
  const service = () => {
    if (!libraryConfiguration) throw httpError(501, 'Library management requires persistent application paths.');
    return libraryConfiguration;
  };
  const policy = 'FirstTimeSetupOrElevated', prefix = '/Library/VirtualFolders';
  add('GET', prefix, () => service().getVirtualFolders(true), { policy });
  add('POST', prefix, async context => {
    const { name, refresh } = context.queryInput;
    const options = context.body?.LibraryOptions ?? defaultLibraryOptions(), paths = pathValues(context.query);
    if (paths.length) options.PathInfos = paths.map(Path => ({ Path }));
    await service().addVirtualFolder(name, parseCollectionTypeOption(queryValue(context.query, 'collectionType')), options, refresh);
    return noContent();
  }, { policy, body: true, optionalBody: true, bindBody: bindDto('AddVirtualFolderDto', true), bodyType: dto('AddVirtualFolderDto'),
    bindQuery: query => bindings({ name: () => nameValue(query, 'name', { required: true, validate: true }), refresh: () => refreshValue(query) }) });
  add('DELETE', prefix, async context => {
    const { name, refresh } = bindings({ name: () => nameValue(context.query, 'name', { required: true }), refresh: () => refreshValue(context.query) });
    await service().removeVirtualFolder(name, refresh); return noContent();
  }, { policy });
  add('POST', prefix + '/Name', async context => {
    const result = await service().renameVirtualFolder(nameValue(context.query, 'name'), nameValue(context.query, 'newName'), refreshValue(context.query));
    return new HttpResult(result.status, result.body);
  }, { policy });
  add('POST', prefix + '/Paths', async context => {
    await service().addMediaPathFromRequest(context.body, context.queryInput); return noContent();
  }, { policy, body: true, bindBody: bindDto('MediaPathDto'), bodyParameter: 'mediaPathDto', bodyType: dto('MediaPathDto'), bindQuery: refreshValue });
  add('POST', prefix + '/Paths/Update', async context => {
    await service().updateMediaPath(context.body.Name, context.body.PathInfo); return noContent();
  }, { policy, body: true, bindBody: bindDto('UpdateMediaPathRequestDto'), bodyParameter: 'mediaPathRequestDto', bodyType: dto('UpdateMediaPathRequestDto') });
  add('DELETE', prefix + '/Paths', async context => {
    const { name, path, refresh } = bindings({ name: () => nameValue(context.query, 'name', { required: true }),
      path: () => nameValue(context.query, 'path', { required: true }), refresh: () => refreshValue(context.query) });
    await service().removeMediaPathAndRefresh(name, path, refresh); return noContent();
  }, { policy });
  add('POST', prefix + '/LibraryOptions', async context => {
    return await service().updateLibraryOptions(context.body.Id, context.body.LibraryOptions) ? noContent() : notFound();
  }, { policy, body: true, bindBody: bindDto('UpdateLibraryOptionsDto'), bodyParameter: 'request', bodyType: dto('UpdateLibraryOptionsDto') });
}
