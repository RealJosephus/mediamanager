using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library.SimilarItems;
using Jellyfin.Data.Enums;
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

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var sqliteName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var sqliteFilename = Path.Combine(AppContext.BaseDirectory, sqliteName);
var sqliteHandle = NativeLibrary.Load(sqliteFilename);
var resolverObserved = false;
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) =>
{
    if (name != "e_sqlite3") return IntPtr.Zero;
    resolverObserved = true; return sqliteHandle;
});
SQLitePCL.Batteries_V2.Init();
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
    foreach (var item in input.RootElement.GetProperty("items").EnumerateArray()
        .Concat(input.RootElement.GetProperty("liveTv").GetProperty("items").EnumerateArray()))
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
            IsFolder = item.GetProperty("type").GetString() == "Series", Data = "{}", MediaType = "Video",
            Genres = item.TryGetProperty("genres", out var genres) ? string.Join('|', genres.EnumerateArray().Select(value => value.GetString())) : null,
            Tags = item.TryGetProperty("tags", out var tags) ? string.Join('|', tags.EnumerateArray().Select(value => value.GetString())) : null
        };
        entities.Add(key, entity);
        db.BaseItems.Add(entity);
    }
    foreach (var value in input.RootElement.GetProperty("values").EnumerateArray()
        .Concat(input.RootElement.GetProperty("liveTv").GetProperty("values").EnumerateArray()))
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
libraryProxy.Query = repository.GetItemList;
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
            name = scenario.GetProperty("name").GetString(), failed = false,
            ids = selected.Select(item => item.Id.ToString("D")), items = selected.Select(item => item.Name),
            sortNames = selected.Select(item => item.SortName)
        });
    }
    catch (Exception error)
    {
        results.Add(new { name = scenario.GetProperty("name").GetString(), failed = true,
            diagnostic = new { type = error.GetType().Name, error.Message, error.StackTrace } });
    }
}
var output = new
{
    schemaVersion = 1, actualExecution = true,
    boundary = "Same-run actual MovieSimilarItemsProvider and LiveTvProgramSimilarItemsProvider over concrete BaseItemRepository and EF Core SQLite. ConfigureUserAccess only supplies a declared TopParentId; Live TV queries execute through the repository. Actual TmdbMovieSimilarProvider and TMDbLib use declared controlled HTTP input. Component evidence only; no complete user policy, HTTP server, production-scale or release acceptance.",
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    results,
    identifierScopes = input.RootElement.GetProperty("identifierScopes").EnumerateArray().Select(scenario => new
    {
        name = scenario.GetProperty("name").GetString(),
        selected = repository.GetItemList(new InternalItemsQuery { DtoOptions = new DtoOptions(false),
            ItemIds = scenario.GetProperty("ids").EnumerateArray().Select(value => Id(value.GetInt32())).ToArray(),
            IncludeItemTypes = scenario.GetProperty("types").EnumerateArray().Select(value => Enum.Parse<BaseItemKind>(value.GetString()!)).ToArray(),
            IsMovie = scenario.GetProperty("isMovie").GetBoolean() })
            .Select(item => new { id = item.Id.ToString("D"), name = item.Name, sortName = item.SortName }).ToArray()
    }).ToArray(),
    liveTv = await RecordLiveTv(),
    tmdbMovie = await RecordTmdbMovie(input.RootElement.GetProperty("tmdb")),
    assemblies = new[] { typeof(MovieSimilarItemsProvider).Assembly, typeof(BaseItemRepository).Assembly,
        typeof(BaseItem).Assembly, typeof(JellyfinDbContext).Assembly, typeof(SqliteDatabaseProvider).Assembly,
        typeof(TmdbMovieSimilarProvider).Assembly, typeof(TMDbClient).Assembly, typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly }
        .Distinct()
        .OrderBy(assembly => assembly.GetName().Name, StringComparer.Ordinal)
        .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location,
            sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))), bytes = new FileInfo(assembly.Location).Length }),
    nativeSqlite = new { name = sqliteName, path = sqliteFilename, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier,
        resolverObserved, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(sqliteFilename))) }
};
File.WriteAllText(args[1], JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static Guid Id(int value) => Guid.Parse($"14000000-0000-0000-0000-{value:000000000000}");
async Task<object> RecordLiveTv()
{
    var result = new List<object>();
    var data = input.RootElement.GetProperty("liveTv");
    foreach (var scenario in data.GetProperty("cases").EnumerateArray())
    {
        config.Data.EnableExternalContentInSuggestions = scenario.GetProperty("external").GetBoolean();
        async Task<object[]> Select(int limit)
        {
            var source = new LiveTvProgram { Id = Id(data.GetProperty("sourceId").GetInt32()),
                IsMovie = scenario.GetProperty("isMovie").GetBoolean(), IsSeries = scenario.GetProperty("isSeries").GetBoolean(),
                Genres = data.GetProperty("genres").EnumerateArray().Select(value => value.GetString()!).ToArray(),
                Tags = data.GetProperty("tags").EnumerateArray().Select(value => value.GetString()!).ToArray() };
            var selected = await new LiveTvProgramSimilarItemsProvider(library, configuration).GetSimilarItemsAsync(source,
                new SimilarItemsQuery { Limit = limit, User = user, DtoOptions = new DtoOptions(false),
                    ExcludeItemIds = [source.Id, .. data.GetProperty("exclude").EnumerateArray().Select(value => Id(value.GetInt32()))] },
                CancellationToken.None);
            return selected.Select(item => (object)new { id = item.Id.ToString("D"), name = item.Name,
                type = item.GetBaseItemKind().ToString(), sortName = item.SortName, genres = item.Genres, tags = item.Tags }).ToArray();
        }
        try { result.Add(new { name = scenario.GetProperty("name").GetString(), failed = false,
            pool = await Select(data.GetProperty("poolLimit").GetInt32()), selected = await Select(data.GetProperty("limit").GetInt32()) }); }
        catch (Exception error) { result.Add(new { name = scenario.GetProperty("name").GetString(), failed = true,
            diagnostic = new { type = error.GetType().Name, error.Message, error.StackTrace } }); }
    }
    return result;
}
static async Task<object> RecordTmdbMovie(JsonElement data)
{
    var plugin = (TmdbPlugin)RuntimeHelpers.GetUninitializedObject(typeof(TmdbPlugin));
    typeof(BasePlugin<TmdbPluginConfiguration>).GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!
        .SetValue(plugin, new TmdbPluginConfiguration { SimilarItemsCacheDays = data.GetProperty("cacheDays").GetInt32() });
    typeof(TmdbPlugin).GetProperty("Instance")!.SetValue(null, plugin);
    var handler = new TmdbHandler { Data = data };
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
    foreach (var scenario in data.GetProperty("cases").EnumerateArray())
    {
        var value = scenario.GetProperty("value").GetString()!;
        handler.Mode = scenario.GetProperty("mode").GetString()!; handler.Requests.Clear();
        var item = new Movie();
        if (value.Length > 0) item.ProviderIds["Tmdb"] = value;
        using var cancellation = new CancellationTokenSource();
        if (scenario.TryGetProperty("cancelled", out var cancelled) && cancelled.GetBoolean()) cancellation.Cancel();
        var references = new List<SimilarItemReference>();
        await foreach (var reference in provider.GetSimilarItemsAsync(item, new SimilarItemsQuery(), cancellation.Token))
            references.Add(reference);
        cases.Add(new { name = scenario.GetProperty("name").GetString(), value, mode = handler.Mode,
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
    public Func<InternalItemsQuery, IReadOnlyList<BaseItem>>? Query;
    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name == "GetItemList") return Query!((InternalItemsQuery)args![0]!);
        if (method.Name != "ConfigureUserAccess") throw new NotSupportedException(method.Name);
        if (RestrictAccess) ((InternalItemsQuery)args![0]!).TopParentIds = [TopParent];
        return null;
    }
}
public class TmdbHandler : HttpMessageHandler
{
    public JsonElement Data;
    public string Mode = "success";
    public List<string> Requests = [];
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request.RequestUri!.ToString());
        if (request.RequestUri.AbsolutePath.EndsWith("/configuration", StringComparison.Ordinal))
            return Task.FromResult(Response(Data.GetProperty("configuration").GetRawText()));
        if (Mode == "failure") throw new HttpRequestException("Controlled movie transport failure");
        var second = request.RequestUri.Query.Contains("page=2", StringComparison.Ordinal);
        var json = Data.GetProperty(Mode == "empty" ? "emptyPage" : second ? "secondPage" : "firstPage").GetRawText();
        return Task.FromResult(Response(json));
    }
    private static HttpResponseMessage Response(string json) => new(System.Net.HttpStatusCode.OK)
        { Content = new StringContent(json, Encoding.UTF8, "application/json") };
}
