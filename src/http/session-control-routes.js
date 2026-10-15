import { BindingError, noContent, queryValue, integerValue, guidValue } from './binding.js';
import { enumName, generalCommands, playCommands, playstateCommands, itemKinds } from '../sessions/binding.js';
import { validateGeneralCommandBody, validateMessageCommandBody } from './session-command-binding.js';
import { bindLegacyPlaybackRequest } from './legacy-playback-binding.js';
import { emptyGuid, int64 } from '../sessions/user-data.js';

export function registerSessionControlRoutes(add, { sessions, hls }) {
  const query = (context, name) => queryValue(context.query, name);
  const required = (context, name) => {
    const value = query(context, name);
    if (value === undefined || !value.trim()) throw new BindingError(name, `The ${name} field is required.`);
    return value;
  };
  const enumeration = (value, name, names, fallback) => {
    if (value === undefined || value === '') return fallback;
    try {
      const result = enumName(value, names);
      if (typeof result === 'number') throw new BindingError(name, `The value '${value}' is invalid.`);
      return result;
    } catch (error) { if (error instanceof BindingError) throw error; throw new BindingError(name, `The value '${value}' is not valid.`); }
  };
  const requiredEnumeration = (context, name, names) => {
    const value = query(context, name);
    if (value === undefined) throw new BindingError(name, `The ${name} field is required.`);
    if (!value.trim()) throw new BindingError(name, `The value '${value}' is invalid.`);
    return enumeration(value, name, names);
  };
  const commaDelimitedGuids = (context, name) => {
    const values = [...context.query].filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
    const entries = values.length > 1 ? values : values[0]?.split(',').filter(Boolean) ?? [];
    return entries.flatMap(value => {
      try { return [guidValue(value.trim(), name)]; }
      catch { return []; }
    });
  };
  const ticks = (context, name) => {
    const value = query(context, name);
    if (value === undefined || !value.trim()) return null;
    try { return int64(value); } catch { throw new BindingError(name, `The value '${value}' is not valid.`); }
  };
  const current = context => sessions.logActivity(context.auth, { remoteEndPoint: context.remoteEndPoint });
  const nativeController = (command, id = emptyGuid) => ({ ...command, ControllingUserId: id });
  add('POST', '/Sessions/{sessionId}/Playing/{command}', async context => {
    const command = enumeration(context.params.command, 'command', playstateCommands);
    const seek = ticks(context, 'seekPositionTicks');
    await sessions.sendPlaystate(context.params.sessionId, { Command: command, SeekPositionTicks: seek, ControllingUserId: query(context, 'controllingUserId') }, { controllingSessionId: (await current(context)).Id });
    return noContent();
  });
  add('POST', '/Sessions/{sessionId}/Playing', async context => {
    const command = requiredEnumeration(context, 'playCommand', playCommands);
    const ids = commaDelimitedGuids(context, 'itemIds');
    const request = nativeController({ ItemIds: ids, PlayCommand: command, StartPositionTicks: ticks(context, 'startPositionTicks'),
      MediaSourceId: query(context, 'mediaSourceId'), AudioStreamIndex: integerValue(query(context, 'audioStreamIndex'), 'audioStreamIndex'),
      SubtitleStreamIndex: integerValue(query(context, 'subtitleStreamIndex'), 'subtitleStreamIndex'), StartIndex: integerValue(query(context, 'startIndex'), 'startIndex') });
    await sessions.sendPlay(context.params.sessionId, request, { controllingSessionId: (await current(context)).Id });
    return noContent();
  });
  for (const path of ['/Sessions/{sessionId}/Command/{command}', '/Sessions/{sessionId}/System/{command}']) add('POST', path, async context => {
    const name = enumeration(context.params.command, 'command', generalCommands);
    const controller = await current(context);
    await sessions.sendCommand(context.params.sessionId, 'GeneralCommand', nativeController({ Name: name, Arguments: new Map() }, controller.UserId), { controllingSessionId: controller.Id });
    return noContent();
  });
  add('POST', '/Sessions/{sessionId}/Command', async context => {
    const controller = await current(context);
    await sessions.sendCommand(context.params.sessionId, 'GeneralCommand', nativeController(context.body, controller.UserId), { controllingSessionId: controller.Id });
    return noContent();
  }, { body: true, bindBody: validateGeneralCommandBody });
  add('POST', '/Sessions/{sessionId}/Viewing', async context => {
    const values = { itemId: query(context, 'itemId'), itemName: query(context, 'itemName'), itemType: query(context, 'itemType') };
    const errors = {};
    for (const name of ['itemId', 'itemName', 'itemType']) if (values[name] === undefined || name !== 'itemType' && values[name] === '') errors[name] = [`The ${name} field is required.`];
    let type;
    if (values.itemType !== undefined) {
      try { type = requiredEnumeration(context, 'itemType', itemKinds); }
      catch (error) { Object.assign(errors, error.errors); }
    }
    if (Object.keys(errors).length) {
      const error = new BindingError('', 'One or more validation errors occurred.');
      error.errors = errors;
      throw error;
    }
    const args = new Map([['ItemId', values.itemId], ['ItemName', values.itemName], ['ItemType', type]]);
    await sessions.sendCommand(context.params.sessionId, 'GeneralCommand', nativeController({ Name: 'DisplayContent', Arguments: args }), { controllingSessionId: (await current(context)).Id });
    return noContent();
  });
  add('POST', '/Sessions/{sessionId}/Message', async context => {
    const header = context.body.Header == null || !context.body.Header.trim() ? 'Message from Server' : context.body.Header;
    const argumentsMap = new Map([['Header', header], ['Text', context.body.Text]]);
    if (context.body.TimeoutMs != null) argumentsMap.set('TimeoutMs', context.body.TimeoutMs.toString());
    await sessions.sendCommand(context.params.sessionId, 'GeneralCommand', nativeController({ Name: 'DisplayMessage', Arguments: argumentsMap }), { controllingSessionId: (await current(context)).Id });
    return noContent();
  }, { body: true, bindBody: validateMessageCommandBody });
  add('POST', '/Sessions/Viewing', async context => {
    const itemId = guidValue(required(context, 'itemId'), 'itemId');
    const controller = await current(context);
    await sessions.reportViewing(query(context, 'sessionId') ?? controller.Id, itemId, { controllingSessionId: controller.Id });
    return noContent();
  });
  add('POST', '/Sessions/Playing/Ping', context => { hls?.ping(required(context, 'playSessionId'), null); return noContent(); });

  for (const [method, suffix, action, phase] of [['POST', '', 'playbackStart', 'start'], ['POST', '/Progress', 'playbackProgress', 'progress'], ['DELETE', '', 'playbackStopped', 'stop']]) {
    add(method, [`/PlayingItems/{itemId}${suffix}`, `/Users/{userId}/PlayingItems/{itemId}${suffix}`], async context => {
      const { info } = bindLegacyPlaybackRequest(context, phase);
      if (action === 'playbackStopped' && info.PlaySessionId?.trim()) await hls?.stop(context.auth.DeviceId, info.PlaySessionId);
      await sessions[action]((await current(context)).Id, info);
      return noContent();
    });
  }
}
