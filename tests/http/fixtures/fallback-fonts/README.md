# Fallback font file delivery

`input.js` supplies the ordinary file, configuration and authorization matrix.
The designated `SubtitleController`, `PhysicalFileResult` executor and
`ExceptionMiddleware` run in the actual ASP.NET host. Node serves the same
controlled files through its mapped local storage plugin. Original files and
configuration bytes are checked after the requests and all hosts close.

`fallbackFontFailureInput()` is a separate current observation. The result filter
moves an owned file aside either before result execution or immediately before
delegating to the original `IHttpResponseBodyFeature.SendFileAsync`. It restores
the file in `finally`; no exception or response is fabricated. The original
controller, executor, Kestrel body feature and exception middleware remain in the
call chain. Small and larger files expose different response length boundaries.
Each failed request is followed by a successful request to the restored file.

The fault capture retains the executor's actual header commitment, final server
headers, public status and every body byte received before EOF or transport
failure. Its five second client deadline bounds only this failure observation.
Native framing or body failures remain original observations; the report does
not claim a zero difference comparison or release acceptance.

The same input is now captured independently by Node in `node/raw.json`.
Its result-send hook moves the actual owned file before the original result
executes; its open-read hook moves it after the original response selected its
file headers and before delegating to mapped `LocalAdapter` access. Neither hook
throws a selected error or manufactures HTTP output. Each actual storage error,
response commitment, status, headers, body, transport outcome, restored file and
complete subsequent response is retained. The report lists public comparison
bits and keeps incomplete Native transport distinct from a complete Node error;
these observations do not waive those public differences.

The Node resource tests open real mapped local files before rejecting the open
or first public iterator pull. They cover primitive and structured failure
reasons, actual reader cleanup, outer response headers, the complete English
error body, and subsequent full font delivery. A declared length is compared to
that response's complete unencoded GET body; no framing header is required.

`fallback-fonts-consumer.test.js` is separate evidence for the designated locked
`@jellyfin/libass-wasm` 4.2.4 consumer. It requires the existing `web_clients`,
`native_sqlite`, `native_instance` and `native_reference` CI supplies. The same-run
Web receipt binds the source, lock, runtime and npm-cache bytes; the test verifies
the package's SHA512 and each actual runtime worker asset before serving it.
The production build optimizes copied JavaScript, so package and runtime JS
retain separate original copies, source bindings and hashes. The browser runs
the actual receipt-bound runtime worker; binary WASM/font assets also retain
their locked package bytes. The modern worker and locked main script are used without edits, network
interception, response replay or a replacement XMLHttpRequest.

A fixture-local Worker runs the original `recordOracle`, leaving the test's
browser/control loop responsive while the real Native host remains alive. Its
optional loopback callback asks fixed Chromium to request the current fault from
that actual host. Node uses the same phases, filenames and file sizes. Original
browser requests, status/headers, body-read or transport failures, worker errors,
public `onError`, visible callback output, screenshots and actual cleanup remain
in independent files. The actual target request lifecycle and the separate
page's worker/callback bind the failure; error-message wording or URL text is
not an acceptance gate. Read-only worker evaluation attempts to read the exact
font file libass would consume; after restoration a fresh worker must read the
complete original bytes from that same path. This proves real file availability,
not an internal resource counter. Only the actual file read may report it as
unavailable; capture serialization failures remain fixture errors. The public renderer callback is observed in a
separate fresh page using the original main script.

This is a narrow modern-libass consumer experiment. It does not run the whole
Jellyfin Web playback UI, certify the legacy worker, equate incomplete transport
with complete HTTP errors for other consumers, or declare compatibility/phase/
release acceptance. Its CI result must be audited before drawing a conclusion.
