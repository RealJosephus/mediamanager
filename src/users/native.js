import upperMapping from './resources/invariant-upper.json' with { type: 'json' };
import { clrTrim, clrWhitespace } from '../metadata/whitespace.js';

const guidWhitespace = new RegExp(`[${clrWhitespace}]`, 'gu');

export const AUTHENTICATION_PROVIDER = 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider';
export const PASSWORD_RESET_PROVIDER = 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider';
export const permissionNames = Object.freeze(['IsAdministrator', 'IsHidden', 'IsDisabled', 'EnableSharedDeviceControl',
  'EnableRemoteAccess', 'EnableLiveTvManagement', 'EnableLiveTvAccess', 'EnableMediaPlayback',
  'EnableAudioPlaybackTranscoding', 'EnableVideoPlaybackTranscoding', 'EnableContentDeletion',
  'EnableContentDownloading', 'EnableSyncTranscoding', 'EnableMediaConversion', 'EnableAllDevices',
  'EnableAllChannels', 'EnableAllFolders', 'EnablePublicSharing', 'EnableRemoteControlOfOtherUsers',
  'EnablePlaybackRemuxing', 'ForceRemoteSourceTranscoding', 'EnableCollectionManagement',
  'EnableSubtitleManagement', 'EnableLyricManagement']);
export const preferenceNames = Object.freeze(['BlockedTags', 'BlockedChannels', 'BlockedMediaFolders', 'EnabledDevices',
  'EnabledChannels', 'EnabledFolders', 'EnableContentDeletionFromFolders', 'LatestItemExcludes',
  'MyMediaExcludes', 'GroupedFolders', 'BlockUnratedItems', 'OrderedViews', 'AllowedTags']);
export const subtitleModes = Object.freeze(['Default', 'Always', 'OnlyForced', 'None', 'Smart']);
export const syncPlayModes = Object.freeze(['CreateAndJoinGroups', 'JoinGroups', 'None']);
export const days = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Everyday', 'Weekday', 'Weekend']);
export const unratedItems = Object.freeze(['Movie', 'Trailer', 'Series', 'Music', 'Book', 'LiveTvChannel', 'LiveTvProgram', 'ChannelContent', 'Other']);
export const configurationFields = Object.freeze(['AudioLanguagePreference', 'PlayDefaultAudioTrack', 'SubtitleLanguagePreference',
  'DisplayMissingEpisodes', 'SubtitleMode', 'DisplayCollectionsView', 'EnableLocalPassword', 'HidePlayedInLatest',
  'RememberAudioSelections', 'RememberSubtitleSelections', 'EnableNextEpisodeAutoPlay']);
export const configurationPreferences = Object.freeze({ OrderedViews: 'OrderedViews', GroupedFolders: 'GroupedFolders',
  MyMediaExcludes: 'MyMediaExcludes', LatestItemsExcludes: 'LatestItemExcludes' });
export const policyPreferences = Object.freeze(['BlockedTags', 'AllowedTags', 'EnabledChannels', 'EnabledDevices',
  'EnabledFolders', 'EnableContentDeletionFromFolders', 'BlockUnratedItems']);
export const guidPreferences = new Set(['BlockedChannels', 'BlockedMediaFolders', 'EnabledChannels', 'EnabledFolders',
  'LatestItemExcludes', 'MyMediaExcludes', 'GroupedFolders', 'OrderedViews']);

export function domainError(status, message) { return Object.assign(new Error(message), { status, statusCode: status }); }
export function upperInvariant(value) { return [...String(value)].map(char => upperMapping[char] ?? char).join(''); }
export function equalsIgnoreCase(left, right) { return upperInvariant(left ?? '') === upperInvariant(right ?? ''); }
export function nativeGuid(value) {
  const text = clrTrim(String(value ?? ''));
  let raw = text;
  const hex = text.replace(guidWhitespace, '').match(/^\{0x(0*[0-9a-f]{1,8}),0x(0*[0-9a-f]{1,8}),0x(0*[0-9a-f]{1,8}),\{0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2}),0x(0*[0-9a-f]{1,2})\}\}$/i);
  if (hex) {
    // Guid.Parse reads the first three X fields as UInt32, then keeps the middle fields' low 16 bits.
    const parts = hex.slice(1).map((part, index) => {
      const width = index === 0 ? 8 : index < 3 ? 4 : 2;
      return part.replace(/^0+/u, '').slice(-width).padStart(width, '0');
    });
    return nativeGuid(parts.join(''));
  }
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('(') && text.endsWith(')'))) raw = text.slice(1, -1);
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw)) raw = raw.replaceAll('-', '');
  else if (!/^[0-9a-fA-F]{32}$/.test(raw) || raw !== text) throw domainError(400, 'Invalid GUID.');
  return raw.toUpperCase().replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
}
export const wireGuid = value => nativeGuid(value).replaceAll('-', '').toLowerCase();
export function nativeDate(value = new Date()) {
  return value.toISOString().replace('T', ' ').replace(/\.(\d+)Z$/, (_, digits) => {
    const fraction = digits.replace(/0+$/, '');
    return fraction ? `.${fraction}` : '';
  });
}
export function nativeDateFromUnixNanoseconds(nanoseconds) {
  if (typeof nanoseconds !== 'bigint') throw new TypeError('A bigint filesystem timestamp is required.');
  let wholeSeconds = nanoseconds / 1_000_000_000n;
  let subsecondNanoseconds = nanoseconds % 1_000_000_000n;
  if (subsecondNanoseconds < 0n) {
    wholeSeconds--;
    subsecondNanoseconds += 1_000_000_000n;
  }
  const fraction = (subsecondNanoseconds / 100n)
    .toString().padStart(7, '0').replace(/0+$/, '');
  const seconds = new Date(Number(wholeSeconds * 1_000n)).toISOString().slice(0, 19).replace('T', ' ');
  return fraction ? `${seconds}.${fraction}` : seconds;
}
export function wireDate(value) {
  if (!value) return null;
  const normalized = value.replace(' ', 'T').replace(/Z$/, '');
  const [date, fraction = ''] = normalized.split('.');
  const digits = fraction.padEnd(7, '0');
  return `${date}.${Number(digits.slice(0, 3)) === 0 ? digits : digits.replace(/0+$/, '')}Z`;
}
export function enumValue(value, values) {
  if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return value;
  const index = values.findIndex(name => equalsIgnoreCase(name, value));
  if (index >= 0) return index;
  throw domainError(400, `Invalid enum value: ${value}`);
}
export const enumName = (value, values) => values[value] ?? value;
export function defaultPermissions() {
  const disabled = new Set(['IsAdministrator', 'IsDisabled', 'EnableContentDeletion', 'EnableLiveTvManagement',
    'ForceRemoteSourceTranscoding', 'EnableRemoteControlOfOtherUsers', 'EnableCollectionManagement',
    'EnableSubtitleManagement', 'EnableLyricManagement']);
  const order = [0, 2, 1, 15, 14, 16, 10, 11, 13, 7, 19, 17, 4, 12, 8, 6, 5, 3, 9, 20, 18, 21, 22, 23];
  return Object.fromEntries(order.map(index => [permissionNames[index], !disabled.has(permissionNames[index])]));
}
export function defaultConfiguration() {
  return { AudioLanguagePreference: null, PlayDefaultAudioTrack: true, SubtitleLanguagePreference: null,
    DisplayMissingEpisodes: false, GroupedFolders: [], SubtitleMode: 'Default', DisplayCollectionsView: false,
    EnableLocalPassword: false, OrderedViews: [], LatestItemsExcludes: [], MyMediaExcludes: [], HidePlayedInLatest: true,
    RememberAudioSelections: true, RememberSubtitleSelections: true, EnableNextEpisodeAutoPlay: true, CastReceiverId: null };
}
export function defaultPolicy() {
  return { ...defaultPermissions(), EnableLiveTvManagement: true, MaxParentalRating: null, MaxParentalSubRating: null,
    BlockedTags: [], AllowedTags: [], EnableUserPreferenceAccess: true, AccessSchedules: [], BlockUnratedItems: [],
    EnableContentDeletionFromFolders: [], EnabledDevices: [], EnabledChannels: [], EnabledFolders: [],
    InvalidLoginAttemptCount: 0, LoginAttemptsBeforeLockout: -1, MaxActiveSessions: 0, BlockedMediaFolders: null,
    BlockedChannels: null, RemoteClientBitrateLimit: 0, AuthenticationProviderId: null, PasswordResetProviderId: null,
    SyncPlayAccess: 'CreateAndJoinGroups' };
}
export function normalizeMembers(value, defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw domainError(400, 'A request body is required.');
  const result = { ...defaults };
  const names = Object.keys(defaults);
  for (const [key, entry] of Object.entries(value)) {
    const name = names.find(name => equalsIgnoreCase(name, key));
    if (name) result[name] = entry;
  }
  return result;
}
export function matchesUsernamePattern(name) {
  // .NET Regex \w includes letters, nonspacing marks, decimal digits and connector punctuation.
  return typeof name === 'string' && name.length > 0 && !name.startsWith(' ') && !name.endsWith(' ')
    && !/[\uD800-\uDFFF]/.test(name) && /^[\p{L}\p{Mn}\p{Nd}\p{Pc} '\-._@+]+$/u.test(name);
}
export function validateUsername(name) {
  if (!matchesUsernamePattern(name) || ['.', '..'].includes(name)) {
    throw domainError(400, "Usernames can contain unicode symbols, numbers (0-9), dashes (-), underscores (_), apostrophes ('), and periods (.)");
  }
}
export function scheduleAllowed(user, date = new Date()) {
  const schedules = user.AccessSchedules ?? [];
  const current = date.getDay();
  const hour = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600 + date.getMilliseconds() / 3600000;
  return !schedules.length || schedules.some(schedule => {
    const day = typeof schedule.DayOfWeek === 'string' ? days.indexOf(schedule.DayOfWeek) : schedule.DayOfWeek;
    return (day === current || day === 7 || (day === 8 && current >= 1 && current <= 5)
      || (day === 9 && (current === 0 || current === 6))) && hour >= schedule.StartHour && hour <= schedule.EndHour;
  });
}
