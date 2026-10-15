using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Security.Cryptography;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItem = MediaBrowser.Controller.Entities.BaseItem;
using Series = MediaBrowser.Controller.Entities.TV.Series;
using Season = MediaBrowser.Controller.Entities.TV.Season;
using Episode = MediaBrowser.Controller.Entities.TV.Episode;

Guid Id(int index) => Guid.Parse($"a9400000-0000-0000-0000-{index:000000000000}");
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method,args) => method.Name == "get_Configuration"
    ? new ServerConfiguration() : Stub.Default(method.ReturnType));
Video.RecordingsManager = Stub.Make<MediaBrowser.Controller.LiveTv.IRecordingsManager>((method,args) => Stub.Default(method.ReturnType));
var first = new Series { Id = Id(1), Name = "First actual parent", ForcedSortName = "a-native-parent",
    ProviderIds = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase) { ["Tvdb"] = "first-series-key" } };
var other = new Series { Id = Id(2), Name = "Unrelated saved ancestor", ForcedSortName = "z-native-unrelated",
    ProviderIds = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase) { ["Tvdb"] = "other-series-key" } };
var season = new Season { Id = Id(3), ParentId = first.Id, Name = "Actual season", IndexNumber = 10 };
var nonSeries = new Folder { Id = Id(4), ParentId = first.Id, Name = "Wrong type ID" };
var parentless = new Folder { Id = Id(5), Name = "Unrelated parent" };
var items = new BaseItem[] { first, other, season, nonSeries, parentless }.ToDictionary(item => item.Id);
var lookups = new List<Guid>();
BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method,args) => {
    if (method.Name == "GetItemById") { lookups.Add((Guid)args![0]!); return items.GetValueOrDefault((Guid)args[0]!); }
    return Stub.Default(method.ReturnType);
});
var getters = new List<object>();
foreach (var type in new[] { "Episode", "Season" }) foreach (var mode in new[] {
    "explicit-actual", "explicit-other", "empty-real-chain", "missing-explicit", "wrong-type-explicit", "empty-unrelated-chain" }) {
    var parentId = mode == "empty-unrelated-chain" ? parentless.Id : type == "Episode" ? season.Id : first.Id;
    var seriesId = mode switch {
        "explicit-actual" => first.Id, "explicit-other" => other.Id, "missing-explicit" => Id(99),
        "wrong-type-explicit" => nonSeries.Id, _ => Guid.Empty };
    var savedAncestorIds = new[] { other.Id, first.Id };
    BaseItem item = type == "Episode" ? new Episode { Id = Id(10), ParentId = parentId, SeriesId = seriesId,
        SeriesName = "serialized-series-name-fallback", ParentIndexNumber = 1, IndexNumber = 2 }
        : new Season { Id = Id(11), ParentId = parentId, SeriesId = seriesId, SeriesName = "serialized-series-name-fallback" };
    lookups.Clear();
    var actualSeries = item is Episode episode ? episode.Series : ((Season)item).Series;
    var findId = item is Episode ep ? ep.FindSeriesId() : ((Season)item).FindSeriesId();
    var sortName = item is Episode e ? e.FindSeriesSortName() : ((Season)item).FindSeriesSortName();
    getters.Add(new { type, mode, item.Id, item.ParentId, SeriesId = seriesId,
        SeriesName = "serialized-series-name-fallback", savedAncestorIds,
        item.ParentIndexNumber, item.IndexNumber, userDataKeys = item.GetUserDataKeys(),
        actualSeriesId = actualSeries?.Id, actualSeriesSortName = actualSeries?.SortName,
        foundParentSeriesId = findId, seriesSortName = sortName,
        parents = item.GetParents().Select(parent => parent.Id).ToArray(), lookupIds = lookups.ToArray(),
        airedSeasonNumber = item is Episode aired ? aired.AiredSeasonNumber : null });
}
const string aliasData = "{\"Series\":{\"Id\":\"a9400000-0000-0000-0000-000000000002\",\"Type\":\"Series\",\"ProviderIds\":{\"Tvdb\":\"serialized-fake-key\"}},\"SeriesId\":\"a9400000-0000-0000-0000-000000000002\"}";
var aliasEpisode = JsonSerializer.Deserialize<Episode>(aliasData)!;
aliasEpisode.Id = Id(12); aliasEpisode.ParentId = season.Id;
aliasEpisode.ParentIndexNumber = 1; aliasEpisode.IndexNumber = 2;
var ignoredAlias = new { serializedData = aliasData, aliasEpisode.Id, aliasEpisode.ParentId,
    aliasEpisode.SeriesId, aliasEpisode.ParentIndexNumber, aliasEpisode.IndexNumber,
    actualSeriesId = aliasEpisode.Series?.Id, userDataKeys = aliasEpisode.GetUserDataKeys() };
var options = new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite("Data Source=:memory:").Options;
var provider = new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance);
var locking = Stub.Make<IEntityFrameworkCoreLockingBehavior>((method,args) => Stub.Default(method.ReturnType));
using var context = new JellyfinDbContext(options, NullLogger<JellyfinDbContext>.Instance, provider, locking);
var repository = (BaseItemRepository)RuntimeHelpers.GetUninitializedObject(typeof(BaseItemRepository));
var user = new User("ControlledSQLTranslation", "controlled-auth", "controlled-reset") { Id = Id(98) };
var sql = new List<object>();
foreach (var search in new string?[] { null, "x" }) foreach (var withUser in new[] { false, true }) {
    var query = new InternalItemsQuery { SearchTerm = search, User = withUser ? user : null,
        OrderBy = [(ItemSortBy.Name, SortOrder.Descending), (ItemSortBy.SeriesDatePlayed, SortOrder.Descending), (ItemSortBy.Studio, SortOrder.Descending)] };
    var order = repository.ApplyOrder(context.BaseItems.AsNoTracking(), query, context);
    sql.Add(new { search, withUser, queryOrder = query.OrderBy.Select(entry => new { name = entry.OrderBy.ToString(), sign = entry.SortOrder.ToString() }).ToArray(),
        actualSql = order.ToQueryString() });
}
foreach (var mode in new[] { "default-and-name", "default-only-search", "empty-search" }) {
    var query = new InternalItemsQuery { SearchTerm = mode == "default-and-name" ? null : "x",
        OrderBy = mode == "default-and-name" ? [(ItemSortBy.Default,SortOrder.Descending),(ItemSortBy.Name,SortOrder.Ascending)]
            : mode == "default-only-search" ? [(ItemSortBy.Default,SortOrder.Descending)] : [] };
    sql.Add(new { mode, queryOrder = query.OrderBy.Select(entry => new { name = entry.OrderBy.ToString(), sign = entry.SortOrder.ToString() }).ToArray(),
        actualSql = repository.ApplyOrder(context.BaseItems.AsNoTracking(),query,context).ToQueryString() });
}
var loadedAssemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location))
    .OrderBy(assembly => assembly.GetName().Name).Select(assembly => new { name = assembly.GetName().Name,
        path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray();
Console.WriteLine(JsonSerializer.Serialize(new {
    actualFrozenEpisodeSeasonGetters = true, actualFrozenApplyOrderSqlTranslation = true,
    dependenciesControlled = true, databaseOpened = false, sharedPostgresUsed = false, portOpened = false,
    parentItems = items.Values.Select(item => new { item.Id, item.ParentId, type = item.GetType().Name, item.Name, item.SortName,
        indexNumber = item.IndexNumber, item.ProviderIds }).ToArray(), getters, ignoredAlias, sql, loadedAssemblies,
    sourceBoundary = "Actual frozen Episode/Season Series, FindSeriesId, FindSeriesSortName, Episode.AiredSeasonNumber, GetUserDataKeys and BaseItem.GetParents getters. Lookup stub only resolves explicit IDs; default ServerConfiguration is controlled for real SortName getter. savedAncestorIds are deliberately contradictory evidence inputs; getters never receive or query them. Alias Episode is actually deserialized with System.Text.Json then explicit ignored fields are assigned; its serialized Series and SeriesId are ignored. Actual frozen BaseItemRepository.ApplyOrder/ApplySeriesDatePlayedOrder and OrderMapper run against actual JellyfinDbContext/SQLite provider to produce EF SQL with ToQueryString; no database connection/query/HTTP request is executed. Entity lookup, default configuration and unused locking interfaces are controlled. No production files or existing matrices are edited by this oracle." }, new JsonSerializerOptions { WriteIndented = true }));
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method,object?[]? args) => Handler(method!,args);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class { var proxy = Create<T,Stub>(); ((Stub)(object)proxy).Handler=handler; return proxy; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
