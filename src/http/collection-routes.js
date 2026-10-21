import { BindingError, booleanValue, commaGuidValues, guidValue, httpError, integerValue, noContent, notFound, queryValue, unauthorized } from './binding.js';
import { clrTrim } from '../metadata/whitespace.js';
import { enumName } from '../sessions/binding.js';
import { controllerItemFields } from './item-fields.js';

const emptyGuid = '00000000000000000000000000000000';

function creationIds(query) {
  const values = [...query].filter(([name]) => name.toLowerCase() === 'ids').map(([, value]) => value);
  return (values.length > 1 ? values : values[0]?.split(',').filter(value => value !== '') ?? []).map(clrTrim);
}

function bindValues(bindings) {
  const input = {}, errors = {};
  for (const [name, bind] of Object.entries(bindings)) {
    try { input[name] = bind(); }
    catch (error) { if (!(error instanceof BindingError)) throw error; Object.assign(errors, error.errors); }
  }
  if (Object.keys(errors).length) {
    const error = new BindingError('', 'Collection request binding failed.'); error.errors = errors; throw error;
  }
  return input;
}

function nullableQueryValue(query, name) {
  const value = queryValue(query, name);
  return value == null || clrTrim(value) === '' ? undefined : value;
}

export function registerCollectionRoutes(add, { collections, library, users }) {
  const service = () => {
    if (!collections) throw httpError(501, 'Collection management requires persistent application paths.');
    return collections;
  };
  add('GET', '/Items/{itemId}/Collections', async context => {
    const input = bindValues({
      itemId: () => guidValue(context.params.itemId, 'itemId'),
      userId: () => guidValue(nullableQueryValue(context.query, 'userId'), 'userId', context.auth.UserId),
      startIndex: () => integerValue(nullableQueryValue(context.query, 'startIndex'), 'startIndex', null),
      limit: () => integerValue(nullableQueryValue(context.query, 'limit'), 'limit', null),
    });
    let userId = input.userId;
    if (userId === emptyGuid) userId = context.auth.UserId;
    if (userId && userId !== context.auth.UserId && !context.auth.IsAdministrator) throw httpError(403, 'Forbidden');
    const user = userId && userId !== emptyGuid ? await users.getUser(userId) : null;
    if (!user) return unauthorized();
    const values = [...context.query].filter(([name]) => name.toLowerCase() === 'fields').map(([, value]) => value);
    const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
    const fields = entries.flatMap(value => {
      try { const field = enumName(clrTrim(value), controllerItemFields); return typeof field === 'string' ? [field] : []; }
      catch { return []; }
    });
    return await library.getItemCollections(input.itemId, { user, startIndex: input.startIndex, limit: input.limit, fields }) ?? notFound();
  });
  add('POST', '/Collections', async context => {
    const input = bindValues({
      ParentId: () => {
        const value = queryValue(context.query, 'parentId');
        return value == null || clrTrim(value) === '' ? null : guidValue(value, 'parentId');
      },
      IsLocked: () => {
        const value = queryValue(context.query, 'isLocked');
        if (value != null && clrTrim(value) === '') throw new BindingError('isLocked', `The value '${value}' is invalid.`);
        return booleanValue(value, 'isLocked', false);
      },
    });
    const name = queryValue(context.query, 'name');
    return service().withCreatedItem({ ...input, Name: name == null || clrTrim(name) === '' ? null : name,
      ItemIdList: creationIds(context.query), UserIds: [context.auth.UserId ?? emptyGuid] }, async item => {
      if (!library) throw httpError(501, 'Collection creation requires the native item DTO service.');
      const dto = await library.getItemDto(item);
      return { Id: dto.Id };
    });
  }, { policy: 'CollectionManagement' });

  for (const [method, action] of [['DELETE', 'remove'], ['POST', 'add']]) {
    add(method, '/Collections/{collectionId}/Items', async context => {
      const id = guidValue(context.params.collectionId, 'collectionId');
      await service()[action](id, commaGuidValues(context.query, 'ids'));
      return noContent();
    }, { policy: 'CollectionManagement' });
  }
}
