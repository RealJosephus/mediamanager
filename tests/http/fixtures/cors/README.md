# HTTP CORS

The supplied Jellyfin DLL's `CorsPolicyProvider` runs through actual ASP.NET
Core CORS middleware on an isolated HTTP listener. Only configuration access
and terminal endpoint statuses are controlled. The candidate uses its actual
application, route lookup and authentication boundary. Requests and policy
changes are identical; preflights must finish before authentication.

The cases cover the default and empty policies, configured origins and
credentials, denied origins, ordinary OPTIONS, BaseUrl, and browser origin
normalization. Responses preserve all CORS headers. Only optional comma
whitespace in token-list headers is ignored. No database or complete native
server is claimed by this middleware test.

Sources: the designated `Jellyfin.Server/Configuration/CorsPolicyProvider.cs`
and `Jellyfin.Server/Startup.cs` (GPL-2.0-only), plus the MIT-licensed ASP.NET
Core [CorsService](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Middleware/CORS/src/Infrastructure/CorsService.cs),
[CorsMiddleware](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Middleware/CORS/src/Infrastructure/CorsMiddleware.cs)
and [CorsPolicyBuilder](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Middleware/CORS/src/Infrastructure/CorsPolicyBuilder.cs).
The oracle receipt binds the actually loaded framework and native assemblies.
