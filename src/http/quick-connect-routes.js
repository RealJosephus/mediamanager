import { HttpResult, BindingError, guidValue, queryValue } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { clrTrim } from '../metadata/whitespace.js';

const schema = { definitions: { QuickConnectDto: {
  defaults: { Secret: null }, required: ['Secret'], nonEmpty: ['Secret'],
  fields: { Secret: { type: 'string', clrType: 'System.String', nullable: true } }
} } };
const root = { type: 'object', reference: 'QuickConnectDto', clrType: 'Jellyfin.Api.Models.UserDtos.QuickConnectDto' };

function bindRequest(body, source) {
  if (body == null) throw new BindingError('', 'A non-empty request body is required.');
  const result = bindJsonModel(body, { schema, root, source });
  try { return validateJsonModel(result, { schema, root }); }
  catch (error) { error.modelValidated = true; throw error; }
}

function requiredQuery(query, name) {
  const value = queryValue(query, name);
  if (value === undefined || clrTrim(value) === '') throw new BindingError(name, `The ${name} field is required.`);
  return value;
}

function bindAuthorize(query) {
  const errors = {};
  let code, userId;
  try { code = requiredQuery(query, 'code'); } catch (error) { Object.assign(errors, error.errors); }
  try {
    const value = queryValue(query, 'userId');
    userId = value === undefined || clrTrim(value) === '' ? undefined : guidValue(value, 'userId');
  } catch (error) { Object.assign(errors, error.errors); }
  if (Object.keys(errors).length) {
    const error = new BindingError('', 'One or more validation errors occurred.'); error.errors = errors; throw error;
  }
  return { code, userId };
}

function disabled(error) {
  if (error.status === 401) return new HttpResult(401, 'Quick connect is disabled');
  throw error;
}

export function registerQuickConnectRoutes(add, { quickConnect }) {
  if (!quickConnect) return;
  add('GET', '/QuickConnect/Enabled', () => quickConnect.enabled, { public: true });
  add('POST', '/QuickConnect/Initiate', context => {
    try { return quickConnect.initiate(context.auth); } catch (error) { return disabled(error); }
  }, { public: true });
  add('GET', '/QuickConnect/Connect', context => {
    try { return quickConnect.connect(context.queryInput); }
    catch (error) { return error.status === 404 ? new HttpResult(404, 'Unknown secret') : disabled(error); }
  }, { public: true, bindQuery: query => requiredQuery(query, 'secret') });
  add('POST', '/QuickConnect/Authorize', async context => {
    const { code, userId } = context.queryInput;
    const target = userId && !/^0{32}$/u.test(userId) ? userId : context.auth.UserId;
    if (target !== context.auth.UserId && !context.auth.IsAdministrator) throw Object.assign(new Error('Forbidden'), { status: 403 });
    try { return await quickConnect.authorize(target, code); } catch (error) { return disabled(error); }
  }, { bindQuery: bindAuthorize });
  add('POST', '/Users/AuthenticateWithQuickConnect', context => quickConnect.authenticate(context.body.Secret), {
    public: true, body: true, bindBody: bindRequest, bodyParameter: 'request', bodyType: root.clrType
  });
}
