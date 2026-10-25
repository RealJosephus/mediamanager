# Dynamic image host

The unchanged recording executes the designated source-built ProviderManager,
BaseItemManager, BookMetadataService image eligibility and ItemImageProvider.
Actual ProviderManager stream saving and ImageSaver write isolated files and
dispose the controlled response streams. Dynamic and remote image payloads,
configuration, library options, filesystem fault injection and logging are
explicit seams. This does not execute book archive parsing, SQL or native HTTP.

The 30 cases cover one combined provider order, configured and identification
order, first/default/full refresh, locks, extras, disabled fetchers/image limits,
dynamic minimum-width behavior, retained/replaced Primary images, empty and
failing providers, cancellation before saving, zero-byte destination prefixes,
save/deletion failures, local saving and exact source bytes. A failed deletion
occurs after the live image changes and before that provider records success,
so a later provider may replace the new image. Every native response stream is
disposed, including ordinary save failure and cancellation.
An aborted request does not turn a returned empty image or an unrelated
ordinary provider error into a cancellation exception. The next selected
provider may still run; its cancellation-aware save then preserves the create
prefix. Existing remote-provider cancellation behavior remains unchanged.

The Node dynamic response is `null | { bytes, mimeType }`. Providers return owned
bytes after closing their archive resources; the requested image type comes
from the host. No fake URL or CLR response object is exposed. File-path and HTTP
response-path branches of the native generic interface are outside this byte
contract and are not claimed by this fixture.
