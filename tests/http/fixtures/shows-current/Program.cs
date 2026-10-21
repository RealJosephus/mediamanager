// Executes the designated Jellyfin TV and Library controllers plus their real Shows selectors.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.SimilarItems;
using Emby.Server.Implementations.Sorting;
using Emby.Server.Implementations.TV;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Api.ModelBinders;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Sorting;
using MediaBrowser.Controller.TV;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Querying;
using MediaBrowser.Providers.Plugins.Tmdb;
using MediaBrowser.Providers.Plugins.Tmdb.TV;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Mvc.ModelBinding.Binders;
using Microsoft.AspNetCore.Routing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Primitives;
using TmdbPlugin = MediaBrowser.Providers.Plugins.Tmdb.Plugin;
using TmdbPluginConfiguration = MediaBrowser.Providers.Plugins.Tmdb.PluginConfiguration;
using TMDbClient = TMDbLib.Client.TMDbClient;

var nativeSqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeSqliteFilename = Path.Combine(AppContext.BaseDirectory, nativeSqliteName);
var nativeSqliteHandle = NativeLibrary.Load(nativeSqliteFilename);
var nativeSqliteResolutions = 0;
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) =>
{
    if (name != "e_sqlite3") return IntPtr.Zero;
    Interlocked.Increment(ref nativeSqliteResolutions);
    return nativeSqliteHandle;
});
SQLitePCL.Batteries_V2.Init();
var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();

foreach (var scenario in input.EnumerateArray())
{
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)configuration).Data.DisplaySpecialsWithinSeasons = true;
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();

    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var libraryProxy = (LibraryProxy)(object)library;
    BaseItem.LibraryManager = library;
    var realLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(
        realLibrary,
        new IBaseItemComparer[] { new SortNameComparer(), new AiredEpisodeOrderComparer() });
    libraryProxy.Real = realLibrary;
    Seed(libraryProxy);

    var user = new User("shows-reader", "fixture-auth", "fixture-reset")
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000090"),
        DisplayMissingEpisodes = scenario.TryGetProperty("displayMissing", out var displayMissing) && displayMissing.GetBoolean()
    };
    var userManager = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    ((UserManagerProxy)(object)userManager).User = user;
    var dtoService = DispatchProxy.Create<IDtoService, DtoProxy>();
    var dtoProxy = (DtoProxy)(object)dtoService;
    var nextUpManager = DispatchProxy.Create<ITVSeriesManager, NextUpManagerProxy>();
    var nextUpProxy = (NextUpManagerProxy)(object)nextUpManager;
    nextUpProxy.Library = libraryProxy;
    var controller = new TvShowsController(userManager, library, dtoService, nextUpManager);
    var apiKey = scenario.TryGetProperty("apiKey", out var apiKeyValue) && apiKeyValue.GetBoolean();
    var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, apiKey.ToString()) };
    if (!apiKey)
    {
        var claimUser = scenario.TryGetProperty("claimUser", out var claimUserValue)
            ? ResolveGuid(scenario, "claimUser", libraryProxy, "").ToString("N")
            : user.Id.ToString("N");
        claims.Add(new Claim(InternalClaimTypes.UserId, claimUser));
    }
    if (scenario.TryGetProperty("administrator", out var administrator) && administrator.GetBoolean())
    {
        claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
    }
    var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, "oracle"));
    controller.ControllerContext = new ControllerContext
    {
        HttpContext = new DefaultHttpContext { User = principal }
    };

    var endpoint = scenario.GetProperty("endpoint").GetString();
    if (endpoint == "upcoming")
    {
        libraryProxy.Upcoming = scenario.GetProperty("controlledItems").EnumerateArray()
            .Select(value => libraryProxy.Items[value.GetString()!]).ToArray();
        var action = controller.GetUpcomingEpisodes(
            null,
            NullableInt(scenario, "startIndex"),
            NullableInt(scenario, "limit"),
            Fields(scenario),
            NullableGuid(scenario, "parentId", libraryProxy),
            NullableBool(scenario, "enableImages"),
            NullableInt(scenario, "imageTypeLimit"),
            ImageTypes(scenario),
            NullableBool(scenario, "enableUserData"));
        results.Add(Snapshot(scenario, action, libraryProxy, dtoProxy));
    }
    else if (endpoint == "nextup")
    {
        nextUpProxy.Controlled = scenario.TryGetProperty("controlledItems", out var controlled)
            ? controlled.EnumerateArray().Select(value => libraryProxy.Items[value.GetString()!]).ToArray()
            : [];
        nextUpProxy.TotalRecordCount = scenario.TryGetProperty("controlledTotal", out var total)
            ? total.GetInt32() : nextUpProxy.Controlled.Length;
        nextUpProxy.StartIndex = scenario.TryGetProperty("controlledManagerStartIndex", out var managerStartIndex)
            ? managerStartIndex.GetInt32() : null;
        var action = controller.GetNextUp(
            NullableGuid(scenario, "user", libraryProxy),
            NullableInt(scenario, "startIndex"),
            NullableInt(scenario, "limit"),
            Fields(scenario),
            NullableGuid(scenario, "seriesId", libraryProxy),
            NullableGuid(scenario, "parentId", libraryProxy),
            NullableBool(scenario, "enableImages"),
            NullableInt(scenario, "imageTypeLimit"),
            ImageTypes(scenario),
            NullableBool(scenario, "enableUserData"),
            NullableDate(scenario, "nextUpDateCutoff"),
            scenario.TryGetProperty("enableTotalRecordCount", out var totalEnabled) ? totalEnabled.GetBoolean() : true,
            scenario.TryGetProperty("enableResumable", out var resumable) ? resumable.GetBoolean() : true,
            scenario.TryGetProperty("enableRewatching", out var rewatching) && rewatching.GetBoolean());
        results.Add(Snapshot(scenario, action, libraryProxy, dtoProxy));
    }
    else if (endpoint == "similar")
    {
        var similarManager = DispatchProxy.Create<ISimilarItemsManager, SimilarManagerProxy>();
        var similarProxy = (SimilarManagerProxy)(object)similarManager;
        similarProxy.Controlled = scenario.TryGetProperty("controlledItems", out var controlled)
            ? controlled.EnumerateArray().Select(value => libraryProxy.Items[value.GetString()!]).ToArray()
            : [];
        var libraryController = new LibraryController(
            DispatchProxy.Create<IProviderManager, UnsupportedProxy>(),
            similarManager,
            library,
            userManager,
            DispatchProxy.Create<ICollectionManager, UnsupportedProxy>(),
            dtoService,
            DispatchProxy.Create<IActivityManager, UnsupportedProxy>(),
            DispatchProxy.Create<ILocalizationManager, UnsupportedProxy>(),
            DispatchProxy.Create<ILibraryMonitor, UnsupportedProxy>(),
            NullLogger<LibraryController>.Instance,
            configuration, DispatchProxy.Create<IHttpClientFactory, UnsupportedProxy>());
        libraryController.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext { User = principal }
        };
        try
        {
            var action = await libraryController.GetSimilarItems(
                ResolveGuid(scenario, "item", libraryProxy, "series"),
                Guids(scenario, "excludeArtistIds", libraryProxy),
                NullableGuid(scenario, "user", libraryProxy),
                NullableInt(scenario, "limit"),
                Fields(scenario),
                CancellationToken.None);
            results.Add(SimilarSnapshot(scenario, action, libraryProxy, dtoProxy, similarProxy.Calls));
        }
        catch (Exception ex)
        {
            results.Add(ExceptionSnapshot(scenario, ex, libraryProxy, dtoProxy, similarProxy.Calls));
        }
    }
    else if (endpoint == "seasons")
    {
        var action = controller.GetSeasons(
            ResolveGuid(scenario, "series", libraryProxy, "series"),
            NullableGuid(scenario, "user", libraryProxy),
            Fields(scenario),
            NullableBool(scenario, "isSpecialSeason"),
            NullableBool(scenario, "isMissing"),
            NullableGuid(scenario, "adjacentTo", libraryProxy),
            NullableBool(scenario, "enableImages"),
            NullableInt(scenario, "imageTypeLimit"),
            ImageTypes(scenario),
            NullableBool(scenario, "enableUserData"));
        results.Add(Snapshot(scenario, action, libraryProxy, dtoProxy));
    }
    else
    {
        var action = controller.GetEpisodes(
            ResolveGuid(scenario, "series", libraryProxy, "series"),
            null,
            Fields(scenario),
            NullableInt(scenario, "season"),
            NullableGuid(scenario, "seasonId", libraryProxy),
            NullableBool(scenario, "isMissing"),
            NullableGuid(scenario, "adjacentTo", libraryProxy),
            NullableGuid(scenario, "startItemId", libraryProxy),
            NullableInt(scenario, "startIndex"),
            NullableInt(scenario, "limit"),
            NullableBool(scenario, "enableImages"),
            NullableInt(scenario, "imageTypeLimit"),
            ImageTypes(scenario),
            NullableBool(scenario, "enableUserData"),
            scenario.TryGetProperty("sortBy", out var sortBy) ? Enum.Parse<ItemSortBy>(sortBy.GetString()!) : null);
        results.Add(Snapshot(scenario, action, libraryProxy, dtoProxy));
    }
}

var sqliteRepository = RecordSqliteRepository(Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "shows-api.sqlite"));
var tvSeriesManager = RecordTvSeriesManager();
var localSimilarProviders = await RecordLocalSimilarProviders();
var similarItemsManager = await RecordSimilarItemsManager(Path.Combine(
    Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "shows-similar-manager.sqlite"));
var similarProviderOrchestration = await RecordSimilarProviderOrchestration(
    Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "shows-similar-orchestration"));
var dateTimeBinding = await RecordDateTimeBinding();
var similarBinding = await RecordSimilarBinding();
var similarContract = RecordSimilarContract();
var guidEmptyHttp = await RecordGuidEmptyHttp();
var similarHttp = await RecordSimilarHttp();
var runtimeAssemblies = RecordRuntimeAssemblies(nativeSqliteFilename);
const string runtimeAssemblyScope = "Managed assemblies loaded in the oracle AppDomain at capture time plus the supplied RID e_sqlite3 loaded by NativeLibrary and resolved for actual SQLitePCL imports, together with Process.Modules observations where available; not a complete build-input dependency closure.";
const string oracleBoundary = "Actual designated TvShowsController and shared LibraryController Similar route/action methods, RequestHelpers claim/user selection, native Series/Season selectors, Episode.IsMissingEpisode, UserViewBuilder adjacency, controller paging/error results, actual TVSeriesManager next-up selection, Series/MusicArtist/MusicAlbum/Audio local similar providers, TmdbSeriesSimilarProvider over controlled TMDbLib transport, and SimilarItemsManager provider configuration/order/scoring, remaining-limit queries, exception/cancellation boundaries, remote 20/500 batching, provider-ID resolution and real file cache behavior including exact numeric-string decimal-to-Single midpoint ordering, invalid-string and quoted Single-overflow fallback, and bit-exact Single scoring, with native comparers, actual ASP.NET comma collection and DateTime model binders, actual ExceptionMiddleware, and concrete LibraryManager empty-parent/UserView-parent/Guid.Empty, BaseItemRepository, SimilarItemsManager access filtering, and NextUpService probes over EF Core SQLite. Controlled controller-side repository/manager result arrays, user lookup, DTO projection, local provider results and remote local-library lookup entities are explicit seams. ASP.NET authorization filters, concrete DtoService internals, live external services and deterministic Random shuffle order remain outside this oracle; no public-network call is made. Named or non-finite cache-score rejection is a stricter candidate fail-closed policy and is not asserted as native parity.";
File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    schemaVersion = 1,
    results,
    sqliteRepository,
    tvSeriesManager,
    localSimilarProviders,
    similarItemsManager,
    similarProviderOrchestration,
    dateTimeBinding,
    similarBinding,
    similarContract,
    guidEmptyHttp,
    similarHttp,
    runtimeAssemblyScope,
    runtimeAssemblies,
    nativeSqliteImportResolved = nativeSqliteResolutions > 0,
    candidateVerified = false,
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = oracleBoundary
}, json));

static object[] RecordRuntimeAssemblies(string resolvedSqliteFilename)
{
    using var process = Process.GetCurrentProcess();
    var nativeSqlitePaths = process.Modules.Cast<ProcessModule>()
        .Select(module => module.FileName)
        .Where(filename => string.Equals(
            Path.GetFileName(filename),
            "e_sqlite3.dll",
            StringComparison.OrdinalIgnoreCase)
            || string.Equals(Path.GetFileName(filename), "libe_sqlite3.so", StringComparison.Ordinal)
            || string.Equals(Path.GetFileName(filename), "libe_sqlite3.dylib", StringComparison.Ordinal))
        .Append(resolvedSqliteFilename)
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();
    var files = AppDomain.CurrentDomain.GetAssemblies()
        .Where(assembly => !assembly.IsDynamic
            && !string.IsNullOrEmpty(assembly.Location)
            && File.Exists(assembly.Location))
        .Select(assembly => (
            Managed: true,
            Name: assembly.GetName().Name!,
            Version: assembly.GetName().Version?.ToString(),
            Path: assembly.Location))
        .ToList();
    foreach (var nativeSqlite in nativeSqlitePaths)
    {
        files.Add((false, "e_sqlite3", null, nativeSqlite));
    }

    return files
        .OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase)
        .Select(file =>
        {
            var bytes = File.ReadAllBytes(file.Path);
            return (object)new
            {
                managed = file.Managed,
                name = file.Name,
                version = file.Version,
                path = file.Path.Replace('\\', '/'),
                bytes = bytes.Length,
                sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()
            };
        })
        .ToArray();
}

static object RecordSimilarContract()
{
    var action = typeof(LibraryController).GetMethod(nameof(LibraryController.GetSimilarItems))!;
    return new
    {
        actual = "pinned LibraryController.GetSimilarItems reflection contract",
        declaringType = action.DeclaringType!.FullName,
        routes = action.GetCustomAttributes<Microsoft.AspNetCore.Mvc.HttpGetAttribute>()
            .Select(attribute => new { attribute.Template, attribute.Name }).ToArray(),
        authorize = action.GetCustomAttributes<Microsoft.AspNetCore.Authorization.AuthorizeAttribute>()
            .Select(attribute => new { attribute.Policy, attribute.Roles }).ToArray(),
        parameters = action.GetParameters().Select(parameter => new
        {
            parameter.Name,
            type = parameter.ParameterType.FullName,
            required = parameter.GetCustomAttribute<System.ComponentModel.DataAnnotations.RequiredAttribute>() is not null,
            binder = parameter.GetCustomAttribute<Microsoft.AspNetCore.Mvc.ModelBinderAttribute>()?.BinderType?.FullName,
            source = parameter.GetCustomAttributes().Select(attribute => attribute.GetType().Name)
                .Where(name => name is "FromRouteAttribute" or "FromQueryAttribute").ToArray(),
            hasDefault = parameter.HasDefaultValue,
            defaultValue = parameter.HasDefaultValue ? parameter.DefaultValue : null
        }).ToArray()
    };
}

static async Task<object> RecordSimilarBinding()
{
    var binder = new CommaDelimitedCollectionModelBinder(NullLogger<CommaDelimitedCollectionModelBinder>.Instance);

    async Task<object> Bind<T>(string name, params string[] values)
    {
        var metadata = new EmptyModelMetadataProvider().GetMetadataForType(typeof(T[]));
        var action = new ActionContext(
            new DefaultHttpContext(), new RouteData(), new ActionDescriptor(), new ModelStateDictionary());
        var provider = new NamedValueProvider(name, values.Length == 0
            ? ValueProviderResult.None
            : new ValueProviderResult(new StringValues(values), CultureInfo.InvariantCulture));
        var context = DefaultModelBindingContext.CreateBindingContext(
            action, provider, metadata, bindingInfo: null, modelName: name);
        await binder.BindModelAsync(context);
        return new
        {
            name,
            inputs = values,
            context.Result.IsModelSet,
            values = context.Result.Model is T[] typed ? typed : []
        };
    }

    async Task<object> BindGuid(params string[] values)
    {
        var metadata = new EmptyModelMetadataProvider().GetMetadataForType(typeof(Guid));
        var action = new ActionContext(
            new DefaultHttpContext(), new RouteData(), new ActionDescriptor(), new ModelStateDictionary());
        var provider = new NamedValueProvider("itemId", values.Length == 0
            ? ValueProviderResult.None
            : new ValueProviderResult(new StringValues(values), CultureInfo.InvariantCulture));
        var context = DefaultModelBindingContext.CreateBindingContext(
            action, provider, metadata, bindingInfo: null, modelName: "itemId");
        await new SimpleTypeModelBinder(typeof(Guid), NullLoggerFactory.Instance).BindModelAsync(context);
        return new
        {
            inputs = values,
            context.Result.IsModelSet,
            value = context.Result.Model is Guid value ? value : (Guid?)null,
            errors = context.ModelState.Values.SelectMany(entry => entry.Errors)
                .Select(error => error.ErrorMessage.Length > 0 ? error.ErrorMessage : error.Exception?.GetType().Name)
                .ToArray()
        };
    }

    return new
    {
        actual = "pinned ASP.NET SimpleTypeModelBinder for route Guid plus CommaDelimitedCollectionModelBinder",
        itemId = new[]
        {
            await BindGuid(),
            await BindGuid(""),
            await BindGuid("00000000-0000-0000-0000-000000000000"),
            await BindGuid("bad"),
            await BindGuid("91000000-0000-0000-0000-000000000001")
        },
        excludeArtistIds = new[]
        {
            await Bind<Guid>("ExcludeArtistIds"),
            await Bind<Guid>("ExcludeArtistIds", ""),
            await Bind<Guid>("ExcludeArtistIds", "91000000-0000-0000-0000-000000000091,bad,91000000000000000000000000000092"),
            await Bind<Guid>("ExcludeArtistIds", "91000000-0000-0000-0000-000000000091", "bad"),
            await Bind<Guid>("ExcludeArtistIds", "91000000-0000-0000-0000-000000000091,bad", "91000000-0000-0000-0000-000000000092")
        },
        fields = new[]
        {
            await Bind<ItemFields>("Fields"),
            await Bind<ItemFields>("Fields", "SortName,bad,ParentId"),
            await Bind<ItemFields>("Fields", "SortName", "bad")
        }
    };
}

static async Task<object> RecordSimilarHttp()
{
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var libraryProxy = (LibraryProxy)(object)library;
    BaseItem.LibraryManager = library;
    var realLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(
        realLibrary,
        new IBaseItemComparer[] { new SortNameComparer(), new AiredEpisodeOrderComparer() });
    libraryProxy.Real = realLibrary;
    Seed(libraryProxy);
    var user = new User("shows-reader", "fixture-auth", "fixture-reset")
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000090")
    };
    var userManager = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    ((UserManagerProxy)(object)userManager).User = user;
    var dtoService = DispatchProxy.Create<IDtoService, DtoProxy>();
    var similarManager = DispatchProxy.Create<ISimilarItemsManager, SimilarManagerProxy>();
    var similarProxy = (SimilarManagerProxy)(object)similarManager;
    similarProxy.Controlled = [libraryProxy.Items["duplicateSeries"]];
    var controller = new LibraryController(
        DispatchProxy.Create<IProviderManager, UnsupportedProxy>(),
        similarManager,
        library,
        userManager,
        DispatchProxy.Create<ICollectionManager, UnsupportedProxy>(),
        dtoService,
        DispatchProxy.Create<IActivityManager, UnsupportedProxy>(),
        DispatchProxy.Create<ILocalizationManager, UnsupportedProxy>(),
        DispatchProxy.Create<ILibraryMonitor, UnsupportedProxy>(),
        NullLogger<LibraryController>.Instance,
        configuration, DispatchProxy.Create<IHttpClientFactory, UnsupportedProxy>());
    var environment = DispatchProxy.Create<IWebHostEnvironment, HostEnvironmentProxy>();

    async Task<object> Run(string name, string path, Guid? requestedUser, bool throwManager)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(InternalClaimTypes.UserId, user.Id.ToString("N")), new Claim(InternalClaimTypes.IsApiKey, "False")],
            "oracle"));
        controller.ControllerContext = new ControllerContext { HttpContext = context };
        similarProxy.Throw = throwManager;
        var middleware = new ExceptionMiddleware(
            async _ => { await controller.GetSimilarItems(libraryProxy.Ids["series"], [], requestedUser, null, [], CancellationToken.None); },
            NullLogger<ExceptionMiddleware>.Instance,
            configuration,
            environment);
        await middleware.Invoke(context);
        context.Response.Body.Position = 0;
        var body = await new StreamReader(context.Response.Body, Encoding.UTF8).ReadToEndAsync();
        return new { name, status = context.Response.StatusCode, contentType = context.Response.ContentType, body };
    }

    return new
    {
        actual = "pinned LibraryController.GetSimilarItems + RequestHelpers + ExceptionMiddleware",
        crossUser = await Run("cross-user SecurityException", "/Shows/series/Similar", libraryProxy.Ids["missingUser"], false),
        managerFailure = await Run("manager failure", "/Shows/series/Similar", null, true)
    };
}

static async Task<object> RecordLocalSimilarProviders()
{
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var proxy = (LibraryProxy)(object)library;
    BaseItem.LibraryManager = library;
    var realLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(
        realLibrary,
        new IBaseItemComparer[] { new SortNameComparer(), new AiredEpisodeOrderComparer() });
    proxy.Real = realLibrary;
    Seed(proxy);
    var user = new User("similar-reader", "fixture-auth", "fixture-reset")
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000090")
    };
    var defaults = new SimilarItemsQuery();
    var officialDefaults = new
    {
        user = defaults.User?.Username,
        defaults.Limit,
        dtoOptions = defaults.DtoOptions,
        defaults.ExcludeItemIds,
        defaults.ExcludeArtistIds
    };
    async Task<object> Capture(
        string itemType,
        BaseItem source,
        string name,
        MetadataPluginType type,
        Func<SimilarItemsQuery, CancellationToken, Task<IReadOnlyList<BaseItem>>> invoke)
    {
        proxy.Queries.Clear();
        await invoke(defaults, CancellationToken.None);
        var defaultCalls = proxy.Queries.ToArray();

        var configured = new SimilarItemsQuery
        {
            User = user,
            Limit = 7,
            DtoOptions = new DtoOptions { Fields = [ItemFields.SortName] },
            ExcludeItemIds = [source.Id, proxy.Ids["duplicateSeries"]],
            ExcludeArtistIds = [Guid.Parse("91000000-0000-0000-0000-000000000091")]
        };
        proxy.Queries.Clear();
        await invoke(configured, CancellationToken.None);
        return new { itemType, name, type, defaultCalls, configuredCalls = proxy.Queries.ToArray() };
    }

    var series = new SeriesSimilarItemsProvider(library);
    var artist = new MusicArtistSimilarItemsProvider(library);
    var album = new MusicAlbumSimilarItemsProvider(library);
    var audio = new AudioSimilarItemsProvider(library);
    var providers = new object[]
    {
        await Capture("Series", proxy.Items["series"], series.Name, series.Type,
            (query, token) => series.GetSimilarItemsAsync((Series)proxy.Items["series"], query, token)),
        await Capture("MusicArtist", proxy.Items["musicArtist"], artist.Name, artist.Type,
            (query, token) => artist.GetSimilarItemsAsync((MusicArtist)proxy.Items["musicArtist"], query, token)),
        await Capture("MusicAlbum", proxy.Items["musicAlbum"], album.Name, album.Type,
            (query, token) => album.GetSimilarItemsAsync((MusicAlbum)proxy.Items["musicAlbum"], query, token)),
        await Capture("Audio", proxy.Items["audio"], audio.Name, audio.Type,
            (query, token) => audio.GetSimilarItemsAsync((Audio)proxy.Items["audio"], query, token))
    };

    return new
    {
        actual = "pinned Series, MusicArtist, MusicAlbum and Audio local similar providers with controlled ILibraryManager seam",
        officialDefaults,
        providers
    };
}



static async Task<object> RecordSimilarItemsManager(string filename)
{
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    var appHost = DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>();
    var factory = new SqlFactory(filename);
    var allowedTop = Guid.Parse("93000000-0000-0000-0000-000000000080");
    var deniedTop = Guid.Parse("93000000-0000-0000-0000-000000000081");
    var sourceId = Guid.Parse("93000000-0000-0000-0000-000000000001");
    var allowedId = Guid.Parse("93000000-0000-0000-0000-000000000010");
    var deniedId = Guid.Parse("93000000-0000-0000-0000-000000000011");
    var duplicateId = Guid.Parse("93000000-0000-0000-0000-000000000012");
    using (var context = factory.CreateDbContext())
    {
        context.Database.EnsureCreated();
        context.BaseItems.AddRange(
            Row(sourceId, "manager-source", "manager-source-key", allowedTop),
            Row(allowedId, "manager-allowed", "manager-shared-key", allowedTop),
            Row(deniedId, "manager-denied", "manager-denied-key", deniedTop),
            Row(duplicateId, "manager-duplicate-key", "manager-shared-key", allowedTop));
        context.SaveChanges();
    }

    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var libraryProxy = (LibraryProxy)(object)library;
    libraryProxy.AccessTopParentIds = [allowedTop];
    BaseItem.LibraryManager = library;
    BaseItem Make(Guid id, string name, string key) => new Series
    {
        Id = id,
        Name = name,
        SortName = name,
        PresentationUniqueKey = key,
        Children = []
    };
    var source = Make(sourceId, "manager-source", "manager-source-key");
    var allowed = Make(allowedId, "manager-allowed", "manager-shared-key");
    var denied = Make(deniedId, "manager-denied", "manager-denied-key");
    var duplicate = Make(duplicateId, "manager-duplicate-key", "manager-shared-key");
    var provider = new ControlledSeriesProvider { Controlled = [allowed, denied, duplicate] };
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration,
        NullLogger<BaseItemRepository>.Instance);
    var manager = new SimilarItemsManager(
        NullLogger<SimilarItemsManager>.Instance,
        DispatchProxy.Create<IServerApplicationPaths, UnsupportedProxy>(),
        library,
        BaseItem.FileSystem,
        configuration,
        factory,
        repository);
    manager.AddParts([provider]);
    var user = new User("similar-reader", "fixture-auth", "fixture-reset")
    {
        Id = Guid.Parse("93000000-0000-0000-0000-000000000090")
    };

    provider.Queries.Clear();
    var options = new DtoOptions { Fields = [ItemFields.SortName] };
    var userResults = await manager.GetSimilarItemsAsync(
        source,
        [Guid.Parse("93000000-0000-0000-0000-000000000099")],
        user,
        options,
        null,
        new LibraryOptions(),
        CancellationToken.None);
    var defaultProviderQueries = provider.Queries.ToArray();

    provider.Queries.Clear();
    provider.Controlled = [denied, allowed];
    var limitedAfterAccess = await manager.GetSimilarItemsAsync(
        source, [], user, new DtoOptions(), 1, new LibraryOptions(), CancellationToken.None);
    var limitProviderQueries = provider.Queries.ToArray();

    provider.Queries.Clear();
    provider.Controlled = [allowed, allowed, duplicate];
    var deduplicated = await manager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 50, new LibraryOptions(), CancellationToken.None);
    var dedupeProviderQueries = provider.Queries.ToArray();

    provider.Queries.Clear();
    var negative = await manager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), -1, new LibraryOptions(), CancellationToken.None);
    var negativeProviderQueries = provider.Queries.ToArray();

    provider.Queries.Clear();
    var zero = await manager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 0, new LibraryOptions(), CancellationToken.None);
    var zeroProviderQueries = provider.Queries.ToArray();

    File.Delete(filename);
    return new
    {
        actual = "pinned SimilarItemsManager + controlled local provider + concrete BaseItemRepository access filter over EF Core SQLite",
        defaultLimitAndAccess = new
        {
            items = userResults.Select(item => item.Name),
            dtoFieldsAfterManager = options.Fields,
            providerQueries = defaultProviderQueries
        },
        limitedBeforeAccessFilter = new
        {
            items = limitedAfterAccess.Select(item => item.Name),
            providerQueries = limitProviderQueries
        },
        idAndPresentationKeyDeduplication = new
        {
            items = deduplicated.Select(item => item.Name),
            providerQueries = dedupeProviderQueries
        },
        negativeLimit = new
        {
            items = negative.Select(item => item.Name),
            providerQueries = negativeProviderQueries
        },
        zeroLimit = new
        {
            items = zero.Select(item => item.Name),
            providerQueries = zeroProviderQueries
        }
    };

    BaseItemEntity Row(Guid id, string name, string presentationKey, Guid topParentId)
        => new()
        {
            Id = id,
            Type = typeof(Series).FullName!,
            Name = name,
            SortName = name,
            PresentationUniqueKey = presentationKey,
            TopParentId = topParentId,
            Data = "{}",
            MediaType = "Unknown",
            IsFolder = true,
            IsSeries = true
        };
}

static async Task<object> RecordSimilarProviderOrchestration(string root)
{
    if (Directory.Exists(root))
    {
        Directory.Delete(root, true);
    }

    Directory.CreateDirectory(root);
    var cacheRoot = Path.Combine(root, "cache");
    Directory.CreateDirectory(cacheRoot);
    var databasePath = Path.Combine(root, "manager.sqlite");
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var fileSystem = (ManagedFileSystem)RuntimeHelpers.GetUninitializedObject(typeof(ManagedFileSystem));
    BaseItem.FileSystem = fileSystem;
    var paths = DispatchProxy.Create<IServerApplicationPaths, SimilarPathsProxy>();
    ((SimilarPathsProxy)(object)paths).Cache = cacheRoot;
    var appHost = DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>();
    var factory = new SqlFactory(databasePath);
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration,
        NullLogger<BaseItemRepository>.Instance);
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var libraryProxy = (LibraryProxy)(object)library;
    BaseItem.LibraryManager = library;
    var realLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(
        realLibrary,
        new IBaseItemComparer[] { new SortNameComparer(), new AiredEpisodeOrderComparer() });
    libraryProxy.Real = realLibrary;

    Series Item(int suffix, string name, string key, string? tmdb = null, string? batch = null)
    {
        var item = new Series
        {
            Id = Guid.Parse($"95000000-0000-0000-0000-{suffix.ToString(CultureInfo.InvariantCulture).PadLeft(12, '0')}"),
            Name = name,
            SortName = name,
            PresentationUniqueKey = key,
            Children = []
        };
        if (tmdb is not null)
        {
            item.SetProviderId(MetadataProvider.Tmdb, tmdb);
        }

        if (batch is not null)
        {
            item.SetProviderId("BatchKey", batch);
        }

        libraryProxy.Items[name] = item;
        return item;
    }

    var source = Item(1, "remote-source", "remote-source-key", "42");
    var remoteOne = Item(2, "remote-one", "remote-one-key", "101");
    var remoteTwo = Item(3, "remote-two", "remote-two-key", "102");
    var localOne = Item(4, "local-one", "local-one-key");
    var localTwo = Item(5, "local-two", "local-two-key");
    var localThree = Item(6, "local-three", "local-three-key");

    var pluginConfiguration = new TmdbPluginConfiguration
    {
        TmdbApiKey = "oracle-key",
        SimilarItemsCacheDays = 14
    };
    var plugin = (TmdbPlugin)RuntimeHelpers.GetUninitializedObject(typeof(TmdbPlugin));
    typeof(BasePlugin<TmdbPluginConfiguration>)
        .GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(plugin, pluginConfiguration);
    typeof(TmdbPlugin).GetProperty("Instance")!.SetValue(null, plugin);

    var handler = new TmdbRecordingHttpHandler();
    var rawTmdbClient = new TMDbClient("oracle-key", false, "http://tmdb.invalid/3", null, null)
    {
        ThrowApiExceptions = false
    };
    var tmdbClientType = typeof(TMDbClient);
    var serializer = tmdbClientType.GetField("_serializer", BindingFlags.Instance | BindingFlags.NonPublic)!
        .GetValue(rawTmdbClient);
    var restClientType = tmdbClientType.Assembly.GetType("TMDbLib.Rest.RestClient")!;
    var originalRestClient = tmdbClientType.GetField("_client", BindingFlags.Instance | BindingFlags.NonPublic)!
        .GetValue(rawTmdbClient);
    var controlledRestClient = Activator.CreateInstance(
        restClientType,
        BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
        null,
        [new Uri("http://tmdb.invalid/3/"), serializer!, null!, handler],
        CultureInfo.InvariantCulture);
    var defaultQueryProperty = restClientType.GetProperty(
        "DefaultQueryString",
        BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;
    var originalDefaultQuery = (IEnumerable<KeyValuePair<string, string>>)defaultQueryProperty.GetValue(originalRestClient)!;
    var controlledDefaultQuery = (ICollection<KeyValuePair<string, string>>)defaultQueryProperty.GetValue(controlledRestClient)!;
    foreach (var entry in originalDefaultQuery)
    {
        controlledDefaultQuery.Add(entry);
    }
    tmdbClientType.GetField("_httpMessageHandler", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(rawTmdbClient, handler);
    tmdbClientType.GetField("_client", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(rawTmdbClient, controlledRestClient);
    using var tmdbClientManager = new TmdbClientManager();
    typeof(TmdbClientManager).GetField("_tmDbClient", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(tmdbClientManager, rawTmdbClient);
    var tmdbProvider = new TmdbSeriesSimilarProvider(
        tmdbClientManager,
        NullLogger<TmdbSeriesSimilarProvider>.Instance);

    SimilarItemsManager Manager(params ISimilarItemsProvider[] providers)
    {
        var manager = new SimilarItemsManager(
            NullLogger<SimilarItemsManager>.Instance,
            paths,
            library,
            fileSystem,
            configuration,
            factory,
            repository);
        manager.AddParts(providers);
        return manager;
    }

    var calculateScore = typeof(SimilarItemsManager).GetMethod(
        "CalculateScore",
        BindingFlags.Static | BindingFlags.NonPublic)!;
    object ScoreCase(string name, float? matchScore, int providerOrder, int position)
    {
        var value = (float)calculateScore.Invoke(null, [matchScore, providerOrder, position])!;
        return new
        {
            name,
            matchScore,
            matchScoreBits = matchScore.HasValue ? BitConverter.SingleToInt32Bits(matchScore.Value) : (int?)null,
            providerOrder,
            position,
            value,
            bits = BitConverter.SingleToInt32Bits(value)
        };
    }

    var scoreMath = new
    {
        cases = new[]
        {
            ScoreCase("position multiply and subtract", null, 10, 17),
            ScoreCase("provider boost multiply and add", null, 3, 17),
            ScoreCase("provided score and boost", 0.1f, 9, 400),
            ScoreCase("rounding tie first", null, 0, 28),
            ScoreCase("rounding tie second", null, 8, 26),
            ScoreCase("lower clamp", -2f, 10, 0),
            ScoreCase("upper clamp", 2f, 10, 0)
        },
        equalInputs = new
        {
            first = 0.1f,
            second = 0.100000001f,
            firstBits = BitConverter.SingleToInt32Bits(0.1f),
            secondBits = BitConverter.SingleToInt32Bits(0.100000001f)
        }
    };

    static LibraryOptions Options(string[] enabled, string[] order)
        => new()
        {
            TypeOptions =
            [
                new TypeOptions
                {
                    Type = nameof(Series),
                    SimilarItemProviders = enabled,
                    SimilarItemProviderOrder = order
                }
            ]
        };

    var local = new TraceSeriesProvider("Local Genre/Tag") { Controlled = [localOne, localTwo, localThree] };
    var remoteManager = Manager(local, tmdbProvider);
    var remoteOptions = Options(["themoviedb"], ["THEMOVIEDB", "local genre/tag"]);
    var cacheFile = Path.Combine(cacheRoot, "themoviedb-similar-series", source.Id.ToString("N") + ".json");

    handler.Mode = "success";
    handler.Requests.Clear();
    local.Calls.Clear();
    var writtenAfter = DateTime.UtcNow;
    var first = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3, remoteOptions, CancellationToken.None);
    var writtenBefore = DateTime.UtcNow;
    var firstCacheBytes = File.ReadAllBytes(cacheFile);
    var firstCacheText = Encoding.UTF8.GetString(firstCacheBytes);
    using var cache = JsonDocument.Parse(firstCacheBytes);
    var expiresAt = cache.RootElement.GetProperty("ExpiresAt").GetDateTime();
    var expiresAtToken = cache.RootElement.GetProperty("ExpiresAt").GetRawText();
    var firstSnapshot = new
    {
        items = first.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        cache = new
        {
            path = Path.GetRelativePath(cacheRoot, cacheFile).Replace('\\', '/'),
            propertyNames = cache.RootElement.EnumerateObject().Select(property => property.Name).ToArray(),
            rawJsonTemplate = firstCacheText.Replace(expiresAtToken, "\"$EXPIRES_AT\"", StringComparison.Ordinal),
            byteLength = firstCacheBytes.Length,
            utf8Bom = firstCacheBytes.AsSpan().StartsWith(Encoding.UTF8.Preamble),
            expiresAtKind = expiresAt.Kind,
            expiresAtTicks = expiresAt.Ticks.ToString(CultureInfo.InvariantCulture),
            references = cache.RootElement.GetProperty("References").EnumerateArray().Select(reference => new
            {
                providerName = reference.GetProperty("ProviderName").GetString(),
                providerId = reference.GetProperty("ProviderId").GetString(),
                score = reference.TryGetProperty("Score", out var value) && value.ValueKind != JsonValueKind.Null
                    ? value.GetSingle()
                    : (float?)null
            }).ToArray(),
            expiresWithinConfiguredWindow = expiresAt >= writtenAfter.AddDays(14).AddSeconds(-1)
                && expiresAt <= writtenBefore.AddDays(14).AddSeconds(1)
        }
    };

    handler.Requests.Clear();
    local.Calls.Clear();
    var cached = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3, remoteOptions, CancellationToken.None);
    var cachedSnapshot = new
    {
        items = cached.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray()
    };

    async Task<object> CachedScoreScenario(string firstScore, string secondScore)
    {
        var original = $$"""{"References":[{"ProviderName":"Tmdb","ProviderId":"101","Score":{{firstScore}}},{"ProviderName":"Tmdb","ProviderId":"102","Score":{{secondScore}}}],"ExpiresAt":"9999-12-31T23:59:59.9999999Z"}""";
        File.WriteAllText(cacheFile, original);
        handler.Mode = "success";
        handler.Requests.Clear();
        local.Calls.Clear();
        var items = await remoteManager.GetSimilarItemsAsync(
            source, [], null, new DtoOptions(), 2, remoteOptions, CancellationToken.None);
        var replacement = File.ReadAllText(cacheFile);
        return new
        {
            items = items.Select(item => item.Name),
            requests = handler.Requests.ToArray(),
            localCalls = local.Calls.ToArray(),
            originalCacheRetained = string.Equals(original, replacement, StringComparison.Ordinal),
            replacementHasScores = replacement.Contains("\"Score\"", StringComparison.Ordinal),
            temporaryFiles = Directory.GetFiles(Path.GetDirectoryName(cacheFile)!, "*.tmp").Length
        };
    }

    var numericStringScores = await CachedScoreScenario("\"0.25\"", "\"0.75\"");
    var exactDecimalMidpointScores = await CachedScoreScenario("\"0.5\"", "\"0.5000000298023224\"");
    var invalidStringScore = await CachedScoreScenario("\"not-a-score\"", "\"0.75\"");
    var singleOverflowScore = await CachedScoreScenario("\"3.5e38\"", "\"0.75\"");

    File.WriteAllText(cacheFile, "{");
    handler.Requests.Clear();
    local.Calls.Clear();
    var corrupt = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3, remoteOptions, CancellationToken.None);
    var corruptReplacementBytes = File.ReadAllBytes(cacheFile);
    var corruptSnapshot = new
    {
        items = corrupt.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        replacementIsJson = JsonDocument.Parse(corruptReplacementBytes).RootElement.ValueKind == JsonValueKind.Object,
        temporaryFiles = Directory.GetFiles(Path.GetDirectoryName(cacheFile)!, "*.tmp").Length
    };

    File.WriteAllText(cacheFile, JsonSerializer.Serialize(new
    {
        References = new[] { new SimilarItemReference { ProviderName = "Tmdb", ProviderId = "101" } },
        ExpiresAt = DateTime.UtcNow.AddDays(-1)
    }));
    handler.Requests.Clear();
    local.Calls.Clear();
    var expired = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3, remoteOptions, CancellationToken.None);
    using var expiredReplacement = JsonDocument.Parse(File.ReadAllBytes(cacheFile));
    var expiredSnapshot = new
    {
        items = expired.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        replacementExpiresInFuture = DateTime.UtcNow < expiredReplacement.RootElement.GetProperty("ExpiresAt").GetDateTime(),
        temporaryFiles = Directory.GetFiles(Path.GetDirectoryName(cacheFile)!, "*.tmp").Length
    };

    File.Delete(cacheFile);
    handler.Mode = "unresolved";
    handler.Requests.Clear();
    local.Calls.Clear();
    var unresolved = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 2, remoteOptions, CancellationToken.None);
    var unresolvedSnapshot = new
    {
        sourceTmdbId = source.GetProviderId(MetadataProvider.Tmdb),
        items = unresolved.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        cacheExists = File.Exists(cacheFile)
    };

    File.Delete(cacheFile);
    handler.Mode = "null";
    handler.Requests.Clear();
    local.Calls.Clear();
    var nullResponse = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 2, remoteOptions, CancellationToken.None);
    var nullSnapshot = new
    {
        items = nullResponse.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        cacheExists = File.Exists(cacheFile)
    };

    handler.Mode = "throw";
    handler.Requests.Clear();
    local.Calls.Clear();
    var httpFailure = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 2, remoteOptions, CancellationToken.None);
    var httpFailureSnapshot = new
    {
        items = httpFailure.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        cacheExists = File.Exists(cacheFile)
    };

    handler.Mode = "rate-limit";
    handler.Requests.Clear();
    local.Calls.Clear();
    var rateLimited = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 2, remoteOptions, CancellationToken.None);
    var rateLimitedSnapshot = new
    {
        items = rateLimited.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        cacheExists = File.Exists(cacheFile)
    };

    handler.Mode = "server-error";
    handler.Requests.Clear();
    local.Calls.Clear();
    var serverError = await remoteManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 2, remoteOptions, CancellationToken.None);
    var serverErrorSnapshot = new
    {
        items = serverError.Select(item => item.Name),
        requests = handler.Requests.ToArray(),
        localCalls = local.Calls.ToArray(),
        cacheExists = File.Exists(cacheFile)
    };

    var orderCalls = new List<object>();
    var orderFirst = new TraceSeriesProvider("First", orderCalls) { Controlled = [localOne] };
    var orderSecond = new TraceSeriesProvider("Second", orderCalls) { Controlled = [localTwo] };
    var orderThird = new TraceSeriesProvider("Third", orderCalls) { Controlled = [localThree] };
    var orderedManager = Manager(orderFirst, orderSecond, orderThird);
    var ordered = await orderedManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3,
        Options([], ["sEcOnD", "FIRST", "third"]), CancellationToken.None);
    var configuredOrder = new { items = ordered.Select(item => item.Name), calls = orderCalls.ToArray() };

    orderCalls.Clear();
    var stable = await orderedManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3,
        Options([], ["unregistered"]), CancellationToken.None);
    var stableOrder = new { items = stable.Select(item => item.Name), calls = orderCalls.ToArray() };

    var stableFloatProvider = new TraceScoredRemoteSeriesProvider(
        "Float Scores",
        [
            new SimilarItemReference { ProviderName = "Tmdb", ProviderId = "101", Score = 0.1f },
            new SimilarItemReference { ProviderName = "Tmdb", ProviderId = "102", Score = 0.100000001f }
        ]);
    var stableFloatScores = await Manager(stableFloatProvider).GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 2,
        Options(["fLoAt ScOrEs"], []), CancellationToken.None);
    var stableFloatScoreOrder = new
    {
        items = stableFloatScores.Select(item => item.Name),
        stableFloatProvider.Yielded
    };

    var failureCalls = new List<object>();
    var failing = new TraceSeriesProvider("Failure", failureCalls) { Failure = "exception" };
    var afterFailure = new TraceSeriesProvider("After failure", failureCalls) { Controlled = [localOne, localTwo] };
    var failure = await Manager(failing, afterFailure).GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 2, new LibraryOptions(), CancellationToken.None);
    var failureBoundary = new { items = failure.Select(item => item.Name), calls = failureCalls.ToArray() };

    var cancellationCalls = new List<object>();
    var beforeCancellation = new TraceSeriesProvider("Before cancellation", cancellationCalls) { Controlled = [localOne] };
    var cancelling = new TraceSeriesProvider("Cancellation", cancellationCalls) { Failure = "cancellation" };
    var afterCancellation = new TraceSeriesProvider("After cancellation", cancellationCalls) { Controlled = [localTwo] };
    var cancellationManager = Manager(beforeCancellation, cancelling, afterCancellation);
    var cancelled = await cancellationManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3, new LibraryOptions(), CancellationToken.None);
    var cancellationBoundary = new { items = cancelled.Select(item => item.Name), calls = cancellationCalls.ToArray() };
    cancellationCalls.Clear();
    using var alreadyCancelled = new CancellationTokenSource();
    alreadyCancelled.Cancel();
    var preCancelled = await cancellationManager.GetSimilarItemsAsync(
        source, [], null, new DtoOptions(), 3, new LibraryOptions(), alreadyCancelled.Token);
    var preCancellationBoundary = new { items = preCancelled.Select(item => item.Name), calls = cancellationCalls.ToArray() };

    async Task<object> Batch(int count, int limit, bool resolve)
    {
        libraryProxy.RemoteProviderQuerySizes.Clear();
        var provider = new TraceRemoteSeriesProvider("Batch Remote", count);
        if (resolve)
        {
            Item(90, "batch-zero", "batch-zero-key", batch: "000");
            Item(91, "batch-one", "batch-one-key", batch: "001");
        }

        var items = await Manager(provider).GetSimilarItemsAsync(
            source, [], null, new DtoOptions(), limit,
            Options(["bAtCh ReMoTe"], []), CancellationToken.None);
        return new
        {
            count,
            limit,
            resolve,
            provider.Yielded,
            provider.Calls,
            querySizes = libraryProxy.RemoteProviderQuerySizes.ToArray(),
            items = items.Select(item => item.Name)
        };
    }

    var batches = new[]
    {
        await Batch(21, 2, false),
        await Batch(501, 2, false),
        await Batch(501, 2, true)
    };

    var result = new
    {
        actual = "pinned SimilarItemsManager + TmdbSeriesSimilarProvider/TMDbLib controlled transport + real file cache",
        provider = new { tmdbProvider.Name, tmdbProvider.Type, cacheDays = tmdbProvider.CacheDuration?.TotalDays },
        first = firstSnapshot,
        cacheHit = cachedSnapshot,
        numericStringScores,
        exactDecimalMidpointScores,
        invalidStringScore,
        singleOverflowScore,
        scoreMath,
        stableFloatScoreOrder,
        corruptCacheFallback = corruptSnapshot,
        expiredCacheFallback = expiredSnapshot,
        unresolvedRemoteReferences = unresolvedSnapshot,
        nullResponse = nullSnapshot,
        httpFailure = httpFailureSnapshot,
        rateLimited = rateLimitedSnapshot,
        serverError = serverErrorSnapshot,
        configuredOrder,
        stableRegistrationOrder = stableOrder,
        failureBoundary,
        cancellationBoundary,
        preCancellationBoundary,
        batches
    };
    Directory.Delete(root, true);
    return result;
}

static async Task<object> RecordGuidEmptyHttp()
{
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var library = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    var user = new User("shows-reader", "fixture-auth", "fixture-reset")
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000090")
    };
    var userManager = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    ((UserManagerProxy)(object)userManager).User = user;
    var dataManager = DispatchProxy.Create<IUserDataManager, UserDataProxy>();
    var dtoService = DispatchProxy.Create<IDtoService, DtoProxy>();
    var manager = new TVSeriesManager(dataManager, library, configuration);
    var controller = new TvShowsController(userManager, library, dtoService, manager);
    var environment = DispatchProxy.Create<IWebHostEnvironment, HostEnvironmentProxy>();

    async Task<object> Run(string name, string path, Action invoke)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(InternalClaimTypes.UserId, user.Id.ToString("N")), new Claim(InternalClaimTypes.IsApiKey, "False")],
            "oracle"));
        controller.ControllerContext = new ControllerContext { HttpContext = context };
        var middleware = new ExceptionMiddleware(
            _ => { invoke(); return Task.CompletedTask; },
            NullLogger<ExceptionMiddleware>.Instance,
            configuration,
            environment);
        await middleware.Invoke(context);
        context.Response.Body.Position = 0;
        var body = await new StreamReader(context.Response.Body, Encoding.UTF8).ReadToEndAsync();
        return new { name, status = context.Response.StatusCode, contentType = context.Response.ContentType, body };
    }

    var nextUpParent = await Run("next up Guid.Empty parent", "/Shows/NextUp", () =>
        controller.GetNextUp(null, null, null, [], null, Guid.Empty, null, null, [], null, null, true, true, false));
    var seasonsSeries = await Run("seasons Guid.Empty series", "/Shows/00000000-0000-0000-0000-000000000000/Seasons", () =>
        controller.GetSeasons(Guid.Empty, null, [], null, null, null, null, null, [], null));
    return new
    {
        actual = "pinned TvShowsController + TVSeriesManager + concrete LibraryManager + ExceptionMiddleware",
        nextUpParent,
        seasonsSeries
    };
}

static async Task<object> RecordDateTimeBinding()
{
    var binder = new DateTimeModelBinder(
        DateTimeStyles.AdjustToUniversal | DateTimeStyles.AllowWhiteSpaces,
        NullLoggerFactory.Instance);
    var metadata = new EmptyModelMetadataProvider().GetMetadataForType(typeof(DateTime?));
    async Task<object> Run(string value)
    {
        var action = new ActionContext(
            new DefaultHttpContext(), new RouteData(), new ActionDescriptor(), new ModelStateDictionary());
        var context = DefaultModelBindingContext.CreateBindingContext(
            action, new DateValueProvider(value), metadata, bindingInfo: null, modelName: "value");
        await binder.BindModelAsync(context);
        var errors = context.ModelState.Values.SelectMany(entry => entry.Errors)
            .Select(error => error.ErrorMessage.Length > 0 ? error.ErrorMessage : error.Exception?.GetType().Name)
            .ToArray();
        return new
        {
            input = value,
            context.Result.IsModelSet,
            value = context.Result.Model is DateTime date ? date.ToString("O", CultureInfo.InvariantCulture) : null,
            kind = context.Result.Model is DateTime result ? result.Kind.ToString() : null,
            errors
        };
    }

    var inputs = new[] { "", " ", "2026-10-06", "2026-10-06T00:00:00Z", "2026-10-06T00:00:00+08:00", "bad" };
    var results = new List<object>();
    foreach (var input in inputs)
    {
        results.Add(await Run(input));
    }

    return new
    {
        actual = "Microsoft.AspNetCore.Mvc DateTimeModelBinder with its provider styles and invariant query culture",
        styles = (DateTimeStyles.AdjustToUniversal | DateTimeStyles.AllowWhiteSpaces).ToString(),
        results
    };
}

static object RecordSqliteRepository(string filename)
{
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    var appHost = DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>();
    var factory = new SqlFactory(filename);
    var episodeType = typeof(Episode).FullName!;
    var seasonType = typeof(Season).FullName!;
    var primaryMissing = Guid.Parse("92000000-0000-0000-0000-000000000099");
    var nextUpUserId = Guid.Parse("92000000-0000-0000-0000-000000000090");
    var nextUpTopParent = Guid.Parse("92000000-0000-0000-0000-000000000080");
    var similarSource = Guid.Parse("92000000-0000-0000-0000-000000000050");
    var similarAllowedTop = Guid.Parse("92000000-0000-0000-0000-000000000070");
    var similarDeniedTop = Guid.Parse("92000000-0000-0000-0000-000000000071");
    using (var context = factory.CreateDbContext())
    {
        context.Database.EnsureCreated();
        context.BaseItems.AddRange(
            Row("92000000-0000-0000-0000-000000000011", "dup-primary-high", "dup", null, "b"),
            Row("92000000-0000-0000-0000-000000000010", "dup-primary-low", "dup", null, "a"),
            Row("92000000-0000-0000-0000-000000000009", "dup-alternate-lower-id", "dup", primaryMissing, "0"),
            Row("92000000-0000-0000-0000-000000000020", "unique", "unique", null, "z"));
        context.BaseItems.AddRange(
            SeasonRow("92000000-0000-0000-0000-000000000030", "season-primary-low", null, "0001", true),
            SeasonRow("92000000-0000-0000-0000-000000000031", "season-primary-high", null, "0002"),
            SeasonRow("92000000-0000-0000-0000-000000000029", "season-alternate", primaryMissing, "0000", true),
            NextUpRow("92000000-0000-0000-0000-000000000040", "next-old", 1, 0),
            NextUpRow("92000000-0000-0000-0000-000000000041", "next-last", 1, 1),
            NextUpRow("92000000-0000-0000-0000-000000000042", "next-candidate", 1, 2),
            NextUpRow("92000000-0000-0000-0000-000000000043", "next-virtual", 1, 3, true),
            NextUpRow("92000000-0000-0000-0000-000000000044", "next-special", 0, 1));
        context.BaseItems.AddRange(
            SimilarRow(similarSource, "similar-source", "similar-source", "00", similarAllowedTop),
            SimilarRow(Guid.Parse("92000000-0000-0000-0000-000000000051"), "similar-both", "similar-both", "01", similarAllowedTop),
            SimilarRow(Guid.Parse("92000000-0000-0000-0000-000000000052"), "similar-genre-only", "similar-genre-only", "02", similarAllowedTop),
            SimilarRow(Guid.Parse("92000000-0000-0000-0000-000000000053"), "similar-tag-only", "similar-tag-only", "03", similarAllowedTop),
            SimilarRow(Guid.Parse("92000000-0000-0000-0000-000000000054"), "similar-neither", "similar-neither", "04", similarAllowedTop),
            SimilarRow(Guid.Parse("92000000-0000-0000-0000-000000000055"), "similar-duplicate-low", "similar-shared", "05", similarAllowedTop),
            SimilarRow(Guid.Parse("92000000-0000-0000-0000-000000000056"), "similar-duplicate-high", "similar-shared", "06", similarAllowedTop),
            SimilarRow(Guid.Parse("92000000-0000-0000-0000-000000000057"), "similar-denied", "similar-denied", "07", similarDeniedTop));
        AddItemValue("92000000-0000-0000-0000-000000000901", ItemValueType.Genre, "Drama",
            similarSource, Id("051"), Id("052"), Id("056"), Id("057"));
        AddItemValue("92000000-0000-0000-0000-000000000902", ItemValueType.Genre, "Mystery", Id("055"));
        AddItemValue("92000000-0000-0000-0000-000000000903", ItemValueType.Genre, "Comedy", Id("054"));
        AddItemValue("92000000-0000-0000-0000-000000000911", ItemValueType.Tags, "Network",
            similarSource, Id("051"), Id("053"), Id("056"), Id("057"));
        AddItemValue("92000000-0000-0000-0000-000000000912", ItemValueType.Tags, "Epic", Id("055"));
        AddItemValue("92000000-0000-0000-0000-000000000913", ItemValueType.Tags, "Other", Id("054"));
        var persistedUser = new User("sqlite-reader", "fixture-auth", "fixture-reset")
        {
            Id = nextUpUserId,
            InternalId = 1
        };
        context.Users.Add(persistedUser);
        context.UserData.AddRange(
            Data("92000000-0000-0000-0000-000000000040", true, new DateTime(2026, 10, 7, 0, 0, 0, DateTimeKind.Utc)),
            Data("92000000-0000-0000-0000-000000000041", true, new DateTime(2026, 10, 6, 0, 0, 0, DateTimeKind.Utc)),
            Data("92000000-0000-0000-0000-000000000042", false, null, 1000));
        context.SaveChanges();

        Guid Id(string suffix) => Guid.Parse($"92000000-0000-0000-0000-000000000{suffix}");
        void AddItemValue(string valueId, ItemValueType type, string value, params Guid[] itemIds)
        {
            var entity = new ItemValue
            {
                ItemValueId = Guid.Parse(valueId), Type = type, Value = value, CleanValue = value.ToLowerInvariant()
            };
            context.ItemValues.Add(entity);
            context.ItemValuesMap.AddRange(itemIds.Select(itemId => new ItemValueMap
            {
                ItemId = itemId, ItemValueId = entity.ItemValueId, Item = null!, ItemValue = entity
            }));
        }

        Jellyfin.Database.Implementations.Entities.UserData Data(string itemId, bool played, DateTime? date, long position = 0)
            => new()
            {
                ItemId = Guid.Parse(itemId), Item = null!, UserId = nextUpUserId, User = persistedUser,
                CustomDataKey = itemId, Played = played, PlayCount = played ? 1 : 0,
                LastPlayedDate = date, PlaybackPositionTicks = position
            };
    }

    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration,
        NullLogger<BaseItemRepository>.Instance);
    var order = new[] { (ItemSortBy.SortName, SortOrder.Ascending) };
    InternalItemsQuery Query(User? user = null) => new(user)
    {
        ItemIds =
        [
            Guid.Parse("92000000-0000-0000-0000-000000000011"),
            Guid.Parse("92000000-0000-0000-0000-000000000010"),
            Guid.Parse("92000000-0000-0000-0000-000000000009"),
            Guid.Parse("92000000-0000-0000-0000-000000000020")
        ],
        IncludeItemTypes = [BaseItemKind.Episode],
        OrderBy = order,
        DtoOptions = new DtoOptions(true)
    };
    var negativeLimitQuery = Query(); negativeLimitQuery.Limit = -1;
    var negativeStartQuery = Query(); negativeStartQuery.StartIndex = -1; negativeStartQuery.Limit = 2;
    var user = new User("sqlite-reader", "fixture-auth", "fixture-reset")
    {
        Id = Guid.Parse("92000000-0000-0000-0000-000000000090")
    };
    var userless = repository.GetItemList(Query()).Select(item => item.Name).ToArray();
    var grouped = repository.GetItemList(Query(user)).Select(item => item.Name).ToArray();
    var negativeLimit = repository.GetItemList(negativeLimitQuery).Select(item => item.Name).ToArray();
    var negativeStart = repository.GetItemList(negativeStartQuery).Select(item => item.Name).ToArray();
    InternalItemsQuery SeasonQuery(User? reader = null) => new(reader)
    {
        IncludeItemTypes = [BaseItemKind.Season],
        SeriesPresentationUniqueKey = "repository-seasons",
        OrderBy = order,
        DtoOptions = new DtoOptions(true)
    };
    var seasonsUserless = repository.GetItemList(SeasonQuery()).Select(item => item.Name).ToArray();
    var seasonsGrouped = repository.GetItemList(SeasonQuery(user)).Select(item => item.Name).ToArray();
    var seasonsFilteredQuery = SeasonQuery(user); seasonsFilteredQuery.IsMissing = false;
    var seasonsFilteredBeforeGrouping = repository.GetItemList(seasonsFilteredQuery).Select(item => item.Name).ToArray();
    InternalItemsQuery SimilarQuery(User? reader = null)
    {
        var query = new InternalItemsQuery(reader)
        {
            IncludeItemTypes = [BaseItemKind.Series],
            Genres = ["Drama", "Mystery"],
            Tags = ["Network", "Epic"],
            ExcludeItemIds = [similarSource],
            EnableGroupByMetadataKey = false,
            EnableTotalRecordCount = true,
            OrderBy = order,
            DtoOptions = new DtoOptions(true)
        };
        if (reader is not null)
        {
            query.TopParentIds = [similarAllowedTop];
        }

        return query;
    }
    var similarUserlessQuery = SimilarQuery();
    var similarUserless = repository.GetItemList(similarUserlessQuery).Select(item => item.Name).ToArray();
    var similarUserQuery = SimilarQuery(user);
    var similarGroupedAndAccessFiltered = repository.GetItemList(similarUserQuery).Select(item => item.Name).ToArray();
    var similarPagedQuery = SimilarQuery(user);
    similarPagedQuery.Limit = 1;
    var similarPaged = repository.GetItems(similarPagedQuery);
    var nextUpService = new NextUpService(factory, new ItemTypeLookup(), repository);
    var nextUpFilter = new InternalItemsQuery(user)
    {
        TopParentIds = [nextUpTopParent],
        DtoOptions = new DtoOptions { EnableUserData = true }
    };
    var nextUpKeys = nextUpService.GetNextUpSeriesKeys(nextUpFilter, DateTime.MinValue);
    var cutoffKeys = nextUpService.GetNextUpSeriesKeys(nextUpFilter,
        new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc));
    var nextUpBatch = nextUpService.GetNextUpEpisodesBatch(nextUpFilter, nextUpKeys, true, true)["repository-next-up"];
    var emptyParentFilter = new InternalItemsQuery(user);
    var scopeManager = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetMethod("SetTopParentIdsOrAncestors", BindingFlags.Instance | BindingFlags.NonPublic)!
        .Invoke(scopeManager, [emptyParentFilter, Array.Empty<BaseItem>()]);
    var emptyParentKeys = nextUpService.GetNextUpSeriesKeys(emptyParentFilter, DateTime.MinValue);
    var getTopParentIds = typeof(LibraryManager).GetMethod(
        "GetTopParentIdsForQuery", BindingFlags.Instance | BindingFlags.NonPublic)!;
    var liveTvView = new UserView
    {
        Id = Guid.Parse("92000000-0000-0000-0000-000000000081"),
        Name = "Live TV",
        ViewType = CollectionType.livetv,
        Children = []
    };
    var musicView = new UserView
    {
        Id = Guid.Parse("92000000-0000-0000-0000-000000000082"),
        Name = "Music",
        ViewType = CollectionType.music,
        Children = []
    };
    var liveTvParentIds = ((IEnumerable<Guid>)getTopParentIds.Invoke(scopeManager, [liveTvView, user])!).ToArray();
    var musicParentIds = ((IEnumerable<Guid>)getTopParentIds.Invoke(scopeManager, [musicView, user])!).ToArray();
    File.Delete(filename);
    return new
    {
        actual = "pinned BaseItemRepository + EF Core SQLite",
        userless,
        grouped,
        seasonsUserless,
        seasonsGrouped,
        seasonsFilteredBeforeGrouping,
        similar = new
        {
            actual = "same concrete repository, deterministic SortName substituted for provider Random to isolate genre/tag, grouping, access, paging and total-count semantics",
            userless = similarUserless,
            groupedAndAccessFiltered = similarGroupedAndAccessFiltered,
            paged = similarPaged.Items.Select(item => item.Name),
            similarPaged.TotalRecordCount,
            similarPaged.StartIndex,
            defaults = new
            {
                similarUserlessQuery.ParentId,
                similarUserlessQuery.Recursive,
                similarUserlessQuery.SearchTerm,
                similarUserlessQuery.GroupByPresentationUniqueKey,
                similarUserlessQuery.EnableGroupByMetadataKey,
                similarUserlessQuery.EnableTotalRecordCount,
                similarUserlessQuery.Genres,
                similarUserlessQuery.Tags,
                similarUserlessQuery.ExcludeItemIds,
                similarUserlessQuery.IncludeItemTypes
            }
        },
        negativeLimit,
        negativeStart,
        negativeStartIndex = negativeStartQuery.StartIndex,
        negativeLimitValue = negativeLimitQuery.Limit,
        emptyParentScope = new
        {
            topParentIds = emptyParentFilter.TopParentIds.Length,
            ancestorIds = emptyParentFilter.AncestorIds.Length,
            sentinelIsNonEmpty = emptyParentFilter.AncestorIds.All(id => id != Guid.Empty),
            keys = emptyParentKeys
        },
        userViewParentScopes = new
        {
            liveTv = liveTvParentIds,
            music = musicParentIds
        },
        nextUp = new
        {
            keys = nextUpKeys,
            cutoffKeys,
            lastWatched = nextUpBatch.LastWatched?.Name,
            next = nextUpBatch.NextUp?.Name,
            specials = nextUpBatch.Specials?.Select(item => item.Name),
            lastForRewatching = nextUpBatch.LastWatchedForRewatching?.Name,
            nextForRewatching = nextUpBatch.NextPlayedForRewatching?.Name
        }
    };

    BaseItemEntity Row(string id, string name, string presentationKey, Guid? primaryVersionId, string sortName)
        => new()
        {
            Id = Guid.Parse(id), Type = episodeType, Name = name, SortName = sortName,
            PresentationUniqueKey = presentationKey, PrimaryVersionId = primaryVersionId,
            Data = "{}", MediaType = "Video", PremiereDate = new DateTime(2026, 10, 8, 0, 0, 0, DateTimeKind.Utc)
        };
    BaseItemEntity SeasonRow(string id, string name, Guid? primaryVersionId, string sortName, bool virtualItem = false)
        => new()
        {
            Id = Guid.Parse(id), Type = seasonType, Name = name, SortName = sortName,
            PresentationUniqueKey = "repository-season-001", SeriesPresentationUniqueKey = "repository-seasons",
            PrimaryVersionId = primaryVersionId, IndexNumber = 1, IsVirtualItem = virtualItem,
            Data = "{}", MediaType = "Unknown"
        };
    BaseItemEntity NextUpRow(string id, string name, int season, int episode, bool virtualItem = false)
        => new()
        {
            Id = Guid.Parse(id), Type = episodeType, Name = name, SortName = $"{season:000} - {episode:0000} - {name}",
            SeriesPresentationUniqueKey = "repository-next-up", PresentationUniqueKey = $"repository-next-{season}-{episode}",
            TopParentId = nextUpTopParent, ParentIndexNumber = season, IndexNumber = episode,
            IsVirtualItem = virtualItem, Data = "{}", MediaType = "Video"
        };
    BaseItemEntity SimilarRow(Guid id, string name, string presentationKey, string sortName, Guid topParentId)
        => new()
        {
            Id = id, Type = typeof(Series).FullName!, Name = name, SortName = sortName,
            PresentationUniqueKey = presentationKey, TopParentId = topParentId,
            Data = "{}", MediaType = "Unknown", IsFolder = true, IsSeries = true
        };
}

static object RecordTvSeriesManager()
{
    var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)configuration).Data.DisplaySpecialsWithinSeasons = true;
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.FileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    var proxy = (LibraryProxy)(object)library;
    BaseItem.LibraryManager = library;
    var realLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
    typeof(LibraryManager).GetProperty("Comparers", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(
        realLibrary,
        new IBaseItemComparer[] { new SortNameComparer(), new AiredEpisodeOrderComparer() });
    proxy.Real = realLibrary;
    Seed(proxy);
    var user = new User("shows-reader", "fixture-auth", "fixture-reset")
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000090")
    };
    var dataManager = DispatchProxy.Create<IUserDataManager, UserDataProxy>();
    var data = (UserDataProxy)(object)dataManager;
    BaseItem.UserDataManager = dataManager;
    data.Data[proxy.Ids["old"]] = new UserItemData { Key = "old", Played = true, PlayCount = 1, LastPlayedDate = new DateTime(2026, 10, 7, 0, 0, 0, DateTimeKind.Utc) };
    data.Data[proxy.Ids["one"]] = new UserItemData { Key = "one", Played = true, PlayCount = 1, LastPlayedDate = new DateTime(2026, 10, 6, 0, 0, 0, DateTimeKind.Utc) };
    data.Data[proxy.Ids["two"]] = new UserItemData { Key = "two", PlaybackPositionTicks = 1000 };
    proxy.NextUpKeys = ["shows-api-series"];
    proxy.NextUpBatches["shows-api-series"] = new MediaBrowser.Controller.Persistence.NextUpEpisodeBatchResult
    {
        LastWatched = proxy.Items["one"],
        NextUp = proxy.Items["two"],
        Specials = [proxy.Items["special"]],
        LastWatchedForRewatching = proxy.Items["old"],
        NextPlayedForRewatching = proxy.Items["one"]
    };
    proxy.UserRoot = new Folder
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000080"),
        Name = "User Root",
        Children = [proxy.Items["season1"]]
    };
    var manager = new TVSeriesManager(dataManager, library, configuration);
    var options = new DtoOptions { EnableUserData = true };

    object Run(string name, Action<NextUpQuery>? configure = null)
    {
        proxy.NextUpCalls.Clear();
        var query = new NextUpQuery { User = user, EnableResumable = true };
        configure?.Invoke(query);
        var result = manager.GetNextUp(query, options);
        return new
        {
            name,
            items = result.Items.Select(item => item.Name),
            result.TotalRecordCount,
            result.StartIndex,
            calls = proxy.NextUpCalls.ToArray()
        };
    }

    var cases = new List<object>
    {
        Run("default resumable next episode"),
        Run("resumable disabled rejects the next episode", query => query.EnableResumable = false),
        Run("rewatching adds the played successor", query => query.EnableRewatching = true),
        Run("negative paging is preserved and unbounded", query => { query.EnableRewatching = true; query.StartIndex = -1; query.Limit = -1; }),
        Run("total count can be disabled", query => query.EnableTotalRecordCount = false),
        Run("series scope bypasses key discovery", query => query.SeriesId = proxy.Ids["series"]),
        Run("missing series scope keeps unbounded key discovery", query => query.SeriesId = proxy.Ids["missingSeries"]),
        Run("non-series scope keeps unbounded key discovery", query => query.SeriesId = proxy.Ids["season1"]),
        Run("empty series key caps discovery at eleven", query => query.SeriesId = proxy.Ids["emptySeries"]),
        Run("parent scope passes the resolved parent", query => query.ParentId = proxy.Ids["season1"]),
        Run("missing parent passes an empty parent list", query => query.ParentId = proxy.Ids["missingSeason"]),
        Run("date cutoff reaches key discovery", query => query.NextUpDateCutoff = new DateTime(2026, 10, 6, 0, 0, 0, DateTimeKind.Utc))
    };
    proxy.NextUpKeys = [];
    cases.Add(Run("empty keys reset the requested start index", query => query.StartIndex = -2));
    return new
    {
        actual = "pinned TVSeriesManager with native comparers and controlled ILibraryManager/IUserDataManager seams",
        cases
    };
}

static object Snapshot(JsonElement scenario, ActionResult<QueryResult<BaseItemDto>> action, LibraryProxy library, DtoProxy dto)
{
    if (action.Result is ObjectResult error)
    {
        return new
        {
            name = scenario.GetProperty("name").GetString(),
            status = error.StatusCode,
            error = error.Value,
            queries = library.Queries,
            dto = dto.Options
        };
    }
    if (action.Result is StatusCodeResult status)
    {
        return new
        {
            name = scenario.GetProperty("name").GetString(),
            status = status.StatusCode,
            error = (object?)null,
            queries = library.Queries,
            dto = dto.Options
        };
    }

    var value = action.Value!;
    return new
    {
        name = scenario.GetProperty("name").GetString(),
        status = 200,
        startIndex = value.StartIndex,
        totalRecordCount = value.TotalRecordCount,
        items = value.Items.Select(item => item.Name),
        queries = library.Queries,
        dto = dto.Options
    };
}

static object SimilarSnapshot(
    JsonElement scenario,
    ActionResult<QueryResult<BaseItemDto>> action,
    LibraryProxy library,
    DtoProxy dto,
    IReadOnlyList<object> managerCalls)
{
    if (action.Result is ObjectResult error)
    {
        return new
        {
            name = scenario.GetProperty("name").GetString(),
            status = error.StatusCode,
            error = error.Value,
            queries = library.Queries,
            dto = dto.Options,
            managerCalls
        };
    }

    if (action.Result is StatusCodeResult status)
    {
        return new
        {
            name = scenario.GetProperty("name").GetString(),
            status = status.StatusCode,
            error = (object?)null,
            queries = library.Queries,
            dto = dto.Options,
            managerCalls
        };
    }

    var value = action.Value!;
    return new
    {
        name = scenario.GetProperty("name").GetString(),
        status = 200,
        startIndex = value.StartIndex,
        totalRecordCount = value.TotalRecordCount,
        items = value.Items.Select(item => item.Name),
        queries = library.Queries,
        dto = dto.Options,
        managerCalls
    };
}

static object ExceptionSnapshot(
    JsonElement scenario,
    Exception exception,
    LibraryProxy library,
    DtoProxy dto,
    IReadOnlyList<object> managerCalls)
    => new
    {
        name = scenario.GetProperty("name").GetString(),
        exception = exception.GetType().FullName,
        exception.Message,
        queries = library.Queries,
        dto = dto.Options,
        managerCalls
    };

static int? NullableInt(JsonElement scenario, string name)
    => scenario.TryGetProperty(name, out var value) ? value.GetInt32() : null;

static bool? NullableBool(JsonElement scenario, string name)
    => scenario.TryGetProperty(name, out var value) ? value.GetBoolean() : null;

static DateTime? NullableDate(JsonElement scenario, string name)
    => scenario.TryGetProperty(name, out var value)
        ? DateTime.Parse(value.GetString()!, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind)
        : null;

static Guid ResolveGuid(JsonElement scenario, string name, LibraryProxy library, string fallback)
{
    var key = scenario.TryGetProperty(name, out var value) ? value.GetString()! : fallback;
    return library.Ids.TryGetValue(key, out var id) ? id : Guid.Parse(key);
}

static Guid? NullableGuid(JsonElement scenario, string name, LibraryProxy library)
    => scenario.TryGetProperty(name, out _) ? ResolveGuid(scenario, name, library, "") : null;

static Guid[] Guids(JsonElement scenario, string name, LibraryProxy library)
    => scenario.TryGetProperty(name, out var values)
        ? values.EnumerateArray().Select(value => library.Ids.TryGetValue(value.GetString()!, out var id)
            ? id
            : Guid.Parse(value.GetString()!)).ToArray()
        : [];

static ItemFields[] Fields(JsonElement scenario)
    => scenario.TryGetProperty("fields", out var values)
        ? values.EnumerateArray().Select(value => Enum.Parse<ItemFields>(value.GetString()!)).ToArray()
        : [];

static ImageType[] ImageTypes(JsonElement scenario)
    => scenario.TryGetProperty("enableImageTypes", out var values)
        ? values.EnumerateArray().Select(value => Enum.Parse<ImageType>(value.GetString()!)).ToArray()
        : [];

static void Seed(LibraryProxy library)
{
    void Add(string key, BaseItem item)
    {
        library.Items[key] = item;
        library.Ids[key] = item.Id;
    }

    library.RootFolder = new AggregateFolder
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000080"),
        Name = "Aggregate Root",
        Children = []
    };
    library.UserRoot = new UserRootFolder
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000081"),
        Name = "User Root",
        Children = []
    };

    var series = new Series
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000001"),
        Name = "Fixture Show",
        SortName = "fixture show",
        PresentationUniqueKey = "shows-api-series",
        Genres = ["Drama", "Mystery"],
        Tags = ["Network", "Epic"],
        Children = []
    };
    var season0 = new Season
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000002"), Name = "Specials", SortName = "0000",
        IndexNumber = 0, SeriesId = series.Id, SeriesPresentationUniqueKey = series.PresentationUniqueKey,
        PresentationUniqueKey = "shows-api-series-000", Children = []
    };
    var season1 = new Season
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000003"), Name = "Season 1", SortName = "0001",
        IndexNumber = 1, SeriesId = series.Id, SeriesPresentationUniqueKey = series.PresentationUniqueKey,
        PresentationUniqueKey = "shows-api-series-001", Children = []
    };
    var season2 = new Season
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000004"), Name = "Season 2", SortName = "0002",
        IndexNumber = 2, SeriesId = series.Id, SeriesPresentationUniqueKey = series.PresentationUniqueKey,
        PresentationUniqueKey = "shows-api-series-002", Children = []
    };
    Add("series", series); Add("season0", season0); Add("season1", season1); Add("season2", season2);
    SetParent(series, season0); SetParent(series, season1); SetParent(series, season2);

    Episode Episode(string key, string id, Season season, int index, string sortName)
    {
        var episode = new Episode
        {
            Id = Guid.Parse(id), Name = key, SortName = sortName, SeasonId = season.Id, SeriesId = series.Id,
            ParentIndexNumber = season.IndexNumber, IndexNumber = index,
            SeriesPresentationUniqueKey = series.PresentationUniqueKey, PresentationUniqueKey = $"shows-api-{key}",
            Path = $"Z:\\Shows\\Fixture\\{key}.mkv"
        };
        Add(key, episode); SetParent(season, episode); return episode;
    }

    Episode("old", "91000000-0000-0000-0000-000000000010", season1, 0, "001 - 0000 - old");
    var special = Episode("special", "91000000-0000-0000-0000-000000000011", season0, 1, "000 - 0001 - special");
    special.AirsAfterSeasonNumber = 1;
    Episode("one", "91000000-0000-0000-0000-000000000012", season1, 1, "001 - 0001 - one");
    Episode("two", "91000000-0000-0000-0000-000000000013", season1, 2, "001 - 0002 - two");
    var missing = Episode("missing", "91000000-0000-0000-0000-000000000014", season1, 3, "001 - 0003 - missing");
    missing.Path = null; missing.IsVirtualItem = true;
    Episode("three", "91000000-0000-0000-0000-000000000015", season2, 1, "002 - 0001 - three");
    var flagOnly = Episode("flagOnly", "91000000-0000-0000-0000-000000000017", season1, 4, "001 - 0004 - flag-only");
    flagOnly.IsVirtualItem = true;
    var pathOnly = Episode("pathOnly", "91000000-0000-0000-0000-000000000018", season1, 5, "001 - 0005 - path-only");
    pathOnly.Path = null;
    var seasonMissing = new Season
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000019"), Name = "Missing Season", SortName = "0003",
        IndexNumber = 3, SeriesId = series.Id, SeriesPresentationUniqueKey = series.PresentationUniqueKey,
        PresentationUniqueKey = "shows-api-series-003", IsVirtualItem = true, Children = []
    };
    var seasonNull = new Season
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000020"), Name = "Unnumbered Season", SortName = "9999",
        SeriesId = series.Id, SeriesPresentationUniqueKey = series.PresentationUniqueKey,
        PresentationUniqueKey = "shows-api-series-null", Children = []
    };
    Add("seasonMissing", seasonMissing); Add("seasonNull", seasonNull);
    SetParent(series, seasonMissing); SetParent(series, seasonNull);

    var duplicateSeries = new Series
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000030"), Name = "Duplicate Show",
        SortName = "duplicate show", PresentationUniqueKey = "duplicate-series", Children = []
    };
    Add("duplicateSeries", duplicateSeries);
    Add("emptySeries", new Series
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000034"), Name = "Empty Key Show",
        SortName = "empty key show", PresentationUniqueKey = "", Children = []
    });
    Season DuplicateSeason(string key, string id, string name, string sortName)
    {
        var season = new Season
        {
            Id = Guid.Parse(id), Name = name, SortName = sortName, IndexNumber = 1,
            SeriesId = duplicateSeries.Id, SeriesPresentationUniqueKey = duplicateSeries.PresentationUniqueKey,
            PresentationUniqueKey = "duplicate-series-001", Children = []
        };
        Add(key, season); SetParent(duplicateSeries, season); return season;
    }
    DuplicateSeason("duplicateSeason", "91000000-0000-0000-0000-000000000031", "Duplicate Season", "0001").IsVirtualItem = true;
    DuplicateSeason("duplicateSeasonAlternate", "91000000-0000-0000-0000-000000000032", "Duplicate Season Alternate", "0000").IsVirtualItem = true;
    DuplicateSeason("duplicateSeasonHigh", "91000000-0000-0000-0000-000000000033", "Duplicate Season High", "0002");
    Add("alternate", new Movie
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000016"), Name = "two-alt",
        PrimaryVersionId = Guid.Parse("91000000-0000-0000-0000-000000000013")
    });
    Add("genre", new Genre
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000035"), Name = "Drama", SortName = "drama"
    });
    Add("musicArtist", new MusicArtist
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000036"), Name = "Fixture Artist",
        SortName = "fixture artist", Genres = ["Drama", "Mystery"], Tags = ["Network", "Epic"], Children = []
    });
    Add("musicAlbum", new MusicAlbum
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000037"), Name = "Fixture Album",
        SortName = "fixture album", Genres = ["Drama", "Mystery"], Tags = ["Network", "Epic"], Children = []
    });
    Add("audio", new Audio
    {
        Id = Guid.Parse("91000000-0000-0000-0000-000000000038"), Name = "Fixture Audio",
        SortName = "fixture audio", Genres = ["Drama", "Mystery"], Tags = ["Network", "Epic"]
    });
    library.Ids["missingSeries"] = Guid.Parse("91000000-0000-0000-0000-000000000097");
    library.Ids["missingSeason"] = Guid.Parse("91000000-0000-0000-0000-000000000098");
    library.Ids["missingUser"] = Guid.Parse("91000000-0000-0000-0000-000000000099");
}

static void SetParent(Folder parent, BaseItem child)
{
    child.SetParent(parent);
    parent.Children = parent.Children.Append(child).ToArray();
}

public class ConfigurationProxy : DispatchProxy
{
    public ServerConfiguration Data = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args)
        => method!.Name == "get_Configuration" ? Data : throw new NotSupportedException(method.Name);
}

public class ApplicationHostProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name is "ExpandVirtualPath" or "ReverseVirtualPath") return args![0];
        return method.ReturnType == typeof(void) ? null
            : method.ReturnType.IsValueType ? Activator.CreateInstance(method.ReturnType) : null;
    }
}

public class HostEnvironmentProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "get_EnvironmentName") return "Production";
        if (method.Name.StartsWith("get_", StringComparison.Ordinal)) return null;
        if (method.Name.StartsWith("set_", StringComparison.Ordinal)) return null;
        throw new NotSupportedException(method.Name);
    }
}

public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext() => new(
        new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}

public class UserManagerProxy : DispatchProxy
{
    public User User = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args)
        => method!.Name == "GetUserById" ? ((Guid)args![0]! == User.Id ? User : null)
            : throw new NotSupportedException(method.Name);
}

public class DtoProxy : DispatchProxy
{
    public List<object> Options = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name != "GetBaseItemDtos") throw new NotSupportedException(method.Name);
        var items = (IReadOnlyList<BaseItem>)args![0]!;
        var options = (DtoOptions)args[1]!;
        var user = (User?)args[2];
        Options.Add(new
        {
            fields = options.Fields,
            options.EnableImages,
            options.EnableUserData,
            options.ImageTypeLimit,
            imageTypes = options.ImageTypes,
            user = user?.Username
        });
        return items.Select(item => new BaseItemDto
        {
            Id = item.Id, Name = item.Name, SortName = item.SortName, ParentId = item.ParentId
        }).ToArray();
    }
}

public class NextUpManagerProxy : DispatchProxy
{
    public LibraryProxy Library = null!;
    public BaseItem[] Controlled = [];
    public int TotalRecordCount;
    public int? StartIndex;
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name != "GetNextUp") throw new NotSupportedException(method.Name);
        var query = (NextUpQuery)args![0]!;
        var options = (DtoOptions)args[1]!;
        Library.Queries.Add(new
        {
            operation = "GetNextUp",
            user = query.User.Username,
            query.StartIndex,
            query.Limit,
            query.SeriesId,
            query.ParentId,
            query.EnableTotalRecordCount,
            query.NextUpDateCutoff,
            query.EnableResumable,
            query.EnableRewatching,
            dtoFields = options.Fields,
            options.EnableImages,
            options.EnableUserData,
            options.ImageTypeLimit,
            imageTypes = options.ImageTypes
        });
        return new QueryResult<BaseItem>(StartIndex ?? query.StartIndex, TotalRecordCount, Controlled);
    }
}

public class SimilarManagerProxy : DispatchProxy
{
    public BaseItem[] Controlled = [];
    public List<object> Calls = [];
    public bool Throw;

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name != "GetSimilarItemsAsync") throw new NotSupportedException(method.Name);
        var item = (BaseItem)args![0]!;
        var excludeArtistIds = (IReadOnlyList<Guid>)args[1]!;
        var user = (User?)args[2];
        var options = (DtoOptions)args[3]!;
        var libraryOptions = (LibraryOptions?)args[5];
        Calls.Add(new
        {
            item = item.Name,
            itemType = item.GetType().Name,
            excludeArtistIds,
            user = user?.Username,
            fields = options.Fields,
            limit = (int?)args[4],
            libraryTypeOptions = libraryOptions?.TypeOptions.Select(type => new
            {
                type.Type,
                type.SimilarItemProviders,
                type.SimilarItemProviderOrder
            }).ToArray(),
            cancellationRequested = ((CancellationToken)args[6]!).IsCancellationRequested
        });
        if (Throw) throw new InvalidOperationException("controlled similar manager failure");
        return Task.FromResult<IReadOnlyList<BaseItem>>(Controlled);
    }
}

public sealed class ControlledSeriesProvider : ILocalSimilarItemsProvider<Series>
{
    public BaseItem[] Controlled { get; set; } = [];

    public List<object> Queries { get; } = [];

    public string Name => "controlled-local";

    public MetadataPluginType Type => MetadataPluginType.LocalSimilarityProvider;

    public Task<IReadOnlyList<BaseItem>> GetSimilarItemsAsync(
        Series item,
        SimilarItemsQuery query,
        CancellationToken cancellationToken)
    {
        Queries.Add(new
        {
            item = item.Name,
            user = query.User?.Username,
            query.Limit,
            dtoFields = query.DtoOptions?.Fields,
            query.ExcludeItemIds,
            query.ExcludeArtistIds,
            cancellationRequested = cancellationToken.IsCancellationRequested
        });
        IEnumerable<BaseItem> result = Controlled.Where(value => !query.ExcludeItemIds.Contains(value.Id));
        if (query.Limit.HasValue)
        {
            result = result.Take(Math.Max(0, query.Limit.Value));
        }

        return Task.FromResult<IReadOnlyList<BaseItem>>(result.ToArray());
    }
}

public sealed class TraceSeriesProvider : ILocalSimilarItemsProvider<Series>
{
    public TraceSeriesProvider(string name, List<object>? calls = null)
    {
        Name = name;
        Calls = calls ?? [];
    }

    public string Name { get; }

    public MetadataPluginType Type => MetadataPluginType.LocalSimilarityProvider;

    public BaseItem[] Controlled { get; set; } = [];

    public string? Failure { get; set; }

    public List<object> Calls { get; }

    public Task<IReadOnlyList<BaseItem>> GetSimilarItemsAsync(
        Series item,
        SimilarItemsQuery query,
        CancellationToken cancellationToken)
    {
        Calls.Add(new
        {
            provider = Name,
            query.Limit,
            excludeItemIds = query.ExcludeItemIds,
            query.ExcludeArtistIds,
            cancellationRequested = cancellationToken.IsCancellationRequested
        });
        if (Failure == "exception")
        {
            throw new InvalidOperationException("controlled provider failure");
        }

        if (Failure == "cancellation")
        {
            throw new OperationCanceledException("controlled provider cancellation");
        }

        IEnumerable<BaseItem> values = Controlled.Where(value => !query.ExcludeItemIds.Contains(value.Id));
        if (query.Limit.HasValue)
        {
            values = values.Take(Math.Max(0, query.Limit.Value));
        }

        return Task.FromResult<IReadOnlyList<BaseItem>>(values.ToArray());
    }
}

public sealed class TraceRemoteSeriesProvider(string name, int count) : IRemoteSimilarItemsProvider<Series>
{
    public string Name { get; } = name;

    public MetadataPluginType Type => MetadataPluginType.SimilarityProvider;

    public int Yielded { get; private set; }

    public List<object> Calls { get; } = [];

    public async IAsyncEnumerable<SimilarItemReference> GetSimilarItemsAsync(
        Series item,
        SimilarItemsQuery query,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        Calls.Add(new
        {
            query.Limit,
            excludeItemIds = query.ExcludeItemIds,
            query.ExcludeArtistIds,
            cancellationRequested = cancellationToken.IsCancellationRequested
        });
        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Yielded++;
            yield return new SimilarItemReference
            {
                ProviderName = "BatchKey",
                ProviderId = index.ToString("D3", CultureInfo.InvariantCulture)
            };
            await Task.Yield();
        }
    }
}

public sealed class TraceScoredRemoteSeriesProvider(
    string name,
    IReadOnlyList<SimilarItemReference> controlled) : IRemoteSimilarItemsProvider<Series>
{
    public string Name { get; } = name;

    public MetadataPluginType Type => MetadataPluginType.SimilarityProvider;

    public int Yielded { get; private set; }

    public async IAsyncEnumerable<SimilarItemReference> GetSimilarItemsAsync(
        Series item,
        SimilarItemsQuery query,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (var reference in controlled)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Yielded++;
            yield return reference;
            await Task.Yield();
        }
    }
}

public class SimilarPathsProxy : DispatchProxy
{
    public string Cache = null!;

    protected override object? Invoke(MethodInfo? method, object?[]? args)
        => method!.Name == "get_CachePath" ? Cache : throw new NotSupportedException(method.Name);
}

public sealed class TmdbRecordingHttpHandler : HttpMessageHandler
{
    public string Mode { get; set; } = "success";

    public List<string> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var url = request.RequestUri!.ToString();
        Requests.Add(url);
        if (request.RequestUri.AbsolutePath.EndsWith("/configuration", StringComparison.Ordinal))
        {
            const string configuration = """
                {"images":{"base_url":"http://images.invalid/","secure_base_url":"https://images.invalid/","backdrop_sizes":["original"],"logo_sizes":["original"],"poster_sizes":["original"],"profile_sizes":["original"],"still_sizes":["original"]},"change_keys":[]}
                """;
            return Task.FromResult(Response(configuration));
        }

        if (Mode == "throw")
        {
            throw new HttpRequestException("controlled TMDB transport failure");
        }

        if (Mode == "null")
        {
            return Task.FromResult(Response("null"));
        }

        if (Mode == "rate-limit")
        {
            var response = Response("{\"status_code\":25,\"status_message\":\"controlled rate limit\"}", System.Net.HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(9));
            return Task.FromResult(response);
        }

        if (Mode == "server-error")
        {
            return Task.FromResult(Response("{\"status_code\":9,\"status_message\":\"controlled server error\"}", System.Net.HttpStatusCode.InternalServerError));
        }

        if (Mode == "unresolved")
        {
            return Task.FromResult(Response("{\"page\":1,\"results\":[{\"id\":997,\"name\":\"Missing One\"},{\"id\":998,\"name\":\"Missing Two\"}],\"total_pages\":1,\"total_results\":2}"));
        }

        var second = request.RequestUri.Query.Contains("page=2", StringComparison.Ordinal);
        var body = second
            ? "{\"page\":2,\"results\":[{\"id\":102,\"name\":\"Remote Two\"}],\"total_pages\":2,\"total_results\":3}"
            : "{\"page\":1,\"results\":[{\"id\":101,\"name\":\"Remote One\"},{\"id\":999,\"name\":\"Missing\"}],\"total_pages\":2,\"total_results\":3}";
        return Task.FromResult(Response(body));
    }

    private static HttpResponseMessage Response(string body, System.Net.HttpStatusCode status = System.Net.HttpStatusCode.OK)
        => new(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
}

public sealed class DateValueProvider(string value) : IValueProvider
{
    public bool ContainsPrefix(string prefix) => string.Equals(prefix, "value", StringComparison.Ordinal);

    public ValueProviderResult GetValue(string key) => string.Equals(key, "value", StringComparison.Ordinal)
        ? new ValueProviderResult(new StringValues(value), CultureInfo.InvariantCulture)
        : ValueProviderResult.None;
}

public sealed class StaticHttpClientFactory(HttpClient client) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => client;
}

public sealed class RecordingHttpHandler : HttpMessageHandler
{
    public List<string> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        Requests.Add(request.RequestUri!.ToString());
        const string body = """
            [
              {"artist_mbid":"94000000-0000-0000-0000-000000000001","name":"source","score":1.0},
              {"artist_mbid":"94000000-0000-0000-0000-000000000002","name":"second","score":0.75}
            ]
            """;
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        });
    }
}

public sealed class NamedValueProvider(string name, ValueProviderResult result) : IValueProvider
{
    public bool ContainsPrefix(string prefix) => string.Equals(prefix, name, StringComparison.Ordinal);

    public ValueProviderResult GetValue(string key) => string.Equals(key, name, StringComparison.Ordinal)
        ? result
        : ValueProviderResult.None;
}

public class UserDataProxy : DispatchProxy
{
    public Dictionary<Guid, UserItemData> Data = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetUserData")
        {
            var item = (BaseItem)args![1]!;
            return Data.GetValueOrDefault(item.Id);
        }
        if (method.Name == "GetUserDataBatch")
        {
            var items = (IReadOnlyList<BaseItem>)args![0]!;
            return items.Where(item => Data.ContainsKey(item.Id)).ToDictionary(item => item.Id, item => Data[item.Id]);
        }
        throw new NotSupportedException(method.Name);
    }
}

public class LibraryProxy : DispatchProxy
{
    public Dictionary<string, BaseItem> Items = [];
    public Dictionary<string, Guid> Ids = [];
    public BaseItem[] Upcoming = [];
    public List<object> Queries = [];
    public LibraryManager Real = null!;
    public IReadOnlyList<string> NextUpKeys = [];
    public Dictionary<string, MediaBrowser.Controller.Persistence.NextUpEpisodeBatchResult> NextUpBatches = [];
    public List<object> NextUpCalls = [];
    public Folder? UserRoot;
    public AggregateFolder RootFolder = null!;
    public Guid[] AccessTopParentIds = [];
    public List<int> RemoteProviderQuerySizes = [];

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetItemById")
        {
            var item = Items.Values.FirstOrDefault(value => value.Id == (Guid)args![0]!);
            if (item is null) return null;
            return method.ReturnType.IsAssignableFrom(item.GetType()) ? item : null;
        }
        if (method.Name == "get_RootFolder") return RootFolder;
        if (method.Name == "GetUserRootFolder") return UserRoot!;
        if (method.Name == "ConfigureUserAccess")
        {
            ((InternalItemsQuery)args![0]!).TopParentIds = AccessTopParentIds;
            return null;
        }
        if (method.Name == "GetLinkedAlternateVersions") return Array.Empty<Video>();
        if (method.Name == "GetLocalAlternateVersionIds") return Array.Empty<Guid>();
        if (method.Name == "GetNextUpSeriesKeys")
        {
            var query = (InternalItemsQuery)args![0]!;
            var parents = (IReadOnlyCollection<BaseItem>)args[1]!;
            NextUpCalls.Add(new
            {
                operation = "GetNextUpSeriesKeys",
                limit = query.Limit,
                parents = parents.Select(item => item.Name),
                cutoff = (DateTime)args[2]!
            });
            return NextUpKeys;
        }
        if (method.Name == "GetNextUpEpisodesBatch")
        {
            var keys = (IReadOnlyList<string>)args![1]!;
            NextUpCalls.Add(new
            {
                operation = "GetNextUpEpisodesBatch",
                keys,
                includeSpecials = (bool)args[2]!,
                includeRewatching = (bool)args[3]!
            });
            return NextUpBatches.Where(entry => keys.Contains(entry.Key)).ToDictionary();
        }
        if (method.Name is "GetItemList" or "GetItemsResult")
        {
            var query = (InternalItemsQuery)args![0]!;
            Queries.Add(QuerySnapshot(query));
            if (Upcoming.Length > 0) return Upcoming;
            IEnumerable<BaseItem> selected = Items.Values;
            if (query.ItemIds.Length > 0) selected = selected.Where(item => query.ItemIds.Contains(item.Id));
            if (query.IncludeItemTypes.Length > 0) selected = selected.Where(item => query.IncludeItemTypes.Contains(Kind(item)));
            if (query.HasAnyProviderIds is { Count: > 0 })
            {
                RemoteProviderQuerySizes.Add(query.HasAnyProviderIds.Sum(entry => entry.Value.Length));
                selected = selected.Where(item => query.HasAnyProviderIds.Any(entry =>
                    item.TryGetProviderId(entry.Key, out var value)
                    && entry.Value.Contains(value, StringComparer.OrdinalIgnoreCase)));
            }
            if (!string.IsNullOrEmpty(query.SeriesPresentationUniqueKey)) selected = selected.Where(item => item switch
            {
                Season season => season.SeriesPresentationUniqueKey == query.SeriesPresentationUniqueKey,
                Episode episode => episode.SeriesPresentationUniqueKey == query.SeriesPresentationUniqueKey,
                _ => false
            });
            // The repository query translates IsMissing through persisted
            // IsVirtualItem. The controller's later isMissing parameter uses
            // Episode.IsMissingEpisode (LocationType.Virtual) instead.
            if (query.IsMissing == false) selected = selected.Where(item => item is not Episode episode || !episode.IsVirtualItem);
            if (query.IsMissing.HasValue) selected = selected.Where(item => item.IsVirtualItem == query.IsMissing.Value);
            if (query.IsSpecialSeason == true) selected = selected.Where(item => item.IndexNumber == 0);
            else if (query.IsSpecialSeason == false) selected = selected.Where(item => item.IndexNumber.HasValue && item.IndexNumber != 0);
            selected = selected.Where(item => item is not Video video || video.PrimaryVersionId is null);
            if (query.GroupByPresentationUniqueKey && query.User is not null)
            {
                selected = selected.GroupBy(item => item.PresentationUniqueKey)
                    .Select(group => group.OrderBy(item => item is Video video && video.PrimaryVersionId.HasValue)
                        .ThenBy(item => item.Id).First());
            }
            if (query.OrderBy.Count > 0) selected = Real.Sort(selected, query.User,
                query.OrderBy.Select(value => value.OrderBy), query.OrderBy[0].SortOrder);
            var listed = selected.ToList();
            if (query.AdjacentTo.HasValue)
            {
                var index = listed.FindIndex(item => item.Id == query.AdjacentTo.Value);
                listed = index < 0 ? [] : listed.GetRange(Math.Max(index - 1, 0),
                    Math.Min(index + 2, listed.Count) - Math.Max(index - 1, 0));
            }
            var result = listed.ToArray();
            return method.Name == "GetItemsResult"
                ? new QueryResult<BaseItem>(query.StartIndex, result.Length, result)
                : result;
        }
        if (method.Name == "Sort")
            return args!.Length == 4
                ? Real.Sort((IEnumerable<BaseItem>)args[0]!, (User?)args[1], (IEnumerable<ItemSortBy>)args[2]!, (SortOrder)args[3]!)
                : Real.Sort((IEnumerable<BaseItem>)args[0]!, (User?)args[1],
                    (IEnumerable<(ItemSortBy OrderBy, SortOrder SortOrder)>)args[2]!);
        if (method.Name == "GetLibraryOptions") return new LibraryOptions();
        throw new NotSupportedException(method.Name);
    }

    private static object QuerySnapshot(InternalItemsQuery query) => new
    {
        includeItemTypes = query.IncludeItemTypes,
        orderBy = query.OrderBy.Select(value => new { value.OrderBy, value.SortOrder }),
        query.MinPremiereDate,
        query.StartIndex,
        query.Limit,
        user = query.User?.Username,
        query.GroupByPresentationUniqueKey,
        query.EnableGroupByMetadataKey,
        query.EnableTotalRecordCount,
        query.ParentId,
        query.Recursive,
        query.SearchTerm,
        genres = query.Genres,
        query.Tags,
        query.ExcludeItemIds,
        query.ExcludeArtistIds,
        query.SeriesPresentationUniqueKey,
        query.AncestorWithPresentationUniqueKey,
        query.IsMissing,
        query.IsSpecialSeason,
        query.AdjacentTo,
        dtoFields = query.DtoOptions.Fields
    };

    private static BaseItemKind Kind(BaseItem item) => item switch
    {
        Episode => BaseItemKind.Episode,
        Season => BaseItemKind.Season,
        Series => BaseItemKind.Series,
        Movie => BaseItemKind.Movie,
        MusicArtist => BaseItemKind.MusicArtist,
        MusicAlbum => BaseItemKind.MusicAlbum,
        Audio => BaseItemKind.Audio,
        _ => BaseItemKind.Folder
    };
}

public class FileSystemProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args)
        => method!.Name == "IsPathFile" ? true : throw new NotSupportedException(method.Name);
}

public class RecordingsProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args)
        => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}

public class UnsupportedProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => throw new NotSupportedException(method!.Name);
}
