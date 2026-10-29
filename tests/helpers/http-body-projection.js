import assert from 'node:assert/strict';
import { dateText } from '../../src/library/records.js';

// Request traces belong to the root ProblemDetails document. A metadata key
// with the same spelling is ordinary business data, and absence stays visible.
export function projectProblemTrace(body, status = body?.status) {
  if (!body || Array.isArray(body) || typeof body !== 'object'
    || !Number.isInteger(status) || status < 400 || status > 599
    || body.status !== status || typeof body.title !== 'string' || !Object.hasOwn(body, 'traceId')) return body;
  assert.equal(typeof body.traceId, 'string');
  assert.ok(body.traceId.length > 0);
  return { ...body, traceId: '$trace' };
}

// PlaybackInfoResponse has a root correlation ID and declared media source /
// stream paths. Identically named metadata and headers are not those roles.
export function projectPlaybackInfoBody(body, { status, path = value => value } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || status !== 200 || !Array.isArray(body.MediaSources)) return projectProblemTrace(body, status);
  const source = structuredClone(body);
  if (Object.hasOwn(source, 'PlaySessionId')) {
    assert.equal(typeof source.PlaySessionId, 'string'); assert.ok(source.PlaySessionId.length > 0);
    source.PlaySessionId = '$play-session';
  }
  const withPath = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.Path === 'string'
    ? { ...value, Path: path(value.Path) } : value;
  source.MediaSources = source.MediaSources.map(value => {
    const result = withPath(value);
    return result && Array.isArray(result.MediaStreams)
      ? { ...result, MediaStreams: result.MediaStreams.map(withPath) } : result;
  });
  return source;
}

const identityFields = new Set(['Id', 'ItemId', 'ParentId', 'UserId', 'OwnerId', 'ChannelId', 'ProgramId', 'SeasonId', 'SeriesId',
  'AlbumId', 'DisplayPreferencesId', 'PrimaryImageItemId', 'ParentLogoItemId', 'ParentBackdropItemId',
  'ParentThumbItemId', 'ParentPrimaryImageItemId', 'ChannelPrimaryImageItemId']);
const dateFields = new Set(['DateCreated', 'DateLastMediaAdded',
  'PremiereDate', 'StartDate', 'EndDate']);
const namedItems = new Set(['GenreItems', 'ArtistItems', 'AlbumArtists', 'Studios', 'People']);
const nestedItems = new Set(['CurrentProgram']);

// Traverse declared DTO roles, rather than names found in arbitrary objects.
// ProviderIds, headers, unknown properties and descriptive text stay literal.
export function projectItemBody(value, { status, serverId, serverToken = '$server', identity = value => value, path = value => value,
  date = value => dateText(value), item = value => value } = {}) {
  const fields = (source, kind, owner) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
    return Object.fromEntries(Object.entries(source).map(([key, entry]) => {
      const context = { kind, field: key, owner };
      if (kind === 'item' && key === 'ServerId' && serverId !== undefined) {
        assert.equal(entry, serverId, 'The DTO must identify its actual isolated server.');
        return [key, serverToken];
      }
      if (identityFields.has(key) && typeof entry === 'string') return [key, identity(entry, context)];
      if (key === 'Path' && typeof entry === 'string' && ['item', 'source', 'stream'].includes(kind)) return [key, path(entry, context)];
      if ((kind === 'item' && dateFields.has(key) || kind === 'userdata' && key === 'LastPlayedDate')
        && typeof entry === 'string') return [key, date(entry, context)];
      if (kind === 'item' && namedItems.has(key) && Array.isArray(entry)) return [key, entry.map(value => fields(value, 'named', source))];
      if (kind === 'item' && nestedItems.has(key)) return [key, dto(entry)];
      if (kind === 'item' && key === 'UserData') return [key, fields(entry, 'userdata', source)];
      if (kind === 'item' && key === 'MediaSources' && Array.isArray(entry)) return [key, entry.map(value => fields(value, 'source', source))];
      if (['item', 'source'].includes(kind) && key === 'MediaStreams' && Array.isArray(entry)) return [key, entry.map(value => fields(value, 'stream', source))];
      return [key, entry];
    }));
  };
  const dto = value => value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.Id === 'string' && typeof value.Type === 'string' ? fields(item(value), 'item', value) : value;
  if (Array.isArray(value)) return value.map(dto);
  if (value && typeof value === 'object' && Array.isArray(value.Items)) return { ...value, Items: value.Items.map(dto) };
  if (value && typeof value === 'object' && typeof value.Id === 'string' && typeof value.Type === 'string') return dto(value);
  return status === undefined ? value : projectProblemTrace(value, status);
}
