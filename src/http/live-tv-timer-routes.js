import { BindingError, booleanValue, notFound, queryValue } from './binding.js';
import { enumName } from '../sessions/binding.js';
import { clrTrim } from '../metadata/whitespace.js';

const timerId = context => {
  const value = context.params.timerId;
  if (!clrTrim(value)) throw new BindingError('timerId', 'The timerId field is required.');
  return value;
};

export function registerLiveTvTimerRoutes(add, { liveTvTimers }) {
  if (!liveTvTimers) return;
  const options = { policy: 'LiveTvAccess' };
  add('GET', '/LiveTv/Timers', context => liveTvTimers.getTimers({
    channelId: queryValue(context.query, 'channelId'), seriesTimerId: queryValue(context.query, 'seriesTimerId'),
    isActive: booleanValue(queryValue(context.query, 'isActive'), 'isActive'),
    isScheduled: booleanValue(queryValue(context.query, 'isScheduled'), 'isScheduled'),
  }), options);
  add('GET', '/LiveTv/Timers/Defaults', context => liveTvTimers.getNewTimerDefaults(queryValue(context.query, 'programId')), options);
  add('GET', '/LiveTv/Timers/{timerId}', context => liveTvTimers.getTimer(timerId(context)), options);
  add('GET', '/LiveTv/SeriesTimers', context => {
    let sortOrder;
    try { sortOrder = enumName(queryValue(context.query, 'sortOrder'), ['Ascending', 'Descending']); }
    catch { /* Nullable enum binding ignores unrecognized values. */ }
    return liveTvTimers.getSeriesTimers({ sortBy: queryValue(context.query, 'sortBy'), sortOrder: sortOrder ?? 'Ascending' });
  }, options);
  add('GET', '/LiveTv/SeriesTimers/{timerId}', async context => await liveTvTimers.getSeriesTimer(timerId(context)) ?? notFound(), options);
}
