export function tmdbConfiguration(values = {}) {
  return {
    TmdbApiKey: '', IncludeAdult: false, ExcludeTagsSeries: false, ExcludeTagsMovies: false,
    ImportSeasonName: false, ImportUnairedEpisodes: false, ImportMissingEpisodes: false,
    ImportSpecials: false, EnabledMissingEpisodeLibraries: [], MissingEpisodeRefreshIntervalDays: 7,
    UpcomingEpisodeGracePeriodDays: 7, MaxCastMembers: 15, MaxCrewMembers: 15,
    HideMissingCastMembers: false, HideMissingCrewMembers: false, PosterSize: null, BackdropSize: null,
    LogoSize: null, ProfileSize: null, StillSize: null, SimilarItemsCacheDays: 90,
    ...structuredClone(values),
  };
}

export function validateImagePreferences(configuration, remoteConfiguration) {
  for (const kind of ['Poster', 'Backdrop', 'Logo', 'Profile', 'Still']) {
    const sizes = remoteConfiguration.images?.[kind.toLowerCase() + '_sizes'];
    const setting = kind + 'Size';
    if (sizes && configuration[setting] != null && !sizes.includes(configuration[setting])) {
      if (!sizes.length) throw new RangeError('TMDB returned an empty image size list.');
      configuration[setting] = sizes.at(-1);
    }
  }
}
