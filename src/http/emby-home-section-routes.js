import { BindingError, booleanValue, guidValue, noContent, queryValue } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { embyTextResponse } from './client-protocol.js';
import { changeHomeSections, getHomeSections, saveHomeSection } from '../users/emby-home-sections.js';

const string = { type: 'string', nullable: true, clrType: 'System.String' };
const boolean = { type: 'boolean', nullable: true, allowString: true, clrType: 'System.Boolean' };
const integer = { type: 'integer', nullable: false, clrType: 'System.Int32' };
const strings = { type: 'array', nullable: true, clrType: 'System.String[]', item: string };
const enumeration = values => ({ type: 'enum', nullable: true, clrType: 'System.Int32', values: Object.fromEntries(values.map((name, index) => [name, index])) });
const queryFields = Object.fromEntries(['StudioIds', 'TagIds', 'GenreIds', 'CollectionTypes'].map(key => [key, strings]));
for (const key of ['IsFavorite', 'IsPlayed', 'IsMovie', 'IsSeries', 'IsSports', 'IsNews', 'IsRepeat', 'IsResumable']) queryFields[key] = boolean;
const sectionFields = Object.fromEntries(['Id', 'UserId', 'Name', 'CustomName', 'Subtitle', 'SectionType', 'CollectionType', 'DisplayMode',
  'ViewType', 'ImageType', 'ParentId', 'SortBy', 'SortOrder', 'PremiumFeature', 'PremiumMessage'].map(key => [key, string]));
Object.assign(sectionFields, { ItemTypes: strings, ExcludedFolders: strings, Monitor: strings, CardSizeOffset: integer,
  RefreshInterval: { ...integer, nullable: true }, IncludeNextUpInResume: { ...boolean, nullable: false },
  ScrollDirection: enumeration(['Horizontal', 'Vertical']), Query: { type: 'object', nullable: true, reference: 'HomeQuery', clrType: 'HomeQuery' },
  TextInfo: { type: 'object', nullable: true, reference: 'TextInfo', clrType: 'TextInfo' } });
const schema = { definitions: {
  TextInfo: { defaults: { Level: 'Normal' }, fields: { Id: string, Name: string, Text: string, Level: { ...enumeration(['Normal', 'Warning', 'Error']), nullable: false } } },
  HomeQuery: { defaults: { StudioIds: [], TagIds: [], GenreIds: [], CollectionTypes: [] }, fields: queryFields },
  HomeSection: { defaults: { Id: null, ItemTypes: [], ExcludedFolders: [], CardSizeOffset: 0, IncludeNextUpInResume: true, Query: null }, fields: sectionFields },
  SectionChange: { defaults: { Ids: null, NewIndex: 0 }, fields: { Ids: strings, NewIndex: integer } },
} };
const bind = reference => (body, source) => bindJsonModel(body, { schema, root: { type: 'object', reference, clrType: reference }, source });

export function registerEmbyHomeSectionRoutes(add, services) {
  const owner = context => {
    const requested = guidValue(context.params.userId, 'userId');
    return context.auth.IsAdministrator ? requested : context.auth.UserId;
  };
  const run = operation => async context => {
    try { return await operation(context, owner(context)); }
    catch (error) {
      if (error instanceof BindingError) return embyTextResponse(500, error.message);
      if ([400, 404, 500].includes(error.status)) return embyTextResponse(error.status, error.message);
      throw error;
    }
  };
  add('GET', '/Users/{userId}/HomeSections', run(async (context, userId) => {
    const value = queryValue(context.query, 'IsEditMode');
    let isEditMode;
    try { isEditMode = booleanValue(value, 'IsEditMode', false); }
    catch { return embyTextResponse(500, `String '${value}' was not recognized as a valid Boolean.`); }
    return getHomeSections(services, userId, { isEditMode, displayMode: queryValue(context.query, 'DisplayMode') });
  }));
  add('POST', '/Users/{userId}/HomeSections', run(async (context, userId) => {
    await saveHomeSection(services, userId, context.body); return noContent();
  }), { body: true, bindBody: bind('HomeSection') });
  for (const action of ['Move', 'Delete']) add('POST', '/Users/{userId}/HomeSections/' + action, run(async (context, userId) => {
    await changeHomeSections(services, userId, action, context.body); return noContent();
  }), { body: true, bindBody: bind('SectionChange') });
}
