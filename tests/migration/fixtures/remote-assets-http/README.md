# Conditional HTTP state assets

This fixture runs a separate Node process with its own loopback listener and
durable object directory. Every write requires an actual HTTP precondition;
the service serializes conditional commits, fsyncs the object and index, and
publishes the new generation before returning an atomic receipt. GET honors
If-Match. The small bounded object inventory and private fixture adapter are
independent of the production AList and WebDAV implementations.

The migration tests exercise the production remote asset capture and restore
through VFS and the complete storage registry capability contract. They retain
raw NFO/unknown bytes, restart the remote process, reuse matching targets,
reject stale generations and a truncated response, and detect a real HTTP
external edit between target verification and completion. Failed restore
retains its committed prefix and does not overwrite the external edit.

Before fixture disposal the normal owner closes readers, the actual server
descriptors and requests, exits the child, and rebinds its original port.
The shared `ownedConditionalHttpFixture(t, label)` retains that same service
and adapter for other state-package consumers. Each process enters ownership
synchronously at spawn, before readiness can fail or the business signal can
abort. Initialization errors retain their original cause and drain the actual
owner before rejection; cleanup errors follow the primary in an AggregateError.
An independent ten-second cleanup signal covers readiness, IPC close, natural
exit and port rebind, including when the business signal has already aborted.
If natural drain fails, emergency termination and its bounded five-second exit
wait remain explicit failures; they never satisfy natural-close assertions.
The existing business deadlines are unchanged.

Three additional owner controls use this same real server. Both explicit
startup modes open a real loopback listener and a real file descriptor before
the admission observation: one reports an initialization failure, and the
other retains its descriptor until real close. The regressions cover that
initialization failure, a cancellation before readiness with a falsy original
reason, and cancellation after actual conditional HTTP reads. All require the
actual closed receipt to have zero active requests and descriptors, natural
code-zero exit without a signal, and a successful real TCP rebind. The original
three restart/generation/truncation/external-write scenarios remain intact.

Reports distinguish normal shutdown from forced fixture cleanup. This is a
controlled CI network backend, not evidence for a hosted production service,
multi-object atomicity, AList/WebDAV reliable versions, complete instance
exchange, power-loss recovery, production scale, or release acceptance.
