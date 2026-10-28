# Production request cultures

The production factory loads English messages and an independent list of
request culture codes derived from the designated Native Core resource names.
`LocalizationManager.GetSupportedUICultures` is the authority for the accepted
set; it normalizes underscores and excludes a code only when the actual
`CultureInfo.GetCultureInfo` call fails. Comments about novelty codes do not
define an extra blacklist. Native translation files remain reference inputs;
the Node runtime imports only their culture codes and its English messages.

The same-run oracle directly calls the designated implementation, records every
embedded resource and its actual resolution, and executes the real ASP.NET
RequestLocalizationMiddleware with that supported set. Every normalized resource
code is requested through query, cookie and Accept-Language. Further cases cover
parent fallback, mixed culture/UI culture, unsupported providers, duplicate and
malformed query/cookie/quality values, source underscores, and three startup
defaults. Existing recorded two-culture tests retain their controlled plain
`new Localization()` constructor. The production factory's full set is compared
to the new actual Native observations and still returns only English messages.

Underscore request values use parent fallback rather than directly selecting
the resource spelling's hyphenated region. They are checked in all three
providers. Comma-joined duplicate query values and decoded cookie lists remain
one invalid candidate; parent truncation must not turn them into an accepted
language. The report identifies each differing request and actual Native
provider while retaining the complete original observations.

Source, assembly, runtime, input and observation hashes are preserved. This is a
request-culture component comparison; the complete-instance test separately
checks actual Native/Node HTTP directory ordering with `culture=sv-SE`.
