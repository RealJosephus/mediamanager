import { BindingError } from './binding.js';
import { bindJsonModel } from './json-model-binding.js';
import { jsonDateTimeUtcTicks } from './json-date-time.js';
import { formatUtcTicks } from '../syncplay/time.js';

const nullable = (type, clrType) => ({ type, clrType: `System.${clrType}`, nullable: true });
const fields = {
  Rating: nullable('double', 'Double'), PlayedPercentage: nullable('double', 'Double'),
  UnplayedItemCount: nullable('integer', 'Int32'), PlaybackPositionTicks: nullable('long', 'Int64'),
  PlayCount: nullable('integer', 'Int32'), IsFavorite: nullable('boolean', 'Boolean'),
  Likes: nullable('boolean', 'Boolean'), LastPlayedDate: nullable('datetime', 'DateTime'),
  Played: nullable('boolean', 'Boolean'), Key: nullable('string', 'String'), ItemId: nullable('string', 'String')
};
const schema = { definitions: { UpdateUserItemDataDto: { defaults: Object.fromEntries(Object.keys(fields).map(name => [name, null])), fields } } };
const root = { type: 'object', clrType: 'MediaBrowser.Model.Dto.UpdateUserItemDataDto', reference: 'UpdateUserItemDataDto', nullable: true };

export function bindUserDataDto(body, source) {
  return bindJsonModel(body, { schema, root, source });
}

export function bindUserDataBody(body, source) {
  const dto = bindUserDataDto(body, source);
  if (dto == null) throw new BindingError('', 'A non-empty request body is required.');
  if (dto.LastPlayedDate != null) dto.LastPlayedDate = formatUtcTicks(jsonDateTimeUtcTicks(dto.LastPlayedDate));
  return dto;
}
