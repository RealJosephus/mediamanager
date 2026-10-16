using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;

public sealed class SeriesCleanupSeed
{
    public string SeriesName { get; set; } = "";
    public string SeasonName { get; set; } = "";
    public string VirtualEpisodeName { get; set; } = "";
    public string SurvivingEpisodeName { get; set; } = "";
    public string PlaylistName { get; set; } = "";
}

public static class SeriesCleanupRecording
{
    public static async Task<object> RunAsync(NativeScanHost host)
    {
        var seed = host.Scenario.SeriesCleanup!;
        var stamp = new DateTime(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc);
        var series = new Series { Id = Id(1), Name = seed.SeriesName };
        series.PresentationUniqueKey = series.GetPresentationUniqueKey();
        var season = new Season { Id = Id(2), Name = seed.SeasonName, IndexNumber = 1,
            ParentId = series.Id, SeriesId = series.Id, SeriesName = series.Name,
            SeriesPresentationUniqueKey = series.PresentationUniqueKey };
        var obsolete = new Episode { Id = Id(3), Name = seed.VirtualEpisodeName, IsVirtualItem = true,
            ParentId = season.Id, SeriesId = series.Id, SeriesName = series.Name,
            SeasonId = season.Id, SeasonName = season.Name, ParentIndexNumber = 1,
            SeriesPresentationUniqueKey = series.PresentationUniqueKey };
        var survivor = new Episode { Id = Id(4), Name = seed.SurvivingEpisodeName,
            Path = Path.Combine(host.Paths.DataPath, "series-cleanup-media", "Episode.mkv"),
            ParentId = season.Id, SeriesId = series.Id, SeriesName = series.Name,
            SeasonId = season.Id, SeasonName = season.Name, ParentIndexNumber = 1, IndexNumber = 1,
            SeriesPresentationUniqueKey = series.PresentationUniqueKey };
        survivor.SetPrimaryVersionId(obsolete.Id);
        var playlist = new Playlist { Id = Id(5), Name = seed.PlaylistName,
            LinkedChildren = [new LinkedChild { ItemId = obsolete.Id }] };
        BaseItem[] items = [series, season, obsolete, survivor, playlist];
        foreach (var item in items)
        {
            item.DateCreated = item.DateModified = item.DateLastSaved = item.DateLastRefreshed = stamp;
            // Parent and version getters must use actual persisted native rows.
            host.Persistence.SaveItems([item], CancellationToken.None);
        }
        // Persist the version relation only after both endpoint rows exist.
        obsolete.LinkedAlternateVersions = [new LinkedChild { ItemId = survivor.Id }];
        host.Persistence.SaveItems([obsolete], CancellationToken.None);
        Write(survivor.Path, "source bytes must survive metadata-only cleanup\n");
        foreach (var item in new BaseItem[] { obsolete, survivor })
        {
            Write(Path.Combine(item.GetInternalMetadataPath(), "internal.txt"), "internal marker\n");
            foreach (var directory in host.PathManager.GetExtractedDataPaths(item))
                Write(Path.Combine(directory, "extracted.txt"), "extracted marker\n");
        }
        var liveSeries = (Series)host.Manager.GetItemById(series.Id);
        var liveSeason = (Season)host.Manager.GetItemById(season.Id);
        var livePlaylist = (Playlist)host.Manager.GetItemById(playlist.Id);
        _ = liveSeries.Children.ToArray();
        _ = liveSeason.Children.ToArray();
        _ = livePlaylist.LinkedChildren;
        liveSeason.UserData = [];
        var before = new { sql = host.SnapshotSql(), files = Files(host.Paths.ProgramDataPath),
            parentChildren = liveSeason.Children.Select(item => item.Id).ToArray(),
            parentUserDataPresent = liveSeason.UserData is not null };
        var removal = new List<object>();
        host.Manager.ItemRemoved += (_, change) => removal.Add(new {
            id = change.Item.Id, parentId = change.Parent?.Id,
            parentChildrenCleared = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(liveSeason) is null,
            parentUserDataCleared = liveSeason.UserData is null,
            sql = host.SnapshotSql()
        });
        var providerControls = new {
            metadataProviders = host.MetadataProviders.Select(value => value.GetType().FullName).ToArray(),
            imageProviders = host.ImageProviders.Select(value => value.GetType().FullName).ToArray(),
            metadataSavers = host.MetadataSavers.Select(value => value.GetType().FullName).ToArray()
        };
        var startedAt = DateTime.UtcNow;
        string? exception = null;
        int? updateType = null;
        try
        {
            await host.ObserveOperationAsync(async () => {
                updateType = (int)await host.Provider.RefreshSingleItem(liveSeries,
                    new MetadataRefreshOptions(host.DirectoryService) {
                        MetadataRefreshMode = MetadataRefreshMode.None, ImageRefreshMode = MetadataRefreshMode.None
                    }, CancellationToken.None);
            });
        }
        catch (Exception error) { exception = error.ToString(); }
        var completedAt = DateTime.UtcNow;
        var after = new { sql = host.SnapshotSql(), files = Files(host.Paths.ProgramDataPath),
            removedLookupAbsent = host.Manager.GetItemById(obsolete.Id) is null,
            playlistLinks = livePlaylist.LinkedChildren.Select(link => link.ItemId).ToArray(),
            removal = removal.ToArray(), trace = host.Trace.ToArray(), exception, updateType };
        var observation = new { host.Scenario.Name, host.Scenario.SeriesCleanup, programRoot = host.Paths.ProgramDataPath,
            fixtureIds = items.Select(item => item.Id).ToArray(), providerControls, before, after, startedAt, completedAt };
        await File.WriteAllTextAsync(Path.Combine(host.CaseRoot, "series-cleanup-observation.json"),
            JsonSerializer.Serialize(observation, new JsonSerializerOptions { WriteIndented = true }));
        await host.DisposeAsync();
        return new { observation, release = new { completed = host.DisposalCompleted, resources = host.ReleasedResources.ToArray() } };
    }

    private static Guid Id(int number) => Guid.Parse("ba400000-0000-0000-0000-" + number.ToString("D12"));
    private static void Write(string filename, string value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
        File.WriteAllText(filename, value);
    }
    private static object[] Files(string root) => new[] { "metadata", "data" }.Select(folder => Path.Combine(root, folder))
        .Where(Directory.Exists).SelectMany(folder => Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
        .OrderBy(filename => filename, StringComparer.Ordinal).Select(filename => {
            var bytes = File.ReadAllBytes(filename);
            return (object)new { path = Path.GetRelativePath(root, filename).Replace('\\', '/'), bytes = bytes.Length,
                sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), content = Convert.ToBase64String(bytes) };
        }).ToArray();
}
