# Current TMDB client consumer

`input.js` supplies new responses to the current designated Jellyfin
`TmdbClientManager` and the actual TMDbLib dependency, then to the Node client.
`Program.cs` replaces only the dependency's HTTP message handler. The manager,
default request policy, timers, cancellation, cache and Movie provider execute
their production code. No public TMDB account or network service is used.

`dependency-source.json` records original package metadata and source bytes from
the NuSpec repository commit. `dependency-source/` retains those bytes and the
MIT license. The current native build binds the actual package metadata,
assemblies and designated manager/provider source. Runtime versions accompany
the actual assembly hashes.

The consumer compares endpoint requests, response bodies, success/null/failure,
cache effects, actual retry waits and cancellation. Recovered Movie metadata
proves a provider consequence. Retry waits include the final failed attempt,
and configuration initialization continues independently of caller cancellation.
Content-Type and malformed/empty JSON cases exercise the same request boundary.

Complete error observations and clocks remain in the run output. Request query
parameter order and the order of independent `append_to_response` resources are
compared as equivalent requests. Image language order and all query values stay
exact.

This component does not prove live TMDB availability, public server HTTP,
metadata persistence, complete provider coverage or release acceptance. Run it
only through the cross-platform Actions workflow with the current native input.
