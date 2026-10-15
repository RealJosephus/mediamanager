import { BindingError, guidValue, queryValue } from './binding.js';

export function bindSessionsQuery(context) {
  const errors = {};
  const query = name => queryValue(context.query, name);
  const nullableGuid = name => {
    const raw = query(name);
    if (raw === undefined || !raw.trim()) return null;
    try { return guidValue(raw, name); }
    catch (error) {
      if (!(error instanceof BindingError)) throw error;
      Object.assign(errors, error.errors);
      return null;
    }
  };
  const nullableInteger = name => {
    const raw = query(name);
    if (raw === undefined || !raw.trim()) return null;
    if (!/^[+-]?\d+$/u.test(raw.trim()) || Number(raw) < -2147483648 || Number(raw) > 2147483647) {
      errors[name] = [`The value '${raw}' is not valid.`];
      return null;
    }
    return Number(raw);
  };
  const optionalString = name => {
    const raw = query(name);
    return raw === undefined || !raw.trim() ? null : raw;
  };

  // ASP.NET's model-state error dictionary exposes these action parameters in
  // reverse binding order, which is observable on the serialized problem body.
  const activeWithinSeconds = nullableInteger('activeWithinSeconds');
  const controllableByUserId = nullableGuid('controllableByUserId');
  const result = { controllableByUserId, deviceId: optionalString('deviceId'), activeWithinSeconds };
  if (Object.keys(errors).length) {
    const error = new BindingError('', 'One or more validation errors occurred.');
    error.errors = errors;
    throw error;
  }
  return result;
}
