# Current Quick Connect consumers

This fixture executes the workflow's designated Native build twice in separate
build and process directories. `input.json` preserves all 74 original HTTP
scenarios and names the nine direct-authentication scenarios explicitly. The
historical input, raw observations, source files and provenance are unchanged.

The actual `QuickConnectManager`, Quick Connect and User controllers, MVC
binding, exception middleware and default authorization handler consume every
HTTP request. User/principal, network, authorization information and the session
authentication service are controlled. Native direct-authentication observations
separately run the actual `SessionManager.AuthenticateDirect`, with controlled
user/device persistence and events. They retain the success/failure result,
returned device/session fields, token deletion/insertion effects, unchanged
login date and failed-login count. The candidate counterpart uses real
PostgreSQL users, permissions, devices and sessions.

Every issued request is polled, redeemed twice and polled again through HTTP.
The six additional expiry cases exercise nine- and eleven-minute-old pending
requests and authorization results independently. Native has no supplied clock:
the fixture ages its public request date and, only to arrange an expired
authorization result, the timestamp associated with that result. Node uses its
supplied clock. Assertions observe public status, full responses and absence of
new authentication side effects during reads. The age margin keeps fixture
setup independent of scheduler timing at the exact expiry boundary.

Random secrets/codes are validated and bound to their own issued request before
comparison. Public dates must fall within the corresponding creation,
authorization or declared expiry preparation window. HTTP trace IDs are
required when returned and treated as per-request identities. Allow methods are
compared as a set; JSON is compared as complete parsed public values. Raw HTTP
bodies and current Native records remain in the output. Each independent Native
process must agree on these observations before its results can be used by Node.

`quick-connect-runtime.test.js` retains token rotation, real caller and target
device restrictions, successful token use, cold restart, retry after failed
insertion, completed logout and shutdown draining. The nine direct cases use
these current Native observations, including independent insert/delete failure
prefixes. Recorded candidate comparisons contain functional session and
persistence results without real authentication tokens or password hashes.

Required services are `dotnet` and `jellyfinDll` for the HTTP consumer, plus
`postgres` for the runtime consumer. This is current component/HTTP and candidate
persistence evidence. It does not claim a full Native instance, database
exchange, phase completion or release acceptance. All execution belongs to the
three GitHub Actions platforms.
