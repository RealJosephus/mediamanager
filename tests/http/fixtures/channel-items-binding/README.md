# Channel Items and Latest MVC binding

This component runs the supplied `ChannelsController` in actual
`AddJellyfinApi` MVC, with the actual comma-delimited binder, default
authorization requirement and exception middleware. A controlled
`IChannelManager` records the resulting `InternalItemsQuery` and returns an
empty `QueryResult<BaseItemDto>`. Authentication identity and user lookup are
controlled. This isolates public binding and action order; it does not claim
provider refresh, SQL selection or media execution in this HTTP host.

The Node comparison uses `createApplication`, the formal Items/Latest routes and
the actual authorization service with the same controlled identity, user lookup
and manager boundary. Each request compares status, body/content type, every
consumed query field and lookup order. The matrix keeps nullable/empty and
repeated scalar values, negative paging, route and query GUID forms, comma and
repeated enum collections, dropped invalid collection members, conflicting
filters, extra sort orders and cross-user/anonymous ordering. Independent
business and SQL behavior is covered by the Channel Items native component.
The controlled Node authentication callback resolves its user through the same
recorded user boundary before actual authorization; native default authorization
performs that lookup from its controlled claims. Controller user lookup remains
a separate real call and does not occur when MVC binding rejects a request.

Expected exceptions must match the exact request and native wire status. Node
diagnostics retain the formal route call stack; argument errors also
match the native exception type/message. MVC binding errors and successful
requests require no Node business diagnostic. No 200 difference is ignored.
Native stack-less security logging is retained as emitted by its actual
middleware rather than being synthesized. Both real HTTP hosts stop and
dispose, and protected reference verification runs in the finalizer.

Only component acceptance can become true after every comparison. Phase and
release acceptance remain false. No database, plugin, stream, metadata executor,
recording or encoder starts in this fixture.
