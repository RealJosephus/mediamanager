import { BindingError } from './binding.js';
import { permissionNames, configurationFields, configurationPreferences, subtitleModes, syncPlayModes,
  days, unratedItems, nativeGuid, equalsIgnoreCase } from '../users/native.js';

const string = { type: 'string', nullable: true };
const bool = { type: 'boolean' };
const integer = { type: 'integer' };
const decimal = { type: 'number' };
const guid = { type: 'guid' };
const array = item => ({ type: 'array', item, nullable: true });
const enumeration = (values, clrType) => ({ type: 'enum', values, clrType });
const configuration = {
  ...Object.fromEntries(configurationFields.map(name => [name, name.endsWith('LanguagePreference') ? string : bool])),
  ...Object.fromEntries(Object.keys(configurationPreferences).map(name => [name, array(guid)])),
  SubtitleMode: enumeration(subtitleModes, 'Jellyfin.Database.Implementations.Enums.SubtitlePlaybackMode'), CastReceiverId: string
};
const schedule = { UserId: guid, DayOfWeek: enumeration(days, 'Jellyfin.Database.Implementations.Enums.DynamicDayOfWeek'), StartHour: decimal, EndHour: decimal };
const policy = {
  ...Object.fromEntries(permissionNames.map(name => [name, bool])),
  EnableUserPreferenceAccess: bool,
  ...Object.fromEntries(['MaxParentalRating', 'MaxParentalSubRating'].map(name => [name, { ...integer, nullable: true }])),
  ...Object.fromEntries(['InvalidLoginAttemptCount', 'LoginAttemptsBeforeLockout', 'MaxActiveSessions', 'RemoteClientBitrateLimit'].map(name => [name, integer])),
  ...Object.fromEntries(['BlockedTags', 'AllowedTags', 'EnableContentDeletionFromFolders', 'EnabledDevices'].map(name => [name, array(string)])),
  ...Object.fromEntries(['EnabledChannels', 'EnabledFolders', 'BlockedMediaFolders', 'BlockedChannels'].map(name => [name, array(guid)])),
  AccessSchedules: array({ type: 'object', fields: schedule, nullable: true }),
  BlockUnratedItems: array(enumeration(unratedItems, 'Jellyfin.Data.Enums.UnratedItem')),
  AuthenticationProviderId: string, PasswordResetProviderId: string,
  SyncPlayAccess: enumeration(syncPlayModes, 'Jellyfin.Database.Implementations.Enums.SyncPlayUserAccessType')
};
const user = {
  ...Object.fromEntries(['Name', 'ServerId', 'ServerName', 'PrimaryImageTag'].map(name => [name, string])), Id: guid,
  ...Object.fromEntries(['HasPassword', 'HasConfiguredPassword', 'HasConfiguredEasyPassword', 'EnableAutoLogin'].map(name => [name, { ...bool, nullable: true }])),
  LastLoginDate: { type: 'date', nullable: true }, LastActivityDate: { type: 'date', nullable: true },
  PrimaryImageAspectRatio: { ...decimal, nullable: true },
  Configuration: { type: 'object', fields: configuration, nullable: true }, Policy: { type: 'object', fields: policy, nullable: true }
};
const schemas = {
  login: { Username: string, Pw: string }, create: { Name: string, Password: string }, configuration, policy,
  password: { CurrentPassword: string, CurrentPw: string, NewPw: string, ResetPassword: bool }, update: user
};
const clrTypes = { boolean: 'System.Boolean', integer: 'System.Int32', number: 'System.Double', guid: 'System.Guid', date: 'System.DateTime', string: 'System.String' };

function sourceLocations(text) {
  const locations = new Map();
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '') && index < text.length) index++; };
  function quoted() {
    const start = index++;
    while (index < text.length) { if (text[index++] === '"') break; if (text[index - 1] === '\\') index++; }
    return JSON.parse(text.slice(start, index));
  }
  function value(path) {
    whitespace();
    if (text[index] === '{') {
      index++; whitespace();
      while (text[index] !== '}') {
        const key = quoted(); whitespace(); index++; value(`${path}.${key}`); whitespace();
        if (text[index] !== ',') break;
        index++; whitespace();
      }
      index++;
    } else if (text[index] === '[') {
      index++; whitespace();
      for (let item = 0; text[index] !== ']'; item++) {
        value(`${path}[${item}]`); whitespace();
        if (text[index] !== ',') break;
        index++; whitespace();
      }
      index++;
    } else if (text[index] === '"') quoted();
    else while (index < text.length && !/[\s,}\]]/.test(text[index])) index++;
    const consumed = text.slice(0, index);
    locations.set(path, { line: consumed.split('\n').length - 1, position: Buffer.byteLength(consumed.slice(consumed.lastIndexOf('\n') + 1)) });
  }
  value('$');
  return locations;
}

function convert(value, rule, path, raw, container, key) {
  const fail = () => { throw new BindingError(path, `The JSON value could not be converted to ${rule.clrType ?? clrTypes[rule.type] ?? rule.type}. Path: ${path}.`); };
  if (value === null || value === '' && rule.nullable && ['boolean', 'integer', 'number', 'date'].includes(rule.type)) {
    if (rule.nullable) return null;
    if (rule.type === 'guid') return '00000000000000000000000000000000';
    return fail();
  }
  if (rule.type === 'string') {
    if (!['string', 'number', 'bigint', 'boolean'].includes(typeof value)) return fail();
    return typeof value === 'string' ? value : raw.get(container)?.get(key) ?? String(value);
  }
  if (rule.type === 'boolean') return typeof value === 'boolean' ? value : fail();
  if (rule.type === 'integer') {
    if (typeof value === 'number' && raw.get(container)?.get(key) && !/^-?\d+$/.test(raw.get(container).get(key))) return fail();
    if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) value = Number(value);
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : fail();
  }
  if (rule.type === 'number') {
    if (typeof value === 'string' && /^(?:[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|Infinity)|NaN)$/.test(value)) value = Number(value);
    return typeof value === 'number' ? value : fail();
  }
  if (rule.type === 'guid') {
    if (typeof value !== 'string') return fail();
    try { return nativeGuid(value); } catch { return fail(); }
  }
  if (rule.type === 'enum') {
    if (typeof value === 'number' && raw.get(container)?.get(key) && !/^-?\d+$/.test(raw.get(container).get(key))) return fail();
    if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return value;
    if (typeof value !== 'string') return fail();
    const text = value.trim();
    if (/^[+-]?\d+$/.test(text) && Number(text) >= -2147483648 && Number(text) <= 2147483647) return Number(text);
    const indices = text.split(',').map(part => rule.values.findIndex(name => equalsIgnoreCase(name, part.trim())));
    return indices.every(index => index >= 0) ? indices.reduce((combined, index) => combined | index, 0) : fail();
  }
  if (rule.type === 'date') return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fail();
  if (rule.type === 'array') return Array.isArray(value) ? value.map((entry, index) => convert(entry, rule.item, `${path}[${index}]`, raw, value, String(index))) : fail();
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      const name = Object.keys(rule.fields).find(name => equalsIgnoreCase(name, key));
      if (name) result[name] = convert(entry, rule.fields[name], `${path}.${key}`, raw, value, key);
    }
    return result;
  }
  throw new TypeError(`Unsupported binding type: ${rule.type}`);
}

export function validateUserBody(kind, body) {
  const fields = schemas[kind];
  if (!fields) throw new TypeError(`Unsupported user request: ${kind}`);
  const raw = new WeakMap();
  const source = body[Symbol.for('mediamanager.jsonSource')];
  if (source) body = JSON.parse(source, function (key, value, context) {
    if (context.source !== undefined) {
      if (!raw.has(this)) raw.set(this, new Map());
      raw.get(this).set(key, context.source);
      if (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source)) return BigInt(context.source);
    }
    return value;
  });
  let result;
  try { result = convert(body, { type: 'object', fields }, '$', raw); }
  catch (error) {
    if (!(error instanceof BindingError)) throw error;
    const parameter = { login: 'request', create: 'request', configuration: 'userConfig', policy: 'newPolicy', password: 'request', update: 'updateUser' }[kind];
    for (const path of Object.keys(error.errors)) {
      const location = source && sourceLocations(source).get(path);
      if (location) error.errors[path] = error.errors[path].map(message => message.replace(`Path: ${path}.`, `Path: ${path} | LineNumber: ${location.line} | BytePositionInLine: ${location.position}.`));
    }
    error.errors = { [parameter]: [`The ${parameter} field is required.`], ...error.errors };
    throw error;
  }
  const errors = {};
  const required = (object, field, prefix = '') => {
    if (object[field] === undefined || object[field] === null || typeof object[field] === 'string' && !object[field].trim()) errors[prefix + field] = [`The ${field} field is required.`];
  };
  if (kind === 'create') required(result, 'Name');
  if (kind === 'policy' || kind === 'update' && result.Policy !== null) {
    const target = kind === 'policy' ? result : result.Policy ?? {};
    for (const field of ['PasswordResetProviderId', 'AuthenticationProviderId']) required(target, field, kind === 'update' ? 'Policy.' : '');
  }
  if (kind === 'configuration' || kind === 'update' && result.Configuration) {
    const target = kind === 'configuration' ? result : result.Configuration;
    for (const field of Object.keys(configurationPreferences)) if (target[field] === null) required(target, field, kind === 'update' ? 'Configuration.' : '');
  }
  if (Object.keys(errors).length) { const error = new BindingError('', 'One or more validation errors occurred.'); error.errors = errors; throw error; }
  return result;
}
