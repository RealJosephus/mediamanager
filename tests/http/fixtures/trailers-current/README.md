# Designated Trailers HTTP behavior

The real MVC fixture activates the designated TrailersController with its actual
DI ItemsController. It does not assign a controller context. The original
authenticated requests bind successfully but return HTTP 500, text/plain,
`Error processing request.` before any item query. Direct `/Items` controls
using the same dependencies succeed and return their real empty query result.
Original observations, bound inputs, diagnostics, assemblies and source bindings
are retained. The first differential at candidate `9d8ad37` in run 40421138563
preserves the discovered difference rather than replacing this failure with a
successful Items query.

Node preserves authentication, MVC scalar validation, collection conversion
failures and this public failure boundary. An unused integer collection can
still fail binding before the action, including when a scalar also fails;
that HTTP status, content type and body remain part of the comparison. Node
uses no CLR controller/context model. Successfully bound, unused collection
values and diagnostic details do not decide conformance. Successful `/Items`
controls still compare the selectors actually consumed. The PostgreSQL test
also proves normal Trailer selection through `/Items`, then checks that failed
`/Trailers` requests leave media rows unchanged, including names that could
otherwise trigger by-name creation.

Direct Items and Resume controls also verify that unknown client options and
internal query properties remain unbound. A bound invalid scalar still returns
400; user-scoped Items keeps its narrower index/language parameter surface.
The real PostgreSQL consumer separately compares populated Items results and
Resume responses with and without those unbound options.

This matrix covers the specified designated build, controlled principals and
empty library services. It is not a full library/production-scale acceptance
or evidence that another server release has this same action failure.
