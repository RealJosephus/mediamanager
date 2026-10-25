import { BindingError, HttpResult, booleanValue, guidValue, httpError, integerValue, noContent, notFound, queryValue } from './binding.js';
import { enumName } from '../sessions/binding.js';
import { itemImageTypes } from '../library/dto.js';

const itemFields = ['AirTime', 'CanDelete', 'CanDownload', 'ChannelInfo', 'Chapters', 'Trickplay', 'ChildCount',
  'CumulativeRunTimeTicks', 'CustomRating', 'DateCreated', 'DateLastMediaAdded', 'DisplayPreferencesId', 'Etag',
  'ExternalUrls', 'Genres', 'ItemCounts', 'MediaSourceCount', 'MediaSources', 'OriginalTitle', 'Overview', 'ParentId',
  'Path', 'People', 'PlayAccess', 'ProductionLocations', 'ProviderIds', 'PrimaryImageAspectRatio',
  'RecursiveItemCount', 'Settings', 'SeriesStudio', 'SortName', 'SpecialEpisodeNumbers', 'Studios', 'Taglines',
  'Tags', 'RemoteTrailers', 'MediaStreams', 'SeasonUserData', 'DateLastRefreshed', 'DateLastSaved', 'RefreshState',
  'ChannelImage', 'EnableMediaSourceDisplay', 'Width', 'Height', 'ExtraIds', 'LocalTrailerCount', 'IsHD', 'SpecialFeatureCount'];
const statuses = ['New', 'InProgress', 'Completed', 'Cancelled', 'ConflictedOk', 'ConflictedNotOk', 'Error'];
const emptyId = value => !value || /^0{32}$/u.test(value.replaceAll('-', ''));
const emptyResult = () => ({ Items: [], TotalRecordCount: 0, StartIndex: 0 });

function commaEnums(query, name, names) {
  const values = [...query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
  const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
  return entries.flatMap(value => {
    try { return [enumName(value.trim(), names)]; }
    catch { return []; }
  });
}

function bindQuery(context, { series = false } = {}) {
  const query = name => queryValue(context.query, name);
  const errors = {};
  const bind = (reader, name, defaultValue) => {
    try { return reader(query(name), name, defaultValue); }
    catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
  };
  let status;
  try { if (query('status')) status = enumName(query('status'), statuses); }
  catch { /* Nullable enum binding discards an unrecognized value. */ }
  const fields = commaEnums(context.query, 'fields', itemFields).filter(value => typeof value === 'string');
  const imageTypes = commaEnums(context.query, 'enableImageTypes', itemImageTypes).map(String);
  const result = { channelid: query('channelId'), userid: bind(guidValue, 'userId'),
    startindex: bind(integerValue, 'startIndex'), limit: bind(integerValue, 'limit'), status,
    isinprogress: bind(booleanValue, 'isInProgress'), seriestimerid: query('seriesTimerId'),
    enableimages: bind(booleanValue, 'enableImages'), imagetypelimit: bind(integerValue, 'imageTypeLimit'),
    enableimagetypes: imageTypes.length ? imageTypes : undefined, fields,
    enableuserdata: bind(booleanValue, 'enableUserData'),
    enabletotalrecordcount: bind(booleanValue, 'enableTotalRecordCount', true) };
  if (!series) for (const name of ['isMovie', 'isSeries', 'isKids', 'isSports', 'isNews', 'isLibraryItem']) {
    result[name.toLowerCase()] = bind(booleanValue, name);
  }
  if (Object.keys(errors).length) { const error = new BindingError('', ''); error.errors = errors; throw error; }
  return result;
}

export function registerLiveTvRecordingRoutes(add, { liveTvRecordings, users }) {
  if (!liveTvRecordings) return;
  const options = { policy: 'LiveTvAccess' };
  const userById = id => {
    if (!users) throw httpError(501, 'Recording access requires the authoritative user service.');
    return users.getUser(id);
  };
  const requestUser = async (context, supplied) => {
    const id = emptyId(supplied) ? context.auth.UserId : supplied;
    if (!emptyId(id) && id !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
    return emptyId(id) ? null : userById(id);
  };
  const recordingId = context => {
    const id = guidValue(context.params.recordingId, 'recordingId');
    if (id === undefined) throw new BindingError('recordingId', 'The recordingId field is required.');
    return id;
  };
  add('GET', '/LiveTv/Recordings', async context => {
    const input = bindQuery(context);
    return liveTvRecordings.getRecordings(input, { user: await requestUser(context, input.userid) });
  }, options);
  add('GET', '/LiveTv/Recordings/Series', context => { bindQuery(context, { series: true }); return emptyResult(); }, options);
  add('GET', '/LiveTv/Recordings/Groups', context => {
    guidValue(queryValue(context.query, 'userId'), 'userId'); return emptyResult();
  }, options);
  add('GET', '/LiveTv/Recordings/Folders', async context => liveTvRecordings.getFolders({
    user: await requestUser(context, guidValue(queryValue(context.query, 'userId'), 'userId')),
  }), options);
  add('GET', '/LiveTv/Recordings/{recordingId}', async context => {
    const id = recordingId(context);
    const user = await requestUser(context, guidValue(queryValue(context.query, 'userId'), 'userId'));
    try { return await liveTvRecordings.getRecording(id, { user }); }
    catch (error) { if ((error.status ?? error.statusCode) === 404) return notFound(); throw error; }
  }, options);
  add('DELETE', '/LiveTv/Recordings/{recordingId}', async context => {
    const id = recordingId(context);
    const user = emptyId(context.auth.UserId) ? null : await userById(context.auth.UserId);
    if (!user && !context.auth.IsApiKey) throw new HttpResult(404);
    return await liveTvRecordings.deleteRecording(id, { user }) ? noContent() : notFound();
  }, { policy: 'LiveTvManagement' });
}
