import { BindingError, HttpResult, commaGuidValues, guidValue, integerValue, member, noContent, queryValue } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';
import { enumName, mediaTypes } from '../sessions/binding.js';
import { clrTrim } from '../metadata/whitespace.js';

const zeroGuid = '00000000000000000000000000000000';

const guid = { type: 'guid', clrType: 'System.Guid', preserveEmptyGuid: true };
const permissions = 'MediaBrowser.Model.Entities.PlaylistUserPermissions';
const createDto = 'Jellyfin.Api.Models.PlaylistDtos.CreatePlaylistDto';
const createRoot = { type: 'object', reference: createDto, clrType: createDto, nullable: true };
const createSchema = { definitions: {
  [createDto]: { defaults: { Name: null, Ids: [], UserId: null, MediaType: null, Users: [], IsPublic: true },
    required: ['Name', 'Ids', 'Users'], jsonRequired: ['Name'], fields: {
      Name: { type: 'string', clrType: 'System.String', nullable: true },
      Ids: { type: 'array', clrType: 'System.Collections.Generic.IReadOnlyList`1[System.Guid]', item: guid,
        delimiter: ',', converterArrayRoot: true, nullable: true },
      UserId: { ...guid, nullable: true },
      MediaType: { type: 'enum', clrType: 'Jellyfin.Data.Enums.MediaType', nullable: true,
        values: Object.fromEntries(mediaTypes.map((name, index) => [name, index])) },
      Users: { type: 'array', clrType: 'System.Collections.Generic.IReadOnlyList`1[' + permissions + ']', nullable: true,
        item: { type: 'object', reference: permissions, clrType: permissions } },
      IsPublic: { type: 'boolean', clrType: 'System.Boolean' },
    } },
  [permissions]: { defaults: { UserId: zeroGuid, CanEdit: false }, fields: {
    UserId: guid, CanEdit: { type: 'boolean', clrType: 'System.Boolean' },
  } },
} };

function bindCreateBody(body, source) {
  const options = { schema: createSchema, root: createRoot, source };
  return validateJsonModel(bindJsonModel(body, options), options);
}

function bindCreateQuery(query) {
  const name = queryValue(query, 'name'), userId = queryValue(query, 'userId');
  const rawType = queryValue(query, 'mediaType');
  let mediaType;
  if (rawType) try { mediaType = enumName(rawType, mediaTypes); } catch { /* Native nullable enum binding leaves it unset. */ }
  return { name: name && clrTrim(name) ? name : undefined, ids: commaGuidValues(query, 'ids'),
    userId: guidValue(userId && clrTrim(userId), 'userId'), mediaType };
}

function queryArray(context, name, convert = value => value) {
  const values = [...context.query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
  const entries = values.length > 1 ? values : values[0]?.split(',') ?? [];
  return entries.filter(entry => entry !== '').map(entry => convert(entry, name));
}

function nullableBoolean(body, name) {
  const value = member(body, name);
  if (value != null && typeof value !== 'boolean') throw new BindingError(name, `The ${name} field must be a boolean.`);
  return value;
}

function nullableIds(body) {
  const value = member(body, 'Ids');
  if (value == null) return value;
  if (typeof value === 'string') {
    const result = [];
    for (const entry of value.split(',').filter(Boolean)) {
      try {
        const parsed = guidValue(entry.trim(), 'Ids');
        if (parsed !== undefined) result.push(parsed);
      }
      catch { /* The native delimited converter ignores malformed string entries. */ }
    }
    return result;
  }
  if (!Array.isArray(value)) throw new BindingError('Ids', 'The Ids field must be an array or comma-delimited string.');
  return value.map(entry => entry == null ? zeroGuid : guidValue(entry, 'Ids'));
}

function nullableUsers(body) {
  const value = member(body, 'Users');
  if (value == null) return value;
  if (!Array.isArray(value)) throw new BindingError('Users', 'The Users field must be an array.');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BindingError(`Users[${index}]`, 'The playlist user must be an object.');
    }
    const rawId = member(entry, 'UserId');
    const rawEdit = member(entry, 'CanEdit');
    if (rawEdit != null && typeof rawEdit !== 'boolean') {
      throw new BindingError(`Users[${index}].CanEdit`, 'The CanEdit field must be a boolean.');
    }
    return { UserId: rawId == null ? zeroGuid : guidValue(rawId, `Users[${index}].UserId`), CanEdit: rawEdit ?? false };
  });
}

function updateBody(body) {
  const Name = member(body, 'Name');
  if (Name != null && typeof Name !== 'string') throw new BindingError('Name', 'The Name field must be a string.');
  return { name: Name, ids: nullableIds(body), users: nullableUsers(body), isPublic: nullableBoolean(body, 'IsPublic') };
}

function updateUserBody(body) {
  return { canEdit: nullableBoolean(body, 'CanEdit') };
}

export function registerPlaylistRoutes(add, { playlists, users }) {
  const service = () => {
    if (!playlists) throw Object.assign(new Error('Managed playlists require persistent application paths.'), { status: 501 });
    return playlists;
  };
  async function effectiveUser(context, requested) {
    let id = requested;
    if (!id || id === zeroGuid) id = context.auth.UserId;
    if (!id || id === zeroGuid) throw new HttpResult(403);
    if (id !== context.auth.UserId && !context.auth.IsAdministrator) throw new HttpResult(403);
    const user = await users.getUser(id);
    if (!user) throw new HttpResult(404);
    return user;
  }
  const currentUser = context => {
    if (!context.auth.User) throw new HttpResult(403);
    return context.auth.User;
  };

  add('POST', '/Playlists', async context => {
    const query = context.queryInput, body = context.body;
    const user = await effectiveUser(context, query.userId ?? body?.UserId);
    const name = query.name ?? body?.Name;
    if (name == null) throw Object.assign(new Error('A playlist name is required.'), { status: 500 });
    return service().create({ name, ids: query.ids.length ? query.ids : body?.Ids ?? [], user,
      mediaType: query.mediaType ?? body?.MediaType, users: body?.Users ?? [], isPublic: body?.IsPublic ?? false });
  }, { body: true, optionalBody: true, bindBody: bindCreateBody, bindQuery: bindCreateQuery });

  add('GET', '/Playlists/{playlistId}', context => service().get(
    guidValue(context.params.playlistId, 'playlistId'), { user: currentUser(context) }));

  add('POST', '/Playlists/{playlistId}', async context => {
    await service().update(guidValue(context.params.playlistId, 'playlistId'), {
      user: currentUser(context), ...updateBody(context.body)
    });
    return noContent();
  }, { body: true, bodyParameter: 'updatePlaylistRequest' });

  add('GET', '/Playlists/{playlistId}/Users', context => service().getUsers(
    guidValue(context.params.playlistId, 'playlistId'), { user: currentUser(context) }));

  add('GET', '/Playlists/{playlistId}/Users/{userId}', context => service().getUser(
    guidValue(context.params.playlistId, 'playlistId'), guidValue(context.params.userId, 'userId'),
    { user: currentUser(context) }));

  add('POST', '/Playlists/{playlistId}/Users/{userId}', async context => {
    await service().updateUser(guidValue(context.params.playlistId, 'playlistId'),
      guidValue(context.params.userId, 'userId'), { user: currentUser(context), ...updateUserBody(context.body) });
    return noContent();
  }, { body: true, bodyParameter: 'updatePlaylistUserRequest' });

  add('DELETE', '/Playlists/{playlistId}/Users/{userId}', async context => {
    await service().removeUser(guidValue(context.params.playlistId, 'playlistId'),
      guidValue(context.params.userId, 'userId'), { user: currentUser(context) });
    return noContent();
  });

  add('POST', '/Playlists/{playlistId}/Items', async context => {
    const userId = guidValue(queryValue(context.query, 'userId'), 'userId');
    const user = await effectiveUser(context, userId);
    const position = integerValue(queryValue(context.query, 'position'), 'position');
    await service().add(guidValue(context.params.playlistId, 'playlistId'),
      queryArray(context, 'ids', guidValue), { user, position });
    return noContent();
  });

  add('DELETE', '/Playlists/{playlistId}/Items', async context => {
    await service().remove(guidValue(context.params.playlistId, 'playlistId'), queryArray(context, 'entryIds'), {
      user: context.auth.User, isApiKey: context.auth.IsApiKey
    });
    return noContent();
  });

  add('POST', '/Playlists/{playlistId}/Items/{itemId}/Move/{newIndex}', async context => {
    await service().move(guidValue(context.params.playlistId, 'playlistId'), context.params.itemId,
      integerValue(context.params.newIndex, 'newIndex'), { user: currentUser(context) });
    return noContent();
  });

  add('GET', '/Playlists/{playlistId}/Items', async context => {
    const user = await effectiveUser(context, guidValue(queryValue(context.query, 'userId'), 'userId'));
    const startIndex = integerValue(queryValue(context.query, 'startIndex'), 'startIndex');
    const limit = integerValue(queryValue(context.query, 'limit'), 'limit');
    const projectionNames = new Set(['fields', 'enableimages', 'enableuserdata', 'imagetypelimit', 'enableimagetypes']);
    const dtoOptions = Object.fromEntries([...context.query].filter(([name]) => projectionNames.has(name.toLowerCase())));
    return service().getItems(guidValue(context.params.playlistId, 'playlistId'), {
      user, startIndex, limit, dtoOptions
    });
  });

}
