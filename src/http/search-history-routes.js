import { BindingError, guidValue, noContent } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { embyTextResponse } from './client-protocol.js';
import { clearSearchHistory, markSearchedItems } from '../sessions/search-history.js';

const schema = { definitions: { SearchedItems: { defaults: { Ids: null }, fields: { Ids: {
  type: 'array', nullable: true, clrType: 'System.String[]', item: { type: 'string', nullable: true, clrType: 'System.String' },
} } } } };
const root = { type: 'object', reference: 'SearchedItems', clrType: 'SearchedItems' };

export function registerSearchHistoryRoutes(add, services) {
  for (const clear of [false, true]) add('POST', '/Users/{userId}/' + (clear ? 'RecentlySearched/Delete' : 'SearchedItems'), async context => {
    try {
      const requested = guidValue(context.params.userId, 'userId');
      if (clear && requested !== context.auth.UserId && !context.auth.IsAdministrator) {
        return embyTextResponse(403, `User ${context.auth.User.Username} does not have access to ManageServer feature.`);
      }
      const owner = clear || context.auth.IsAdministrator ? requested : context.auth.UserId;
      if (clear) await clearSearchHistory(services, owner);
      else {
        if (context.body.Ids === null) return embyTextResponse(500, 'Object reference not set to an instance of an object.');
        const ids = context.body.Ids.map(id => guidValue(id, 'id'));
        await markSearchedItems(services, owner, ids);
      }
      return noContent();
    } catch (error) {
      if (error instanceof BindingError) return embyTextResponse(500, 'Unrecognized Guid format.');
      if (error.status === 500) return embyTextResponse(500, error.message);
      throw error;
    }
  }, clear ? {} : { body: true, bindBody: (body, source) => bindJsonModel(body, { schema, root, source }) });
}
