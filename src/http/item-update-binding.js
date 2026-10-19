import schema from './resources/item-update-schema.json' with { type: 'json' };
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { BindingError } from './binding.js';

export function bindItemUpdate(body, source) {
  const value = bindJsonModel(body, { schema, root: schema.item, source });
  if (value == null) throw new BindingError('', 'A non-empty request body is required.');
  return validateJsonModel(value, { schema, root: schema.item });
}
