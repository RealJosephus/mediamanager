import { ScheduledTaskWorker } from '@mediamanager/plugin-sdk/tasks/refresh-library-task';

// ScheduledTaskWorker hashes the native CLR full name as an MD5 Guid. .NET's
// Guid byte ordering yields this value for
// MediaBrowser.Providers.Plugins.Tmdb.TV.TmdbUpcomingEpisodesTask.
export const tmdbUpcomingEpisodesTaskId = '1ee23a5dd39fb4225715375c91bc2990';
export const tmdbUpcomingEpisodesTaskKey = 'TmdbRefreshUpcomingEpisodes';

export const tmdbUpcomingEpisodesTaskName = 'Refresh upcoming and missing episodes (TheMovieDb)';
export const tmdbUpcomingEpisodesTaskDescription = 'Checks TheMovieDb for newly announced episodes and creates virtual entries for unaired and missing episodes, according to the TMDb plugin settings. When both options are disabled, removes any virtual entries previously created.';

const ticksPerDay = 24n * 60n * 60n * 10_000_000n;
const maximumTicks = 9_223_372_036_854_775_807n;

export function defaultTmdbUpcomingEpisodesTaskTriggers(configuration) {
  let days = configuration?.MissingEpisodeRefreshIntervalDays ?? 7;
  if (days <= 0) days = 7;
  if (!Number.isInteger(days)) throw new TypeError('TMDB missing-episode refresh interval must be an Int32 day count.');
  const ticks = BigInt(days) * ticksPerDay;
  if (ticks > maximumTicks) throw new RangeError('TMDB missing-episode refresh interval is outside the native TimeSpan range.');
  return Object.freeze([Object.freeze({ Type: 'IntervalTrigger', IntervalTicks: ticks })]);
}
export class TmdbUpcomingEpisodesTaskWorker extends ScheduledTaskWorker {
  constructor({ maintenance, configuration = maintenance?.configuration, ...options } = {}) {
    super({
      ...options,
      definition: {
        id: tmdbUpcomingEpisodesTaskId,
        key: tmdbUpcomingEpisodesTaskKey,
        name: tmdbUpcomingEpisodesTaskName,
        description: tmdbUpcomingEpisodesTaskDescription,
        category: 'Library',
        defaultTriggers: defaultTmdbUpcomingEpisodesTaskTriggers(configuration),
      },
      ensureAvailable() {
        if (!maintenance || typeof maintenance.run !== 'function') {
          throw Object.assign(new Error('TMDB upcoming-episode maintenance is not implemented.'), {
            status: 501,
            statusCode: 501,
            code: 'task-unavailable',
          });
        }
      },
      run: operation => maintenance.run(operation),
    });
    this.maintenance = maintenance;
  }
}
