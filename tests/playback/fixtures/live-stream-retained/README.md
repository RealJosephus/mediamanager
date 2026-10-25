# Retained live stream components

The oracle uses actual `MediaSourceManager` retained lookup methods and its
real private dictionary, seeded with explicitly controlled ILiveStream objects.
Lookup preserves its insensitive public/unique identities, null/empty argument
errors, missing results and optional IDirectStreamProvider cast. The control's
Open method throws if called. No provider discovery or stream acquisition runs.

Positive delivery calls the actual `LiveTvController.GetLiveStreamFile`, then
executes its FileStreamResult through the actual MVC result executor registered
by AddMvcCore. The underlying input is an observed MemoryStream. The actual
ProgressiveFileStream stays nonseekable and rejects Length. Default controller
timeout remains 30000ms: reaching the controlled input's EOF explicitly cancels
the request, ending that live consumer instead of waiting or editing the timer.
The output body and response metadata up to cancellation are retained. This
does not claim a completed full native HTTP exchange. A separate actual
ProgressiveFileStream uses an explicitly supplied zero timeout to observe EOF.

Cases compare original bytes/SHA-256, MIME for multiple legal containers,
insensitive unique identity, HEAD, disabled Range, explicit cancellation after
three bytes, missing identity and reader disposal. Native request cancellation
and result-executor Abort (or an actual propagated cancellation exception) are
recorded separately from positive payload delivery. Only the explicitly
cancelled request's OperationCanceledException is caught by the fixture; other
executor failures remain failures.
HEAD creates its reader and disposes it without a read. Reading never decreases
the public ConsumerCount. The actual manager closes the controlled input once
after result ownership ends.

Node runs actual LiveStreamsService, PlaybackService.liveStreamFile and the
returned BinaryResult. Discovery, shared-input tuner leases and probe are
declared controls. A real Writable response component uses backpressure and
captures the bytes written; it is not a native HTTP host. Independent retained
readers never consume the public owner iterator or change ConsumerCount. Each
reader and original lease must close exactly once, including deliberate
cancellation. MIME is selected by the production PlaybackService, not injected
from oracle expectations. Native and Node body/status/content metadata compare
exactly; implementation-specific read-call counts remain raw observations.

An additional native-only lane constructs the actual base TunerHosts.LiveStream
and calls its safe base Open (only DateOpened assignment) followed by actual
GetStream. Its private source file is populated beforehand as fixture input;
no stream, recorder, packet-copy or transcoder writes it. Fresh input starts at
zero; input older than ten seconds attempts the native last-20000-byte seek;
a shorter input retains offset zero after the seek fails. A missing file maps
to actual FileNotFoundException/404. Source bytes remain unchanged and are
removed after handles close. This historical tail behavior is native boundary
evidence; Node does not acquire a recording/spool implementation to reproduce it.

SharedHttpStream.Open is never called. Physical tuners, real network input,
authentication/model-binding, full-host native HTTP, output timing, client
compatibility and complete Live TV release acceptance remain separate scopes.
Source bindings, actual assembly hashes, input/output hashes and owner cleanup
are published in the authorized validation directory. Validation runs in Actions.
