import { BindingError, guidValue, queryValue } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';

const schema = {
  definitions: {
    DeviceOptionsDto: {
      defaults: { Id: 0, DeviceId: null, CustomName: null },
      fields: {
        Id: { type: 'integer', clrType: 'System.Int32' },
        DeviceId: { type: 'string', clrType: 'System.String', nullable: true },
        CustomName: { type: 'string', clrType: 'System.String', nullable: true }
      }
    }
  }
};
const root = { type: 'object', clrType: 'Jellyfin.Data.Dtos.DeviceOptionsDto', reference: 'DeviceOptionsDto', nullable: true };

export function bindDevicesUserId(context) {
  const raw = queryValue(context.query, 'userId');
  return raw === undefined || !raw.trim() ? null : guidValue(raw, 'userId');
}

export function requiredDeviceId(context) {
  const raw = queryValue(context.query, 'id');
  if (raw === undefined || !raw.trim()) throw new BindingError('id', 'The id field is required.');
  return raw;
}

export function deviceIds(context) {
  return [...context.query].filter(([key]) => key.toLowerCase() === 'id').map(([, value]) => value);
}

export function validateDeviceOptionsBody(body, source) {
  try {
    const value = bindJsonModel(body, { schema, root, source });
    if (value != null) return value;
    const error = new BindingError('', 'A non-empty request body is required.');
    error.errors.deviceOptions = ['The deviceOptions field is required.'];
    throw error;
  } catch (error) {
    if (error instanceof BindingError && !Object.hasOwn(error.errors, 'deviceOptions')) {
      error.errors = { deviceOptions: ['The deviceOptions field is required.'], ...error.errors };
    }
    throw error;
  }
}
