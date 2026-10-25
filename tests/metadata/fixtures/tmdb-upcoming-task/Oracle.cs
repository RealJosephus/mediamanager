using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Providers.Plugins.Tmdb;
using MediaBrowser.Providers.Plugins.Tmdb.TV;
using Microsoft.Extensions.Logging.Abstractions;

var manager = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
var proxy = (LibraryProxy)(object)manager;
BaseItem.LibraryManager = manager;
var task = new TmdbUpcomingEpisodesTask(manager, null!, NullLogger<TmdbUpcomingEpisodesTask>.Instance);

var intervals = new List<object>();
foreach (var days in new[] { 3, 0, -1 })
{
    SetConfiguration(new PluginConfiguration { MissingEpisodeRefreshIntervalDays = days });
    var trigger = task.GetDefaultTriggers().Single();
    intervals.Add(new { days, trigger.Type, trigger.IntervalTicks });
}
SetConfiguration(null);
var nullProgress = new RecordingProgress();
await task.ExecuteAsync(nullProgress, CancellationToken.None);

var episode1 = new Episode { Id = Guid.Parse("a9000000-0000-0000-0000-000000000001"), Name = "Episode 1", IsVirtualItem = true };
var episode2 = new Episode { Id = Guid.Parse("a9000000-0000-0000-0000-000000000002"), Name = "Episode 2", IsVirtualItem = true };
var season = new Season { Id = Guid.Parse("a9000000-0000-0000-0000-000000000003"), Name = "Season 1", IsVirtualItem = true };
foreach (var item in new BaseItem[] { episode1, episode2, season }) item.ProviderIds["Tmdb"] = "1";
proxy.Episodes = [episode1, episode2];
proxy.Seasons = [season];
proxy.Series = [];
SetConfiguration(new PluginConfiguration());
var disabledProgress = new RecordingProgress();
await task.ExecuteAsync(disabledProgress, CancellationToken.None);
var disabled = new { progress = disabledProgress.Values, removed = proxy.Removed.ToArray(),
    queries = proxy.Queries.ToArray(), deleteOptions = proxy.DeleteOptions.ToArray() };

proxy.Reset();
SetConfiguration(new PluginConfiguration
{
    ImportUnairedEpisodes = true,
    EnabledMissingEpisodeLibraries = ["a9000000000000000000000000000010"]
});
var emptyActiveProgress = new RecordingProgress();
await task.ExecuteAsync(emptyActiveProgress, CancellationToken.None);

var taskType = task.GetType();
var result = new
{
    type = taskType.FullName,
    id = taskType.FullName!.GetMD5().ToString("N"),
    task.Name,
    task.Description,
    task.Category,
    task.Key,
    intervals,
    nullConfiguration = new { progress = nullProgress.Values, queries = 0 },
    disabled,
    emptyActive = new { progress = emptyActiveProgress.Values, queries = proxy.Queries.ToArray() },
    runtime = RuntimeInformation.FrameworkDescription,
    assembly = new
    {
        path = taskType.Assembly.Location,
        sha256 = Hash(File.ReadAllBytes(taskType.Assembly.Location))
    },
    sourceBoundary = "Actual TmdbUpcomingEpisodesTask metadata, GetDefaultTriggers and ExecuteAsync run unmodified. The controlled ILibraryManager returns declared query results and records DeleteItem calls; null configuration, disabled global cleanup and enabled/no-Series completion are covered. Active Series ValidateChildren, file/DB/event effects and live TMDB transport are outside this oracle.",
    phaseAcceptance = false
};
File.WriteAllText(args[0], JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
SetConfiguration(null);

static void SetConfiguration(PluginConfiguration? configuration)
{
    Plugin? plugin = null;
    if (configuration is not null)
    {
        plugin = (Plugin)RuntimeHelpers.GetUninitializedObject(typeof(Plugin));
        typeof(BasePlugin<PluginConfiguration>).GetField("_configuration", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(plugin, configuration);
    }

    typeof(Plugin).GetProperty("Instance")!.SetValue(null, plugin);
}
static string Hash(byte[] value) => Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

public sealed class RecordingProgress : IProgress<double>
{
    public List<double> Values { get; } = [];
    public void Report(double value) => Values.Add(value);
}
public class LibraryProxy : DispatchProxy
{
    public IReadOnlyList<BaseItem> Episodes { get; set; } = [];
    public IReadOnlyList<BaseItem> Seasons { get; set; } = [];
    public IReadOnlyList<BaseItem> Series { get; set; } = [];
    public List<Guid> Removed { get; } = [];
    public List<object> Queries { get; } = [];
    public List<object> DeleteOptions { get; } = [];

    public void Reset()
    {
        Episodes = [];
        Seasons = [];
        Series = [];
        Removed.Clear();
        Queries.Clear();
        DeleteOptions.Clear();
    }

    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetItemList" => GetItems((InternalItemsQuery)args![0]!),
        "DeleteItem" => Delete(args!),
        "GetItemById" => null,
        _ => throw new NotSupportedException("Unexpected library call: " + method.Name)
    };

    private IReadOnlyList<BaseItem> GetItems(InternalItemsQuery query)
    {
        var kinds = query.IncludeItemTypes ?? [];
        Queries.Add(new { includeItemTypes = kinds, query.IsVirtualItem, query.HasTmdbId, query.Recursive });
        if (kinds.Contains(BaseItemKind.Episode)) return Episodes;
        if (kinds.Contains(BaseItemKind.Season)) return Seasons;
        if (kinds.Contains(BaseItemKind.Series)) return Series;
        return [];
    }

    private object? Delete(object?[] args)
    {
        var item = (BaseItem)args[0]!;
        var options = (DeleteOptions)args[1]!;
        Removed.Add(item.Id);
        DeleteOptions.Add(new { options.DeleteFileLocation, notifyParentItem = (bool)args[2]! });
        return null;
    }
}
