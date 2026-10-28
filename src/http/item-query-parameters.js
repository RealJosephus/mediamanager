// Public ItemsController parameters. Internal query properties and arbitrary
// client options are unbound in MVC and never reach the repository query.
const items = new Set(`userId maxOfficialRating hasThemeSong hasThemeVideo hasSubtitles hasSpecialFeature hasTrailer
  adjacentTo indexNumber parentIndexNumber hasParentalRating isHd is4K locationTypes excludeLocationTypes
  isMissing isUnaired minCommunityRating minCriticRating minPremiereDate minDateLastSaved minDateLastSavedForUser
  maxPremiereDate hasOverview hasImdbId hasTmdbId hasTvdbId isMovie isSeries isNews isKids isSports excludeItemIds
  startIndex limit recursive searchTerm sortOrder parentId fields excludeItemTypes includeItemTypes filters
  isFavorite mediaTypes imageTypes sortBy isPlayed genres officialRatings tags years enableUserData imageTypeLimit
  enableImageTypes person personIds personTypes studios artists excludeArtistIds artistIds albumArtistIds
  contributingArtistIds albums albumIds ids videoTypes minOfficialRating isLocked isPlaceHolder hasOfficialRating
  collapseBoxSetItems minWidth minHeight maxWidth maxHeight is3D seriesStatus nameStartsWithOrGreater nameStartsWith
  nameLessThan studioIds genreIds audioLanguages subtitleLanguages enableTotalRecordCount enableImages`
  .toLowerCase().split(/\s+/u));
const resume = new Set(`userId startIndex limit searchTerm parentId fields mediaTypes enableUserData imageTypeLimit
  enableImageTypes excludeItemTypes includeItemTypes enableTotalRecordCount enableImages`
  .toLowerCase().split(/\s+/u));
const legacyUnbound = new Set(['indexnumber', 'audiolanguages', 'subtitlelanguages']);

export function publicItemQueryEntries(query, { resumeItems = false, userScoped = false, embyClient = false } = {}) {
  const parameters = resumeItems ? resume : items;
  return [...query].filter(([name]) => {
    const key = name.toLowerCase();
    if (embyClient && !resumeItems) return true;
    return parameters.has(key) && (resumeItems || !userScoped || !legacyUnbound.has(key));
  });
}
