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
  add('DELETE', '/LiveTv/Timers/{timerId}', async context => {
    if (!await liveTvTimers.cancelTimer(timerId(context))) throw httpError(404, 'The Live TV timer was not found.');
    return noContent();
  }, management);
  add('DELETE', '/LiveTv/SeriesTimers/{timerId}', async context => {
    if (!await liveTvTimers.cancelSeriesTimer(timerId(context))) throw httpError(404, 'The Live TV series timer was not found.');
    return noContent();
  }, management);
  add('POST', '/LiveTv/Timers', async context => {
    if (!liveTvTimers.dvr) return unavailable('timer creation');
    await liveTvTimers.createTimer(context.body); return noContent();
  },
    body('timer', 'timerInfo', 'MediaBrowser.Model.LiveTv.TimerInfoDto'));
  add('POST', '/LiveTv/Timers/{timerId}', async context => {
    timerId(context);
    if (!liveTvTimers.dvr) return unavailable('timer update');
    await liveTvTimers.updateTimer(context.body); return noContent();
  },
    body('timer', 'timerInfo', 'MediaBrowser.Model.LiveTv.TimerInfoDto'));
  add('POST', '/LiveTv/SeriesTimers', async context => {
    if (!liveTvTimers.dvr) return unavailable('series timer creation');
    await liveTvTimers.createSeriesTimer(context.body); return noContent();
  },
    body('seriesTimer', 'seriesTimerInfo', 'MediaBrowser.Model.LiveTv.SeriesTimerInfoDto'));
  add('POST', '/LiveTv/SeriesTimers/{timerId}', async context => {
    timerId(context);
    if (!liveTvTimers.dvr) return unavailable('series timer update');
    await liveTvTimers.updateSeriesTimer(context.body); return noContent();
  },
    body('seriesTimer', 'seriesTimerInfo', 'MediaBrowser.Model.LiveTv.SeriesTimerInfoDto'));
}
