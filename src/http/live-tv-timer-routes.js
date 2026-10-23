import { BindingError, booleanValue, httpError, noContent, notFound, queryValue } from './binding.js';
import { enumName } from '../sessions/binding.js';
import { clrTrim } from '../metadata/whitespace.js';
import { bindLiveTvTimerBody } from './live-tv-timer-binding.js';

const timerId = context => {
  const value = context.params.timerId;
  if (!clrTrim(value)) throw new BindingError('timerId', 'The timerId field is required.');
  return value;
};

export function registerLiveTvTimerRoutes(add, { liveTvTimers }) {
  if (!liveTvTimers) return;
  const options = { policy: 'LiveTvAccess' };
  const management = { policy: 'LiveTvManagement' };
  const body = (kind, bodyParameter, bodyType) => ({ ...management, body: true, bodyParameter, bodyType,
    bindBody(value, source) { return bindLiveTvTimerBody(kind, value, source); } });
  const unavailable = operation => { throw httpError(409, `Live TV ${operation} requires a recording provider.`); };
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
  add('DELETE', '/LiveTv/Timers/{timerId}', async context => await liveTvTimers.cancelTimer(timerId(context)) ? noContent() : notFound(), management);
  add('DELETE', '/LiveTv/SeriesTimers/{timerId}', async context => await liveTvTimers.cancelSeriesTimer(timerId(context)) ? noContent() : notFound(), management);
  add('POST', '/LiveTv/Timers', () => unavailable('timer creation'),
    body('timer', 'timerInfo', 'MediaBrowser.Model.LiveTv.TimerInfoDto'));
  add('POST', '/LiveTv/Timers/{timerId}', context => { timerId(context); return unavailable('timer update'); },
    body('timer', 'timerInfo', 'MediaBrowser.Model.LiveTv.TimerInfoDto'));
  add('POST', '/LiveTv/SeriesTimers', () => unavailable('series timer creation'),
    body('seriesTimer', 'seriesTimerInfo', 'MediaBrowser.Model.LiveTv.SeriesTimerInfoDto'));
  add('POST', '/LiveTv/SeriesTimers/{timerId}', context => { timerId(context); return unavailable('series timer update'); },
    body('seriesTimer', 'seriesTimerInfo', 'MediaBrowser.Model.LiveTv.SeriesTimerInfoDto'));
}
