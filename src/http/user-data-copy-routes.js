import { BindingError, HttpResult, guidValue, noContent } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { copyUserData, userDataCopyOptions } from '../users/user-data-copy.js';
import { embyTextResponse } from './client-protocol.js';

const string = { type: 'string', clrType: 'System.String', nullable: true };
const array = { type: 'array', clrType: 'System.String[]', nullable: false, item: string };
const schema = { definitions: { UserDataCopy: {
  defaults: { ToUserIds: [], CopyOptions: [] }, fields: { ToUserIds: array, CopyOptions: array },
} } };
const root = { type: 'object', reference: 'UserDataCopy', clrType: 'UserDataCopy' };
function guid(value) {
  try { return guidValue(value, 'userId'); }
  catch (error) {
    if (!(error instanceof BindingError)) throw error;
    throw new HttpResult(500, 'Unrecognized Guid format.', { text: true });
  }
}

export function registerUserDataCopyRoutes(add, services) {
  add('GET', '/Users/CopyDataOptions', () => ({ DataOptions: userDataCopyOptions }), { policy: 'RequiresElevation' });
  add('POST', '/Users/{userId}/CopyData', async context => {
    const body = context.body;
    try { await copyUserData(services, guid(context.params.userId), body.ToUserIds.map(guid), body.CopyOptions); }
    catch (error) {
      if (error instanceof HttpResult) return embyTextResponse(error.status, error.body);
      if (error.status === 500) return embyTextResponse(500, error.message);
      throw error;
    }
    return noContent();
  }, { policy: 'RequiresElevation', body: true, bindBody: (body, source) => bindJsonModel(body, { schema, root, source }) });
}
