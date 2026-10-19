import { BindingError, noContent, queryValue } from './binding.js';
import { clrTrim } from '../metadata/whitespace.js';

function required(value, name) {
  if (value === undefined || clrTrim(value) === '') throw new BindingError(name, `The ${name} field is required.`);
  return value;
}

export function registerApiKeyRoutes(add, { apiKeys }) {
  if (!apiKeys) return;
  const policy = 'RequiresElevation';
  add('GET', '/Auth/Keys', () => apiKeys.list(), { policy });
  add('POST', '/Auth/Keys', async context => {
    await apiKeys.create(context.queryInput);
    return noContent();
  }, { policy, bindQuery: query => required(queryValue(query, 'app'), 'app') });
  add('DELETE', '/Auth/Keys/{key}', async context => {
    await apiKeys.revoke(context.queryInput);
    return noContent();
  }, { policy, bindQuery: (_query, params) => required(params.key, 'key') });
}
