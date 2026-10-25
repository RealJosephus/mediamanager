import { bindJsonModel } from './json-model-binding.js';
import { BindingError } from './binding.js';
import { formatUtcTicks } from '../syncplay/time.js';
import { jsonDateTimeUtcTicks } from './json-date-time.js';

export function programsBodyBinding({ sortNames, fields: itemFields, imageTypes }) {
  const scalar = (type, clrType) => ({ type, clrType: 'System.' + clrType, nullable: true });
  const enumeration = (clrType, names) => ({ type: 'enum', clrType, nullable: false,
    values: Object.fromEntries(names.map((name, index) => [name, index])) });
  const list = (type, item, delimiter = ',') => ({ type: 'array', clrType: `System.Collections.Generic.IReadOnlyList\`1[${type}]`,
    nullable: true, item, delimiter, converterArrayRoot: true });
  const guid = scalar('guid', 'Guid');
  const booleanNames = ['HasAired', 'IsAiring', 'IsMovie', 'IsSeries', 'IsNews', 'IsKids', 'IsSports', 'EnableImages', 'EnableUserData'];
  const dates = ['MinStartDate', 'MaxStartDate', 'MinEndDate', 'MaxEndDate'];
  const fields = { UserId: guid, LibrarySeriesId: guid, SeriesTimerId: scalar('string', 'String'),
    ...Object.fromEntries(booleanNames.map(name => [name, scalar('boolean', 'Boolean')])),
    ...Object.fromEntries(dates.map(name => [name, scalar('datetime', 'DateTime')])),
    ...Object.fromEntries(['StartIndex', 'Limit', 'ImageTypeLimit'].map(name => [name, scalar('integer', 'Int32')])),
    EnableTotalRecordCount: { type: 'boolean', clrType: 'System.Boolean', nullable: false },
    ChannelIds: list('System.Guid', { ...guid, nullable: false }), GenreIds: list('System.Guid', { ...guid, nullable: false }),
    Genres: list('System.String', scalar('string', 'String'), '|'),
    SortBy: list('Jellyfin.Database.Implementations.Enums.ItemSortBy', enumeration('Jellyfin.Database.Implementations.Enums.ItemSortBy', sortNames)),
    SortOrder: list('Jellyfin.Data.Enums.SortOrder', enumeration('Jellyfin.Data.Enums.SortOrder', ['Ascending', 'Descending'])),
    Fields: list('MediaBrowser.Model.Querying.ItemFields', enumeration('MediaBrowser.Model.Querying.ItemFields', itemFields)),
    EnableImageTypes: list('MediaBrowser.Model.Entities.ImageType', enumeration('MediaBrowser.Model.Entities.ImageType', imageTypes)) };
  const reference = 'Jellyfin.Api.Models.LiveTvDtos.GetProgramsDto';
  const schema = { definitions: { [reference]: { fields,
    defaults: { ...Object.fromEntries(Object.keys(fields).map(name => [name, null])), EnableTotalRecordCount: true } } } };
  const root = { type: 'object', clrType: reference, reference, nullable: true };
  return { body: true, bodyType: reference, bodyParameter: 'body', bindBody(body, source) {
    const result = bindJsonModel(body, { schema, root, source });
    if (result == null) throw new BindingError('body', 'The body field is required.');
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value != null).map(([key, value]) => [
      key.toLowerCase(), dates.includes(key) ? formatUtcTicks(jsonDateTimeUtcTicks(value))
        : key === 'Fields' ? value.filter(entry => typeof entry === 'string')
          : ['SortBy', 'SortOrder', 'EnableImageTypes'].includes(key) ? value.map(String) : value,
    ]));
  } };
}
