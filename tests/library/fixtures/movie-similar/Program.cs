using System.Reflection;
using System.Runtime.CompilerServices;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library.SimilarItems;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Providers.Plugins.Tmdb;
using MediaBrowser.Providers.Plugins.Tmdb.Movies;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItemEntity = Jellyfin.Database.Implementations.Entities.BaseItemEntity;
using UserDataEntity = Jellyfin.Database.Implementations.Entities.UserData;
using TMDbLib.Client;
using TmdbPlugin = MediaBrowser.Providers.Plugins.Tmdb.Plugin;
using TmdbPluginConfiguration = MediaBrowser.Providers.Plugins.Tmdb.PluginConfiguration;

var inputBytes = File.ReadAllBytes(args[0]);
using var input = JsonDocument.Parse(inputBytes);
var filename = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "movie-similar.sqlite");
if (File.Exists(filename)) throw new InvalidOperationException("Oracle output database already exists.");
var factory = new SqlFactory(filename);
var configuration = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
var config = (ConfigurationProxy)(object)configuration;
BaseItem.ConfigurationManager = configuration;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
var appHost = DispatchProxy.Create<IServerApplicationHost, ApplicationHostProxy>();
var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
var libraryProxy = (LibraryProxy)(object)library;
libraryProxy.TopParent = Id(90);
var user = new User("movie-oracle", "fixture-auth", "fixture-reset") { Id = Id(80) };
var unplayedUser = new User("movie-oracle-unplayed", "fixture-auth", "fixture-reset") { Id = Id(81) };
var entityTypes = new Dictionary<string, string>
{
    ["Movie"] = typeof(Movie).FullName!, ["Trailer"] = typeof(Trailer).FullName!,
    ["Series"] = typeof(Series).FullName!, ["LiveTvProgram"] = typeof(LiveTvProgram).FullName!
};
var entities = new Dictionary<int, BaseItemEntity>();
using (var db = factory.CreateDbContext())
{
    db.Database.EnsureCreated();
    db.Users.Add(user);
    db.Users.Add(unplayedUser);
    foreach (var item in input.RootElement.GetProperty("items").EnumerateArray())
    {
        var key = item.GetProperty("id").GetInt32();
        var entity = new BaseItemEntity
        {
            Id = Id(key), Type = entityTypes[item.GetProperty("type").GetString()!],
            Name = item.GetProperty("name").GetString(), SortName = $"reverse-{1000-key:0000}",
            PresentationUniqueKey = item.TryGetProperty("puk", out var puk) ? puk.GetString() : $"puk-{key}",
            TopParentId = Id(item.TryGetProperty("top", out var top) ? top.GetInt32() : 90),
            PrimaryVersionId = item.TryGetProperty("primary", out var primary) ? Id(primary.GetInt32()) : null,
            OwnerId = item.TryGetProperty("owner", out var owner) ? Id(owner.GetInt32()) : null,
            ExtraType = item.TryGetProperty("extraType", out var extra) ? (BaseItemExtraType)extra.GetInt32() : null,
            IsMovie = item.TryGetProperty("isMovie", out var movie) ? movie.GetBoolean() : true,
            IsFolder = item.GetProperty("type").GetString() == "Series", Data = "{}", MediaType = "Video"
        };
        entities.Add(key, entity);
        db.BaseItems.Add(entity);
    }
    foreach (var value in input.RootElement.GetProperty("values").EnumerateArray())
    {
        var entity = new ItemValue
        {
            ItemValueId = Id(value.GetProperty("id").GetInt32()), Type = (ItemValueType)value.GetProperty("type").GetInt32(),
            Value = value.GetProperty("value").GetString()!, CleanValue = value.GetProperty("clean").GetString()!
        };
        db.ItemValues.Add(entity);
        foreach (var item in value.GetProperty("items").EnumerateArray())
            db.ItemValuesMap.Add(new ItemValueMap
            {
                ItemId = Id(item.GetInt32()), Item = entities[item.GetInt32()], ItemValueId = entity.ItemValueId, ItemValue = entity
            });
    }
    foreach (var value in input.RootElement.GetProperty("people").EnumerateArray())
    {
        var entity = new People
        {
            Id = Id(value.GetProperty("id").GetInt32()), Name = value.GetProperty("name").GetString()!,
            PersonType = value.GetProperty("type").GetString()
        };
        db.Peoples.Add(entity);
        foreach (var item in value.GetProperty("items").EnumerateArray()) AddPersonMap(item.GetInt32(), 0);
        if (value.TryGetProperty("duplicateItems", out var duplicates))
            foreach (var item in duplicates.EnumerateArray()) AddPersonMap(item.GetInt32(), 1);
        void AddPersonMap(int item, int listOrder) => db.PeopleBaseItemMap.Add(new PeopleBaseItemMap
        {
            ItemId = Id(item), Item = entities[item], PeopleId = entity.Id, People = entity,
            ListOrder = listOrder, SortOrder = listOrder, Role = $"role-{listOrder}"
        });
    }
    foreach (var item in input.RootElement.GetProperty("played").EnumerateArray())
        db.UserData.Add(new UserDataEntity
        {
            ItemId = Id(item.GetInt32()), Item = entities[item.GetInt32()], UserId = user.Id, User = user,
            CustomDataKey = $"puk-{item.GetInt32()}", Played = true, PlayCount = 1
        });
    db.SaveChanges();
}
var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), configuration,
    NullLogger<BaseItemRepository>.Instance);
var provider = new MovieSimilarItemsProvider(factory, repository, configuration, library);
var results = new List<object>();
foreach (var scenario in input.RootElement.GetProperty("cases").EnumerateArray())
{
    config.Data.EnableExternalContentInSuggestions = !scenario.TryGetProperty("external", out var external) || external.GetBoolean();
    libraryProxy.RestrictAccess = !scenario.TryGetProperty("access", out var access) || access.GetBoolean();
    var key = scenario.GetProperty("source").GetInt32();
    var source = repository.DeserializeBaseItem(entities[key], false)!;
    var query = new SimilarItemsQuery
    {
        Limit = scenario.TryGetProperty("limit", out var limit) ? limit.GetInt32() : null,
        User = scenario.TryGetProperty("user", out var hasUser) && hasUser.GetBoolean()
            ? scenario.TryGetProperty("playedUser", out var playedUser) && playedUser.GetBoolean() ? user : unplayedUser : null,
        DtoOptions = new DtoOptions(false),
        ExcludeItemIds = [Id(key), .. scenario.TryGetProperty("exclude", out var excluded)
            ? excluded.EnumerateArray().Select(item => Id(item.GetInt32())) : Array.Empty<Guid>()]
    };
    try
    {
        var selected = await ((ILocalSimilarItemsProvider)provider).GetSimilarItemsAsync(source, query, CancellationToken.None);
        results.Add(new
        {
            name = scenario.GetProperty("name").GetString(), ids = selected.Select(item => item.Id.ToString("D")),
            items = selected.Select(item => item.Name)
        });
    }
    catch (ArgumentNullException error)
    {
        results.Add(new { name = scenario.GetProperty("name").GetString(), error = error.GetType().Name, parameter = error.ParamName });
    }
}
var output = new
{
    schemaVersion = 1, candidateVerified = false,
    boundary = "Actual pinned MovieSimilarItemsProvider with concrete BaseItemRepository and EF Core SQLite; controlled ConfigureUserAccess sets TopParentIds only. Actual LiveTvProgramSimilarItemsProvider query capture and actual TmdbMovieSimilarProvider over controlled TMDbLib transport, with no public-network call. Provider-level results, not HTTP, complete user policy, random ordering or full-library acceptance.",
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    results,
    liveTv = await RecordLiveTv(),
    tmdbMovie = await RecordTmdbMovie(),
    assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
        .OrderBy(assembly => assembly.GetName().Name, StringComparer.Ordinal)
        .Select(assembly => new { path = assembly.Location.Replace('\\', '/'), sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))), bytes = new FileInfo(assembly.Location).Length }),
    nativeSqlite = new { path = Path.Combine(AppContext.BaseDirectory, "e_sqlite3.dll").Replace('\\', '/'), sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "e_sqlite3.dll")))) }
};
File.WriteAllText(args[1], JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static Guid Id(int value) => Guid.Parse($"14000000-0000-0000-0000-{value:000000000000}");
async Task<object> RecordLiveTv()
{
    var result = new List<object>();
    foreach (var scenario in new[]
    {
        (Name: "movie-takes-precedence", Movie: true, Series: true, External: true),
        (Name: "movie-without-external-content", Movie: true, Series: false, External: false),
        (Name: "series-program", Movie: false, Series: true, External: true),
        (Name: "other-program", Movie: false, Series: false, External: true)
    })
    {
        config.Data.EnableExternalContentInSuggestions = scenario.External;
        libraryProxy.Captured = null;
        await new LiveTvProgramSimilarItemsProvider(library, configuration).GetSimilarItemsAsync(
            new LiveTvProgram { Id = Id(999), IsMovie = scenario.Movie, IsSeries = scenario.Series, Genres = ["Drama"], Tags = ["Epic"] },
            new SimilarItemsQuery { Limit = 7, ExcludeItemIds = [Id(999)], User = user }, CancellationToken.None);
        var query = libraryProxy.Captured!;
        var requested = query.Limit;
        repository.PrepareFilterQuery(query);
        result.Add(new
        {
            name = scenario.Name, includeItemTypes = query.IncludeItemTypes.Select(type => type.ToString()),
            genres = query.Genres, tags = query.Tags, requestedLimit = requested, preparedLimit = query.Limit,
            query.EnableGroupByMetadataKey, query.EnableTotalRecordCount,
            order = query.OrderBy.Select(order => new { key = order.OrderBy.ToString(), direction = order.SortOrder.ToString() }),
            query.IsMovie, query.IsPlayed
        });
    }
    return result;
}
static async Task<object> RecordTmdbMovie()
{
    var plugin = (TmdbPlugin)RuntimeHelpers.GetUninitializedObject(typeof(TmdbPlugin));
    typeof(BasePlugin<TmdbPluginConfiguration>).GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(plugin, new TmdbPluginConfiguration { SimilarItemsCacheDays = 2 });
    typeof(TmdbPlugin).GetProperty("Instance")!.SetValue(null, plugin);
    var handler = new TmdbHandler();
    var rawClient = new TMDbClient("oracle-key", false, "http://tmdb.invalid/3", null, null) { ThrowApiExceptions = false };
    var clientType = typeof(TMDbClient);
    var serializer = clientType.GetField("_serializer", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(rawClient);
    var restType = clientType.Assembly.GetType("TMDbLib.Rest.RestClient")!;
    var original = clientType.GetField("_client", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(rawClient);
    var controlled = Activator.CreateInstance(restType, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
        null, [new Uri("http://tmdb.invalid/3/"), serializer!, null!, handler], CultureInfo.InvariantCulture);
    var defaults = restType.GetProperty("DefaultQueryString", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;
    foreach (var entry in (IEnumerable<KeyValuePair<string, string>>)defaults.GetValue(original)!)
        ((ICollection<KeyValuePair<string, string>>)defaults.GetValue(controlled)!).Add(entry);
    clientType.GetField("_httpMessageHandler", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(rawClient, handler);
    clientType.GetField("_client", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(rawClient, controlled);
    using var manager = new TmdbClientManager();
    typeof(TmdbClientManager).GetField("_tmDbClient", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, rawClient);
    var provider = new TmdbMovieSimilarProvider(manager, NullLogger<TmdbMovieSimilarProvider>.Instance);
    var cases = new List<object>();
    foreach (var scenario in new[]
    {
        (Name: "valid-pages", Value: " +17 ", Mode: "success"),
        (Name: "Int32-overflow", Value: "2147483648", Mode: "success"),
        (Name: "missing-id", Value: "", Mode: "success"),
        (Name: "empty-page-stop", Value: "17", Mode: "empty"),
        (Name: "transport-failure", Value: "17", Mode: "failure")
    })
    {
        handler.Mode = scenario.Mode; handler.Requests.Clear();
        var item = new Movie();
        if (scenario.Value.Length > 0) item.ProviderIds["Tmdb"] = scenario.Value;
        var references = new List<SimilarItemReference>();
        await foreach (var reference in provider.GetSimilarItemsAsync(item, new SimilarItemsQuery(), CancellationToken.None))
            references.Add(reference);
        cases.Add(new { name = scenario.Name, value = scenario.Value, mode = scenario.Mode,
            references = references.Select(reference => new { reference.ProviderName, reference.ProviderId, reference.Score }),
            requests = handler.Requests.ToArray() });
    }
    return new { cacheMilliseconds = provider.CacheDuration!.Value.TotalMilliseconds, cases };
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext() => new(
        new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False")
            .LogTo(Console.WriteLine, [Microsoft.EntityFrameworkCore.Diagnostics.RelationalEventId.CommandExecuted]).Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
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
        => method!.Name is "ExpandVirtualPath" or "ReverseVirtualPath" ? args![0]
            : throw new NotSupportedException(method.Name);
}
public class LibraryProxy : DispatchProxy
{
    public Guid TopParent;
    public bool RestrictAccess;
    public InternalItemsQuery? Captured;
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetItemList") { Captured = (InternalItemsQuery)args![0]!; return Array.Empty<BaseItem>(); }
        if (method.Name != "ConfigureUserAccess") throw new NotSupportedException(method.Name);
        if (RestrictAccess) ((InternalItemsQuery)args![0]!).TopParentIds = [TopParent];
        return null;
    }
}
public class TmdbHandler : HttpMessageHandler
{
    public string Mode = "success";
    public List<string> Requests = [];
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request.RequestUri!.ToString());
        if (request.RequestUri.AbsolutePath.EndsWith("/configuration", StringComparison.Ordinal))
            return Task.FromResult(Response("{\"images\":{\"base_url\":\"http://images.invalid/\",\"secure_base_url\":\"https://images.invalid/\",\"backdrop_sizes\":[\"original\"],\"logo_sizes\":[\"original\"],\"poster_sizes\":[\"original\"],\"profile_sizes\":[\"original\"],\"still_sizes\":[\"original\"]},\"change_keys\":[]}"));
        if (Mode == "failure") throw new HttpRequestException("Controlled movie transport failure");
        var second = request.RequestUri.Query.Contains("page=2", StringComparison.Ordinal);
        var json = Mode == "empty" ? "{\"page\":1,\"results\":[],\"total_pages\":3}"
            : second ? "{\"page\":2,\"results\":[{\"id\":33,\"title\":\"Third\"}],\"total_pages\":2}"
            : "{\"page\":1,\"results\":[{\"id\":31,\"title\":\"First\"},{\"id\":32,\"title\":\"Second\"}],\"total_pages\":2}";
        return Task.FromResult(Response(json));
    }
    private static HttpResponseMessage Response(string json) => new(System.Net.HttpStatusCode.OK)
        { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}
