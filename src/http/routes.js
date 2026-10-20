import { HttpResult, BindingError, noContent, notFound, badRequest, httpError, member, requireMember,
  queryValue, booleanValue, integerValue, guidValue } from './binding.js';
import { validateUserBody } from './user-binding.js';
import { parseInvariantDate, parsePlayedDate } from './date-binding.js';
import { validateClientCapabilitiesDto } from './client-capabilities-binding.js';
import { bindSessionsQuery } from './session-management-binding.js';
import { bindDevicesUserId, requiredDeviceId, deviceIds, validateDeviceOptionsBody } from './device-binding.js';
import { bindUserDataBody } from './user-data-binding.js';
import { bindUserViewPresets } from './user-view-binding.js';
import { enumName, generalCommands, mediaTypes, itemKinds } from '../sessions/binding.js';
import { AUTHENTICATION_PROVIDER, PASSWORD_RESET_PROVIDER } from '../users/native.js';
import { itemFields, itemImageTypes } from '../library/dto.js';
import { parseQuery } from '../library/query.js';
import { embyTextResponse } from './client-protocol.js';

const itemSortNames = ['Default', 'AiredEpisodeOrder', 'Album', 'AlbumArtist', 'Artist', 'DateCreated',
  'OfficialRating', 'DatePlayed', 'PremiereDate', 'StartDate', 'SortName', 'Name', 'Random', 'Runtime',
  'CommunityRating', 'ProductionYear', 'PlayCount', 'CriticRating', 'IsFolder', 'IsUnplayed', 'IsPlayed',
  'SeriesSortName', 'VideoBitRate', 'AirTime', 'Studio', 'IsFavoriteOrLiked', 'DateLastContentAdded',
  'SeriesDatePlayed', 'ParentIndexNumber', 'IndexNumber'];
const controllerItemFields = ['AirTime', 'CanDelete', 'CanDownload', 'ChannelInfo', 'Chapters', 'Trickplay', 'ChildCount',
  'CumulativeRunTimeTicks', 'CustomRating', 'DateCreated', 'DateLastMediaAdded', 'DisplayPreferencesId', 'Etag',
  'ExternalUrls', 'Genres', 'ItemCounts', 'MediaSourceCount', 'MediaSources', 'OriginalTitle', 'Overview', 'ParentId',
  'Path', 'People', 'PlayAccess', 'ProductionLocations', 'ProviderIds', 'PrimaryImageAspectRatio',
  'RecursiveItemCount', 'Settings', 'SeriesStudio', 'SortName', 'SpecialEpisodeNumbers', 'Studios', 'Taglines',
  'Tags', 'RemoteTrailers', 'MediaStreams', 'SeasonUserData', 'DateLastRefreshed', 'DateLastSaved', 'RefreshState',
  'ChannelImage', 'EnableMediaSourceDisplay', 'Width', 'Height', 'ExtraIds', 'LocalTrailerCount', 'IsHD',
  'SpecialFeatureCount'];

export function registerDomainRoutes(add, { configuration, authentication, users, devices, library, playlists, sessions, userData, hls }) {
  const query = (context, name) => queryValue(context.query, name);
  const boolean = (context, name, fallback) => booleanValue(query(context, name), name, fallback);
  const integer = (context, name, fallback) => integerValue(query(context, name), name, fallback);
  const guid = (context, name, fallback) => guidValue(context.params[name] ?? query(context, name), name, fallback);
  const commaEnums = (context, name, names) => {
    const values = [...context.query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
    const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
    return entries.flatMap(value => {
      try { return [enumName(value.trim(), names)]; }
      catch { return []; }
    });
  };
  const commaGuids = (context, name) => {
    const values = [...context.query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
    const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
    return entries.flatMap(value => {
      try { return [guidValue(value.trim(), name)]; }
      catch { return []; }
    });
  };
  const privateItemQueryNames = new Set([
    'hasnoaudiotrackwithlanguage', 'hasnosubtitletrackwithlanguage',
    'hasnointernalsubtitletrackwithlanguage', 'hasnoexternalsubtitletrackwithlanguage',
    'haschapterimages',
  ]);
  const bindItemFields = (context, input) => {
    // CommaDelimitedCollectionModelBinder drops unknown enum names. The DTO
    // layer must only see fields the controller actually bound.
    const result = new URLSearchParams([...input].filter(([name]) => name.toLowerCase() !== 'fields'));
    const fields = commaEnums(context, 'fields', controllerItemFields).filter(value => typeof value === 'string');
    if (fields.length) result.set('fields', fields.join(','));
    return result;
  };
  const itemQuery = context => bindItemFields(context, [...context.query].filter(([name]) => {
    const key = name.toLowerCase();
    // These are InternalItemsQuery-only properties and are not controller
    // parameters, so ASP.NET ignores them instead of exposing a public filter.
    if (privateItemQueryNames.has(key)) return false;
    if (!context.embyClient && key === 'wassearched') return false;
    // The obsolete user-scoped action predates the two language parameters.
    return !context.params.userId || !['audiolanguages', 'subtitlelanguages'].includes(key);
  }));
  async function requestUser(context, { required = true, currentEmbyUser = false } = {}) {
    let id = guid(context, 'userId', context.auth.UserId);
    if (currentEmbyUser && context.embyClient && !context.auth.IsAdministrator) id = context.auth.UserId;
    if (/^0{32}$/.test(id ?? '')) id = context.auth.UserId;
    if (id && id !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
    const user = id && !/^0{32}$/.test(id) ? await users.getUser(id) : null;
    if (!user && (required || id && !/^0{32}$/.test(id))) throw new HttpResult(404);
    return user;
  }
  async function optionalRequestUser(context) {
    let id = guid(context, 'userId', context.auth.UserId);
    if (/^0{32}$/.test(id ?? '')) id = context.auth.UserId;
    if (id && id !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
    return id && !/^0{32}$/.test(id) ? await users.getUser(id) : null;
  }
  const controllerDtoOptions = (context, { userData = true } = {}) => {
    const enableImageTypes = commaEnums(context, 'enableImageTypes', itemImageTypes).map(String);
    const requestedFields = commaEnums(context, 'fields', controllerItemFields).filter(value => typeof value === 'string');
    return {
      fields: requestedFields,
      enableimages: boolean(context, 'enableImages'),
      imagetypelimit: integer(context, 'imageTypeLimit'),
      enableimagetypes: enableImageTypes.length ? enableImageTypes : undefined,
      enableuserdata: userData ? boolean(context, 'enableUserData') : false,
    };
  };
  const requireSupportedDtoFields = (options, controller = 'Shows', additionalFields = []) => {
    const supported = new Set([...itemFields, ...additionalFields].map(value => value.toLowerCase()));
    const missing = options.fields.find(value => !supported.has(value.toLowerCase()));
    if (missing) throw httpError(501, `${controller} item field '${missing}' is not implemented.`);
  };
  const nullableEnum = (context, name, names) => {
    const value = query(context, name);
    if (value === undefined || value === '') return undefined;
    try { return enumName(value, names); }
    catch { throw new BindingError(name, `The value '${value}' is not valid.`); }
  };
  const dateTime = (context, name) => {
    const value = query(context, name);
    if (value === undefined || value.trim() === '') return undefined;
    // MVC's default DateTime binder uses invariant culture and leaves values
    // without an explicit zone as wall-clock (Kind.Unspecified). Repository
    // comparisons use those ticks directly, so do not apply the host offset.
    const parsed = parseInvariantDate(value, { offsetMinutes: () => 0 });
    if (parsed == null) throw new BindingError(name, `The value '${value}' is not valid.`);
    return parsed;
  };
  async function updateTarget(context, message) {
    const user = await users.getUser(guid(context, 'userId', context.auth.UserId));
    if (!user) throw new HttpResult(404);
    if (!context.auth.IsAdministrator && (guidValue(user.Id, 'userId') !== context.auth.UserId || !user.EnableUserPreferenceAccess)) throw new HttpResult(403, message);
    return user;
  }
  async function currentSession(context) {
    const session = await sessions.logActivity(context.auth, { remoteEndPoint: context.remoteEndPoint });
    if (!session) throw httpError(404, 'Session not found.');
    return session.Id;
  }

  add('GET', '/Users/Public', context => users.listUsers({ publicOnly: true, startupWizardCompleted: Boolean(configuration.IsStartupWizardCompleted),
    deviceId: context.auth.IsAuthenticated ? context.auth.DeviceId : undefined, remoteEndPoint: context.remoteEndPoint }), { public: true });
  add('POST', '/Users/AuthenticateByName', context => {
    return authentication.login(validateUserBody('login', context.body), context.auth, { remoteEndPoint: context.remoteEndPoint });
  }, { public: true, body: true, allowForm: true });
  add('POST', '/Users/{userId}/Authenticate', async context => {
    const user = await users.getUser(guid(context, 'userId'));
    if (!user) return new HttpResult(404, 'User not found');
    const pw = query(context, 'pw');
    if (!pw) throw new BindingError('pw', 'The pw field is required.');
    return authentication.login({ Username: user.Username, Pw: pw }, context.auth, { remoteEndPoint: context.remoteEndPoint });
  }, { public: true });
  add('GET', '/Users/Me', context => context.auth.User ? users.getUserDto(context.auth.User) : new HttpResult(400));
  add('GET', '/Users', context => users.listUsers({ isHidden: boolean(context, 'isHidden'), isDisabled: boolean(context, 'isDisabled'), remoteEndPoint: context.remoteEndPoint }));
  add('POST', '/Users/New', async context => {
    const body = validateUserBody('create', context.body);
    requireMember(body, 'Name');
    return users.createUser(body);
  }, { policy: 'RequiresElevation', body: true });
  add('POST', '/Users/{userId}/Policy', async context => {
    const body = validateUserBody('policy', context.body);
    await users.updatePolicy(guid(context, 'userId'), body, { currentToken: context.auth.Token });
    return noContent();
  }, { policy: 'RequiresElevation', body: true });
  add('POST', ['/Users/Configuration', '/Users/{userId}/Configuration'], async context => {
    const body = validateUserBody('configuration', context.body);
    await users.updateConfiguration((await updateTarget(context, 'User configuration update not allowed')).Id, body);
    return noContent();
  }, { body: true });
  add('POST', ['/Users/Password', '/Users/{userId}/Password'], async context => {
    const body = validateUserBody('password', context.body);
    const user = await updateTarget(context, 'User is not allowed to update the password.');
    if (member(body, 'ResetPassword') === true) await users.changePassword(user.Id, '');
    else {
      const explicitId = context.params.userId ?? query(context, 'userId');
      if (!context.auth.IsAdministrator || explicitId && guidValue(explicitId, 'userId') === context.auth.UserId) {
        const verified = await users.authenticateUser(user.Username, member(body, 'CurrentPw') ?? '', { remoteEndPoint: context.remoteEndPoint, isUserSession: false });
        if (!verified) return new HttpResult(403, 'Invalid user or password entered.');
      }
      await users.changePassword(user.Id, member(body, 'NewPw') ?? '');
      await authentication.revokeUserTokens(user.Id, context.auth.Token);
    }
    return noContent();
  }, { body: true });
  add('POST', ['/Users', '/Users/{userId}'], async context => {
    const body = validateUserBody('update', context.body);
    await users.updateUser((await updateTarget(context, 'User update not allowed.')).Id, body);
    return noContent();
  }, { body: true });
  add('GET', '/Users/{userId}', async context => {
    const user = await users.getUser(guid(context, 'userId'));
    return user ? users.getUserDto(user) : new HttpResult(404, 'User not found');
  }, { policy: 'IgnoreParentalControl' });
  add('DELETE', '/Users/{userId}', async context => {
    const id = guid(context, 'userId');
    const user = await users.getUser(id);
    if (!user) return new HttpResult(404);
    await authentication.revokeUserTokens(id);
    if (playlists) await playlists.removeForDeletedUser(user);
    await users.deleteUser(id);
    return noContent();
  }, { policy: 'RequiresElevation' });
  add('GET', '/Auth/Providers', () => [{ Name: 'Default', Id: AUTHENTICATION_PROVIDER }], { policy: 'RequiresElevation' });
  add('GET', '/Auth/PasswordResetProviders', () => [{ Name: 'Default Password Reset Provider', Id: PASSWORD_RESET_PROVIDER }], { policy: 'RequiresElevation' });

  add('GET', '/Devices', context => {
    let userId = bindDevicesUserId(context);
    if (!userId || /^0{32}$/.test(userId)) userId = context.auth.UserId;
    return devices.list(userId);
  }, { policy: 'RequiresElevation' });
  add('GET', '/Devices/Info', async context => await devices.info(requiredDeviceId(context)) ?? notFound(), { policy: 'RequiresElevation' });
  add('GET', '/Devices/Options', async context => await devices.options(requiredDeviceId(context)) ?? notFound(), { policy: 'RequiresElevation' });
  add('POST', '/Devices/Options', async context => {
    await devices.updateOptions(requiredDeviceId(context), context.body.CustomName);
    return noContent();
  }, { policy: 'RequiresElevation', body: true, bindBody: validateDeviceOptionsBody, bodyParameter: 'deviceOptions' });
  add('DELETE', '/Devices', async context => {
    const ids = deviceIds(context);
    if (ids.includes('')) throw httpError(400, 'Invalid device id.');
    return await devices.delete(ids) ? noContent() : badRequest();
  }, { policy: 'RequiresElevation' });

  add('GET', ['/Items', '/Users/{userId}/Items'], async context => {
    try {
      const result = await library.queryItems(itemQuery(context), {
        user: await requestUser(context, { required: false, currentEmbyUser: true }), isApiKey: context.auth.IsApiKey,
        embyClient: context.embyClient,
      });
      if (context.embyClient) {
        delete result.StartIndex;
        if (boolean(context, 'enableTotalRecordCount') === false) result.TotalRecordCount = 0;
      }
      return result;
    } catch (error) {
      if (context.embyClient && error instanceof BindingError && Object.hasOwn(error.errors, 'wassearched')) {
        return embyTextResponse(500, `String '${query(context, 'wasSearched')}' was not recognized as a valid Boolean.`);
      }
      if (error.status === 401 && error.message.includes(' is not permitted to access Library ')) return new HttpResult(401, error.message);
      throw error;
    }
  });
  add('GET', '/Shows/Upcoming', async context => {
    const input = {
      ...controllerDtoOptions(context),
      parentid: guid(context, 'parentId'),
      startindex: integer(context, 'startIndex'),
      limit: integer(context, 'limit'),
    };
    const user = await optionalRequestUser(context);
    requireSupportedDtoFields(input);
    return library.queryUpcomingEpisodes(input, { user });
  });
  add('GET', '/Shows/NextUp', async context => {
    const input = {
      ...controllerDtoOptions(context),
      seriesId: guid(context, 'seriesId'),
      parentId: guid(context, 'parentId'),
      startIndex: integer(context, 'startIndex'),
      limit: integer(context, 'limit'),
      nextUpDateCutoff: dateTime(context, 'nextUpDateCutoff'),
      enableTotalRecordCount: boolean(context, 'enableTotalRecordCount', true),
      enableResumable: boolean(context, 'enableResumable', true),
      enableRewatching: boolean(context, 'enableRewatching', false),
    };
    const user = await requestUser(context);
    requireSupportedDtoFields(input);
    return library.queryNextUpEpisodes(input, { user });
  });
  add('GET', '/Shows/{seriesId}/Episodes', async context => {
    const input = {
      ...controllerDtoOptions(context),
      seriesId: guid(context, 'seriesId'),
      seasonId: guid(context, 'seasonId'),
      season: integer(context, 'season'),
      isMissing: boolean(context, 'isMissing'),
      adjacentTo: guid(context, 'adjacentTo'),
      startItemId: guid(context, 'startItemId'),
      startIndex: integer(context, 'startIndex'),
      limit: integer(context, 'limit'),
      sortBy: nullableEnum(context, 'sortBy', itemSortNames),
    };
    const user = await optionalRequestUser(context);
    requireSupportedDtoFields(input);
    try {
      return await library.querySeriesEpisodes(input, { user, isApiKey: context.auth.IsApiKey });
    } catch (error) {
      if (error.showsNotFound) return new HttpResult(404, error.message);
      throw error;
    }
  });
  add('GET', '/Shows/{seriesId}/Seasons', async context => {
    const input = {
      ...controllerDtoOptions(context),
      seriesId: guid(context, 'seriesId'),
      isSpecialSeason: boolean(context, 'isSpecialSeason'),
      isMissing: boolean(context, 'isMissing'),
      adjacentTo: guid(context, 'adjacentTo'),
    };
    const user = await optionalRequestUser(context);
    try {
      return await library.querySeriesSeasons(input, { user,
        beforeProjection: () => requireSupportedDtoFields(input) });
    } catch (error) {
      if (error.showsNotFound) return new HttpResult(404);
      throw error;
    }
  });
  add('GET', ['/Artists/{itemId}/Similar', '/Items/{itemId}/Similar', '/Albums/{itemId}/Similar',
    '/Shows/{itemId}/Similar', '/Movies/{itemId}/Similar', '/Trailers/{itemId}/Similar'], async context => {
    const input = {
      ...controllerDtoOptions(context),
      itemId: guid(context, 'itemId'),
      excludeArtistIds: commaGuids(context, 'excludeArtistIds'),
      limit: integer(context, 'limit'),
    };
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.request.once('aborted', abort);
    context.signal?.addEventListener('abort', abort, {once:true});
    try {
      if (context.request.aborted || context.signal?.aborted) abort();
      controller.signal.throwIfAborted();
      const user = await optionalRequestUser(context);
      controller.signal.throwIfAborted();
      return await library.querySimilarItems(input, { user,
        signal: controller.signal,
        beforeProjection: () => requireSupportedDtoFields(input) });
    } catch (error) {
      if (error.showsNotFound) return new HttpResult(404);
      throw error;
    } finally { context.request.removeListener('aborted', abort); context.signal?.removeEventListener('abort', abort); }
  });
  const instantMix = async (context, { genreName, queryId = false, playlistOnly = false } = {}) => {
    if (queryId && query(context, 'id') === '') throw new BindingError('id', "The value '' is invalid.");
    const input = {
      ...controllerDtoOptions(context), limit: integer(context, 'limit'),
      ...(genreName === undefined ? { itemId: guid(context, queryId ? 'id' : 'itemId') } : { genreName }),
    };
    if (queryId && input.itemId === undefined) throw new BindingError('id', 'The id field is required.');
    const user = await optionalRequestUser(context);
    try { return await library.queryInstantMix(input, { user, playlistOnly,
      beforeProjection: () => requireSupportedDtoFields(input, 'InstantMix') }); }
    catch (error) { if (error.instantMixNotFound) return notFound(); throw error; }
  };
  add('GET', ['/Songs/{itemId}/InstantMix', '/Albums/{itemId}/InstantMix',
    '/Artists/{itemId}/InstantMix', '/Items/{itemId}/InstantMix'], context => instantMix(context));
  add('GET', '/Playlists/{itemId}/InstantMix', context => instantMix(context, { playlistOnly: true }));
  add('GET', '/MusicGenres/{name}/InstantMix', context => instantMix(context, {
    genreName: requireMember(context.params, 'name'),
  }));
  add('GET', ['/Artists/InstantMix', '/MusicGenres/InstantMix'], context => instantMix(context, { queryId: true }));
  add('GET', '/Items/Filters', async context => {
    const input = {
      parentId: guid(context, 'parentId'),
      includeItemTypes: commaEnums(context, 'includeItemTypes', itemKinds).map(String),
      mediaTypes: commaEnums(context, 'mediaTypes', mediaTypes).map(String),
    };
    return library.queryItemFilters(input, { user: await optionalRequestUser(context), legacy: true });
  });
  add('GET', '/Items/Filters2', async context => {
    const input = {
      parentId: guid(context, 'parentId'),
      includeItemTypes: commaEnums(context, 'includeItemTypes', itemKinds).map(String),
      recursive: boolean(context, 'recursive'),
    };
    for (const name of ['isAiring', 'isMovie', 'isSports', 'isKids', 'isNews', 'isSeries']) {
      input[name] = boolean(context, name);
    }
    return library.queryItemFilters(input, { user: await optionalRequestUser(context) });
  });
  add('GET', '/Studios', async context => {
    const input = {
      ...controllerDtoOptions(context),
      parentId: guid(context, 'parentId'),
      startIndex: integer(context, 'startIndex'), limit: integer(context, 'limit'),
      includeItemTypes: commaEnums(context, 'includeItemTypes', itemKinds).map(String),
      excludeItemTypes: commaEnums(context, 'excludeItemTypes', itemKinds).map(String),
      isFavorite: boolean(context, 'isFavorite'), searchTerm: query(context, 'searchTerm'),
      nameStartsWith: query(context, 'nameStartsWith'),
      nameStartsWithOrGreater: query(context, 'nameStartsWithOrGreater'), nameLessThan: query(context, 'nameLessThan'),
      enableTotalRecordCount: boolean(context, 'enableTotalRecordCount', true),
    };
    if (input.includeItemTypes.length && !input.fields.includes('ItemCounts')) input.fields.push('ItemCounts');
    const user = await optionalRequestUser(context);
    requireSupportedDtoFields(input, 'Studios', ['ItemCounts']);
    return library.queryNamedItems('Studio', input, { user });
  });
  add('GET', '/Studios/{name}', async context => library.getStudioDto(context.params.name,
    { user: await optionalRequestUser(context) }));
  const namedList = async (context, kind, { artist = false, albumArtists = false, autoMusicGenre = false } = {}) => {
    const input = {
      ...controllerDtoOptions(context, { userData: artist }),
      parentId: guid(context, 'parentId'), startIndex: integer(context, 'startIndex'), limit: integer(context, 'limit'),
      includeItemTypes: commaEnums(context, 'includeItemTypes', itemKinds).map(String),
      excludeItemTypes: commaEnums(context, 'excludeItemTypes', itemKinds).map(String),
      isFavorite: boolean(context, 'isFavorite'), searchTerm: query(context, 'searchTerm'),
      nameStartsWith: query(context, 'nameStartsWith'), nameStartsWithOrGreater: query(context, 'nameStartsWithOrGreater'),
      nameLessThan: query(context, 'nameLessThan'), enableTotalRecordCount: boolean(context, 'enableTotalRecordCount', true),
    };
    const allowed = new Set(['sortby', 'sortorder', ...(artist ? ['mincommunityrating', 'genres', 'genreids',
      'officialratings', 'tags', 'person', 'personids', 'persontypes', 'studios', 'studioids'] : [])]);
    try {
      input.namedQuery = parseQuery(new URLSearchParams([...context.query].filter(([key]) => allowed.has(key.toLowerCase()))),
        { allowNegativePaging: true });
      if (artist) {
        const filterNames = ['None', 'IsFolder', 'IsNotFolder', 'IsUnplayed', 'IsPlayed', 'IsFavorite', 'Unused',
          'IsResumable', 'Likes', 'Dislikes', 'IsFavoriteOrLikes'];
        const filters = commaEnums(context, 'filters', filterNames).map(String)
          .filter(name => !['None', 'Unused'].includes(name) && filterNames.includes(name));
        Object.assign(input.namedQuery, parseQuery({ filters }, { allowNegativePaging: true }));
        input.namedQuery.mediatypes = commaEnums(context, 'mediaTypes', mediaTypes).map(String);
        const values = [...context.query].filter(([key]) => key.toLowerCase() === 'years').map(([, value]) => value);
        input.namedQuery.years = (values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? []).map(value => {
          try {
            const year = integerValue(value, 'years');
            if (year !== undefined) return year;
          } catch { /* Int32Converter wraps invalid values outside the binder's FormatException catch. */ }
          throw httpError(400, 'Error processing request.');
        });
      }
    } catch (error) {
      if (error instanceof BindingError) throw error;
      if (error.status === 400) throw httpError(400, 'Error processing request.');
      throw error;
    }
    if (input.includeItemTypes.length && !input.fields.includes('ItemCounts')) input.fields.push('ItemCounts');
    const user = await optionalRequestUser(context);
    requireSupportedDtoFields(input, 'Named items', ['ItemCounts']);
    return library.queryNamedItems(kind, input, { user, autoMusicGenre,
      ...(artist ? { itemValueTypes: albumArtists ? [1] : [0] } : {}) });
  };
  add('GET', '/Genres', context => namedList(context, 'Genre', { autoMusicGenre: true }));
  add('GET', '/MusicGenres', context => namedList(context, 'MusicGenre'));
  add('GET', '/Artists', context => namedList(context, 'MusicArtist', { artist: true }));
  add('GET', '/Artists/AlbumArtists', context => namedList(context, 'MusicArtist', { artist: true, albumArtists: true }));
  for (const [route, kind] of [['Genres', 'Genre'], ['MusicGenres', 'MusicGenre'], ['Artists', 'MusicArtist']]) {
    add('GET', `/${route}/{name}`, async context => await library.getNamedItemDto(kind, context.params.name,
      { user: await optionalRequestUser(context) }) ?? notFound());
  }
  add('GET', ['/Items/Latest', '/Users/{userId}/Items/Latest'], async context => {
    const input = {
      ...controllerDtoOptions(context),
      parentId: guid(context, 'parentId'),
      includeItemTypes: commaEnums(context, 'includeItemTypes', itemKinds).map(String),
      isPlayed: boolean(context, 'isPlayed'),
      limit: integer(context, 'limit', 20),
      groupItems: boolean(context, 'groupItems', true),
    };
    const user = await requestUser(context);
    requireSupportedDtoFields(input, 'Latest media');
    return library.queryLatestItems(input, { user });
  });
  add('GET', ['/UserItems/Resume', '/Users/{userId}/Items/Resume'], async context => {
    const user = await requestUser(context);
    const excludeActiveSessions = boolean(context, 'excludeActiveSessions', false);
    let activeItemIds = [];
    if (excludeActiveSessions) {
      const target = String(user.Id).replaceAll('-', '').toLowerCase();
      activeItemIds = (await sessions.getSessions(context.auth))
        .filter(session => String(session.UserId ?? '').replaceAll('-', '').toLowerCase() === target)
        .map(session => session.NowPlayingItem?.Id).filter(Boolean);
    }
    const resumeQuery = bindItemFields(context, [...context.query.entries()].filter(([name]) => name.toLowerCase() !== 'excludeactivesessions'));
    return library.queryResumeItems(resumeQuery, { user, activeItemIds });
  });
  add('GET', ['/UserViews', '/Users/{userId}/Views'], async context => library.getViews({ includeHidden: boolean(context, 'includeHidden', false),
    includeExternalContent: boolean(context, 'includeExternalContent'), presetViews: bindUserViewPresets(context.query) }, { user: await requestUser(context) }));
  add('GET', ['/Items/Root', '/Users/{userId}/Items/Root'], async context => library.getRoot({ user: await requestUser(context) }));
  add('GET', '/Items/{itemId}/Ancestors', async context => {
    try { return await library.getAncestors(guid(context, 'itemId'), { user: await optionalRequestUser(context) }); }
    catch (error) { if (error.status === 404) return notFound(); throw error; }
  });
  add('GET', ['/Items/{itemId}', '/Users/{userId}/Items/{itemId}'], async context => {
    try {
      const itemId = guid(context, 'itemId'), user = await requestUser(context, { required: false });
      if (!user) throw httpError(400, 'Error processing request.');
      return /^0{32}$/.test(itemId) ? await library.getRoot({ user }) : await library.getItem(itemId, { user });
    } catch (error) { if (error.status === 404) return notFound(); throw error; }
  });
  for (const method of ['GET', 'POST']) add(method, ['/UserItems/{itemId}/UserData', '/Users/{userId}/Items/{itemId}/UserData'], async context => {
    try {
      const user = await requestUser(context);
      if (!context.auth.IsAdministrator && !user.EnableUserPreferenceAccess) throw new HttpResult(403,
        `User is not allowed to ${method === 'GET' ? 'view' : 'update'} this item user data.`);
      return await (method === 'GET' ? userData.get(user.Id, guid(context, 'itemId')) : userData.update(user.Id, guid(context, 'itemId'), context.body));
    } catch (error) { if (error.status === 404) return notFound(); throw error; }
  }, { body: method === 'POST', bindBody: bindUserDataBody, bodyParameter: 'userDataDto' });
  for (const method of ['POST', 'DELETE']) {
    add(method, ['/UserFavoriteItems/{itemId}', '/Users/{userId}/FavoriteItems/{itemId}'], async context => userData.setFavorite((await requestUser(context)).Id, guid(context, 'itemId'), method === 'POST'));
    add(method, ['/UserPlayedItems/{itemId}', '/Users/{userId}/PlayedItems/{itemId}'], async context => {
      const datePlayed = method === 'POST' ? parsePlayedDate(context.query) : undefined;
      const user = await requestUser(context);
      const itemId = guid(context, 'itemId');
      await library.getItemRecord(itemId, { user });
      const session = await sessions.logActivity({ ...context.auth, User: user, UserId: guidValue(user.Id, 'userId') }, { remoteEndPoint: context.remoteEndPoint });
      const dto = await userData.setPlayed(user.Id, itemId, method === 'POST', { datePlayed });
      for (const additional of session.AdditionalUsers) await userData.setPlayed(additional.UserId, itemId, method === 'POST', { datePlayed });
      return dto;
    });
    add(method, ['/UserItems/{itemId}/Rating', '/Users/{userId}/Items/{itemId}/Rating'], async context => userData.setLikes((await requestUser(context)).Id, guid(context, 'itemId'), method === 'DELETE' ? null : boolean(context, 'likes', null)));
  }

  add('GET', '/Sessions', context => {
    const options = bindSessionsQuery(context);
    let { controllableByUserId } = options;
    if (controllableByUserId && /^0{32}$/.test(controllableByUserId)) controllableByUserId = context.auth.UserId;
    if (controllableByUserId && controllableByUserId !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
    return sessions.getSessions(context.auth, { ...options, controllableByUserId });
  });
  add('POST', '/Sessions/Capabilities/Full', async context => {
    const currentId = await currentSession(context);
    const requestedId = query(context, 'id');
    await sessions.reportCapabilities(requestedId?.trim() ? requestedId : currentId, context.body, { controllingSessionId: currentId, embyClient: context.embyClient });
    return noContent();
  }, { body: true, bindBody: validateClientCapabilitiesDto });
  add('POST', '/Sessions/Capabilities', async context => {
    const currentId = await currentSession(context);
    const requestedId = query(context, 'id');
    const list = (name, names) => context.embyClient ? query(context, name)?.split(',').filter(Boolean) ?? [] : commaEnums(context, name, names);
    await sessions.reportCapabilities(requestedId?.trim() ? requestedId : currentId, { PlayableMediaTypes: list('playableMediaTypes', mediaTypes),
      SupportedCommands: list('supportedCommands', generalCommands), SupportsMediaControl: boolean(context, 'supportsMediaControl', false),
      SupportsPersistentIdentifier: boolean(context, 'supportsPersistentIdentifier', true) }, { controllingSessionId: currentId, embyClient: context.embyClient });
    return noContent();
  });
  add('POST', '/Sessions/Logout', async context => { await authentication.logout(context.auth.Token); return noContent(); });
  for (const [method, action] of [['POST', 'addUser'], ['DELETE', 'removeUser']]) add(method, '/Sessions/{sessionId}/User/{userId}', async context => {
    await sessions[action](context.params.sessionId, guid(context, 'userId'), { controllingSessionId: await currentSession(context) });
    return noContent();
  });
  for (const [suffix, method] of [['', 'playbackStart'], ['/Progress', 'playbackProgress'], ['/Stopped', 'playbackStopped']]) {
    add('POST', `/Sessions/Playing${suffix}`, async context => {
      const playSessionId = member(context.body, 'PlaySessionId');
      if (method === 'playbackStopped' && typeof playSessionId === 'string' && playSessionId.trim()) await hls?.stop(context.auth.DeviceId, playSessionId);
      await sessions[method](await currentSession(context), context.body); return noContent();
    }, { body: true });
  }
}
