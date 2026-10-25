import { BindingError } from './binding.js';
import { bindJsonModel, validateJsonModel } from './json-model-binding.js';

function bodyBinding(type, field) {
  const schema = { definitions: { [type]: { defaults: { [field]: null }, required: [field], nonEmpty: [field], jsonRequired: [field],
    fields: { [field]: { type: 'string', clrType: 'System.String', nullable: true } } } } };
  const root = { type: 'object', reference: type, clrType: 'Jellyfin.Api.Models.UserDtos.' + type };
  return { body: true, bodyType: root.clrType, public: true, bindBody(body, source) {
    if (body == null) throw new BindingError('', 'A non-empty request body is required.');
    const result = bindJsonModel(body, { schema, root, source });
    try { return validateJsonModel(result, { schema, root }); }
    catch (error) { error.modelValidated = true; throw error; }
  } };
}

export function registerPasswordResetRoutes(add, { passwordResets, authentication }) {
  if (!passwordResets) return;
  add('POST', '/Users/ForgotPassword', context => {
    const socket = context.request.socket;
    const local = socket.localAddress == null && socket.remoteAddress == null || socket.localAddress === socket.remoteAddress;
    return passwordResets.start(context.body.EnteredUsername, local || authentication.isLocalNetwork(context.remoteEndPoint));
  }, { ...bodyBinding('ForgotPasswordDto', 'EnteredUsername'), bodyParameter: 'forgotPasswordRequest' });
  add('POST', '/Users/ForgotPassword/Pin', context => passwordResets.redeem(context.body.Pin), {
    ...bodyBinding('ForgotPasswordPinDto', 'Pin'), bodyParameter: 'forgotPasswordPinRequest'
  });
}
