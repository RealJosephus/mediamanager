import { BindingError } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { generalCommands } from '../sessions/binding.js';

const enumValues = names => Object.fromEntries(names.map((name, index) => [name, index]));
const emptyGuid = '00000000000000000000000000000000';
const schema = {
  definitions: {
    GeneralCommand: {
      defaults: { Name: 'MoveUp', ControllingUserId: emptyGuid, Arguments: new Map() },
      fields: {
        Name: { type: 'enum', clrType: 'MediaBrowser.Model.Session.GeneralCommandType', values: enumValues(generalCommands) },
        ControllingUserId: { type: 'guid', clrType: 'System.Guid', nullAsDefault: emptyGuid, preserveEmptyGuid: true },
        Arguments: {
          type: 'dictionary',
          clrType: 'System.Collections.Generic.Dictionary`2[System.String,System.String]',
          item: { type: 'string', clrType: 'System.String', nullable: true },
          nullAsDefault: new Map()
        }
      }
    },
    MessageCommand: {
      defaults: { Header: null, Text: null, TimeoutMs: null },
      fields: {
        Header: { type: 'string', clrType: 'System.String', nullable: true },
        Text: { type: 'string', clrType: 'System.String', nullable: true },
        TimeoutMs: { type: 'long', clrType: 'System.Int64', nullable: true }
      }
    }
  }
};
const generalRoot = { type: 'object', clrType: 'MediaBrowser.Model.Session.GeneralCommand', reference: 'GeneralCommand', nullable: true };
const messageRoot = { type: 'object', clrType: 'MediaBrowser.Model.Session.MessageCommand', reference: 'MessageCommand', nullable: true };

function bodyRequired(name) {
  const error = new BindingError('', 'A non-empty request body is required.');
  error.errors[name] = [`The ${name} field is required.`];
  return error;
}

function withRootRequired(name, bind) {
  try {
    const value = bind();
    if (value == null) throw bodyRequired(name);
    return value;
  } catch (error) {
    if (error instanceof BindingError && !Object.hasOwn(error.errors, name)) error.errors[name] = [`The ${name} field is required.`];
    throw error;
  }
}

export function bindGeneralCommandDto(body, source) {
  return bindJsonModel(body, { schema, root: generalRoot, source });
}

export function validateGeneralCommandBody(body, source) {
  return withRootRequired('command', () => bindGeneralCommandDto(body, source));
}

export function bindMessageCommandDto(body, source) {
  return bindJsonModel(body, { schema, root: messageRoot, source });
}

export function validateMessageCommandBody(body, source) {
  const value = withRootRequired('command', () => bindMessageCommandDto(body, source));
  if (value.Text == null || !value.Text.trim()) throw new BindingError('Text', 'The Text field is required.');
  return value;
}
