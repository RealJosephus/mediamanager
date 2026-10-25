import { BindingError, guidValue, queryValue, noContent, httpError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { displayPreferenceEnums } from '../users/display-preferences-service.js';
import { clrTrim } from '../metadata/whitespace.js';

const string = { type: 'string', clrType: 'System.String', nullable: true };
const boolean = { type: 'boolean', clrType: 'System.Boolean', nullable: false };
const integer = { type: 'integer', clrType: 'System.Int32', nullable: false };
const enumRule = type => ({ type: 'enum', clrType: 'Jellyfin.Database.Implementations.Enums.' + type, nullable: false,
  values: Object.fromEntries(displayPreferenceEnums[type].map((name, index) => [name, index])) });
const schema = { definitions: { DisplayPreferencesDto: {
  defaults: { Id: null, ViewType: null, SortBy: null, IndexBy: null, RememberIndexing: false,
    PrimaryImageHeight: 250, PrimaryImageWidth: 250, CustomPrefs: new Map(), ScrollDirection: 'Horizontal',
    ShowBackdrop: true, RememberSorting: false, SortOrder: 'Ascending', ShowSidebar: false, Client: null },
  required: ['CustomPrefs'],
  fields: { Id: string, ViewType: string, SortBy: string, IndexBy: string, RememberIndexing: boolean,
    PrimaryImageHeight: integer, PrimaryImageWidth: integer,
    CustomPrefs: { type: 'dictionary', clrType: 'System.Collections.Generic.Dictionary`2[System.String,System.String]', nullable: true, item: string },
    ScrollDirection: enumRule('ScrollDirection'), ShowBackdrop: boolean, RememberSorting: boolean,
    SortOrder: enumRule('SortOrder'), ShowSidebar: boolean, Client: string }
} } };
const root = { type: 'object', reference: 'DisplayPreferencesDto', clrType: 'MediaBrowser.Model.Dto.DisplayPreferencesDto' };
const settingsRoot = { type: 'dictionary', clrType: 'System.Collections.Generic.Dictionary`2[System.String,System.String]',
  nullable: false, item: string };
function bindUserSettings(body, source) {
  if (body == null) throw new BindingError('', 'A non-empty request body is required.');
  return bindJsonModel(body, { schema, root: settingsRoot, source });
}
function bindBody(body, source) {
  if (body == null) throw new BindingError('', 'A non-empty request body is required.');
  const result = bindJsonModel(body, { schema, root, source });
  try { return validateJsonModel(result, { schema, root }); }
  catch (error) { error.modelValidated = true; throw error; }
}
function bindQuery(query, params) {
  const errors = {}, client = queryValue(query, 'client');
  if (clrTrim(params.displayPreferencesId) === '') errors.displayPreferencesId = ['The displayPreferencesId field is required.'];
  if (client == null || clrTrim(client) === '') errors.client = ['The client field is required.'];
  let userId;
  try { const raw = queryValue(query, 'userId'); userId = raw == null || clrTrim(raw) === '' ? undefined : guidValue(raw, 'userId'); }
  catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
  if (Object.keys(errors).length) { const error = new BindingError('', 'One or more validation errors occurred.'); error.errors = errors; throw error; }
  return { client, userId };
}
export function registerDisplayPreferencesRoutes(add, { displayPreferences }) {
  if (!displayPreferences) return;
  for (const [method, suffix] of [['GET', ''], ['POST', ''], ['POST', '/Partial']]) {
    add(method, '/UserSettings/{userId}' + suffix, async context => {
      const userId = context.queryInput;
      if (userId !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
      if (method === 'GET') return displayPreferences.getUserSettings(userId);
      await displayPreferences.updateUserSettings(userId, context.body, { partial: Boolean(suffix) });
      return noContent();
    }, { bindQuery: (_query, params) => guidValue(params.userId, 'userId'),
      ...(method === 'POST' && { body: true, bindBody: bindUserSettings, bodyType: settingsRoot.clrType }) });
  }
  for (const method of ['GET', 'POST']) add(method, '/DisplayPreferences/{displayPreferencesId}', async context => {
    const { userId, client } = context.queryInput;
    const target = userId && !/^0{32}$/u.test(userId) ? userId : context.auth.UserId ?? '00000000000000000000000000000000';
    if (target !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
    if (method === 'GET') return displayPreferences.get(context.params.displayPreferencesId, target, client);
    await displayPreferences.update(context.params.displayPreferencesId, target, client, context.body); return noContent();
  }, { bindQuery, ...(method === 'POST' && { body: true, bindBody, bodyParameter: 'displayPreferences', bodyType: root.clrType }) });
}
