// Frozen constructor, BaseItemMapper, ItemPersistenceService and hydration oracle
// for the exact item types declared by the current production directory resolvers.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using AudioItem = MediaBrowser.Controller.Entities.Audio.Audio;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));

var inputText = File.ReadAllText(args[0]);
var input = JsonDocument.Parse(inputText).RootElement;
var outputPath = Path.GetFullPath(args[1]);
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new JsonStringEnumConverter());
var expectedTypes = new[]
{
    "Folder", "Movie", "Video", "Trailer", "MusicVideo", "Series", "Season", "Episode",
    "Audio", "AudioBook", "MusicAlbum", "MusicArtist", "Book", "Photo", "PhotoAlbum"
};
var suppliedTypes = input.EnumerateArray().Select(sample => sample.GetProperty("type").GetString()!).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
if (!suppliedTypes.SequenceEqual(expectedTypes.Order(StringComparer.Ordinal), StringComparer.Ordinal))
{
    throw new InvalidOperationException("The input must cover exactly the fourteen production resolver entity types.");
}

var results = new List<object>();
var sampleIndex = 0;
foreach (var sample in input.EnumerateArray())
{
    sampleIndex++;
    var name = sample.GetProperty("name").GetString()!;
    var typeName = sample.GetProperty("type").GetString()!;
    var parentKind = sample.GetProperty("parentKind").GetString()!;
    var sampleRoot = Path.Combine(stateRoot, name);
    Directory.CreateDirectory(sampleRoot);

    var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration"
        ? new ServerConfiguration()
        : Stub.Default(method.ReturnType));
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
        ? values![0]
        : Stub.Default(method.ReturnType));

    var rootParent = new Folder
    {
        Id = Guid.Parse("94000000-0000-0000-0000-000000000001"),
        Name = "Physical root",
        Path = Path.Combine(sampleRoot, "library")
    };
    var seriesParent = new Series
    {
        Id = Guid.Parse("94000000-0000-0000-0000-000000000002"),
        ParentId = rootParent.Id,
        Name = "Parent series",
        Path = Path.Combine(rootParent.Path, "Parent series")
    };
    var seasonParent = new Season
    {
        Id = Guid.Parse("94000000-0000-0000-0000-000000000003"),
        ParentId = seriesParent.Id,
        SeriesId = seriesParent.Id,
        SeriesName = seriesParent.Name,
        IndexNumber = 2,
        Name = "Season 02",
        Path = Path.Combine(seriesParent.Path, "Season 02")
    };
    var artistParent = new MusicArtist
    {
        Id = Guid.Parse("94000000-0000-0000-0000-000000000004"),
        ParentId = rootParent.Id,
        Name = "Parent artist",
        Path = Path.Combine(rootParent.Path, "Parent artist")
    };
    var albumParent = new MusicAlbum
    {
        Id = Guid.Parse("94000000-0000-0000-0000-000000000005"),
        ParentId = artistParent.Id,
        Name = "Parent album",
        Path = Path.Combine(artistParent.Path, "Parent album")
    };
    var linkedAlternate = new Video
    {
        Id = Guid.Parse("94000000-0000-0000-0000-000000000006"),
        ParentId = rootParent.Id,
        Name = "Linked alternate control",
        Path = Path.Combine(rootParent.Path, "linked-alternate.media")
    };
    var parentLookup = new Dictionary<Guid, BaseItem>
    {
        [rootParent.Id] = rootParent,
        [seriesParent.Id] = seriesParent,
        [seasonParent.Id] = seasonParent,
        [artistParent.Id] = artistParent,
        [albumParent.Id] = albumParent,
        [linkedAlternate.Id] = linkedAlternate
    };
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetItemById" => parentLookup.GetValueOrDefault((Guid)values![0]!),
        "GetCollectionFolders" => new List<Folder>(),
        "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Default(method.ReturnType)
    });

    var subject = Create(typeName);
    var constructor = ProjectItem(subject, sampleRoot);
    ApplyResolverEntityValues(subject, sampleIndex, typeName, parentKind, sampleRoot, rootParent, seriesParent, seasonParent, artistParent, albumParent, linkedAlternate);
    var resolvedLive = ProjectItem(subject, sampleRoot);
    var requiresJson = BaseItemMapper.TypeRequiresDeserialization(subject.GetType());

    var factory = new SqlFactory(Path.Combine(sampleRoot, "native.db"));
    using (var initial = factory.CreateDbContext())
    {
        initial.Database.EnsureCreated();
        initial.BaseItems.AddRange(parentLookup.Values.Select(parent => BaseItemMapper.Map(parent, appHost)));
        initial.SaveChanges();
    }

    var mapped = BaseItemMapper.Map(subject, appHost);
    Dictionary<string, object?> mapperColumns;
    using (var model = factory.CreateDbContext())
    {
        var properties = ScalarProperties(model);
        if (properties.Length != 72) throw new InvalidOperationException($"Expected 72 mapped BaseItems columns, found {properties.Length}.");
        mapperColumns = ProjectColumns(mapped, properties, sampleRoot);
    }

    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    persistence.SaveItems([subject], CancellationToken.None);

    using var final = factory.CreateDbContext();
    var stored = final.BaseItems.AsNoTracking()
        .Include(row => row.Provider)
        .Include(row => row.LockedFields)
        .Include(row => row.TrailerTypes)
        .Include(row => row.Images)
        .Include(row => row.LinkedChildEntities)
        .Single(row => row.Id == subject.Id);
    var propertiesAfter = ScalarProperties(final);
    if (propertiesAfter.Length != 72) throw new InvalidOperationException($"Expected 72 stored BaseItems columns, found {propertiesAfter.Length}.");
    var storedColumns = ProjectColumns(stored, propertiesAfter, sampleRoot);
    var hydrated = BaseItemMapper.DeserializeBaseItem(stored, NullLogger<BaseItem>.Instance, appHost)
        ?? throw new InvalidOperationException("The saved entity did not hydrate.");
    var values = final.ItemValues.AsNoTracking().AsEnumerable().OrderBy(value => (int)value.Type).ThenBy(value => value.Value, StringComparer.Ordinal)
        .Select(value => new { key = ValueKey(value), type = (int)value.Type, value = value.Value, cleanValue = value.CleanValue }).ToArray();
    var valueKeys = final.ItemValues.AsNoTracking().AsEnumerable().ToDictionary(value => value.ItemValueId, ValueKey);
    var maps = final.ItemValuesMap.AsNoTracking().Where(row => row.ItemId == subject.Id).AsEnumerable()
        .Select(row => new { itemId = Id(row.ItemId), valueKey = valueKeys[row.ItemValueId] })
        .OrderBy(row => row.valueKey, StringComparer.Ordinal).ToArray();
    var ancestors = final.AncestorIds.AsNoTracking().Where(row => row.ItemId == subject.Id).AsEnumerable()
        .Select(row => new { itemId = Id(row.ItemId), parentItemId = Id(row.ParentItemId) })
        .OrderBy(row => row.parentItemId, StringComparer.Ordinal).ToArray();
    var providers = final.BaseItemProviders.AsNoTracking().Where(row => row.ItemId == subject.Id).AsEnumerable()
        .Select(row => new { itemId = Id(row.ItemId), row.ProviderId, row.ProviderValue })
        .OrderBy(row => row.ProviderId, StringComparer.Ordinal).ToArray();
    var lockedFields = final.BaseItemMetadataFields.AsNoTracking().Where(row => row.ItemId == subject.Id).AsEnumerable()
        .Select(row => new { itemId = Id(row.ItemId), row.Id }).OrderBy(row => row.Id).ToArray();
    var trailerTypes = final.BaseItemTrailerTypes.AsNoTracking().Where(row => row.ItemId == subject.Id).AsEnumerable()
        .Select(row => new { itemId = Id(row.ItemId), row.Id }).OrderBy(row => row.Id).ToArray();
    var images = final.BaseItemImageInfos.AsNoTracking().Where(row => row.ItemId == subject.Id).AsEnumerable()
        .Select(row => new
        {
            itemId = Id(row.ItemId),
            path = ProjectPath(row.Path, sampleRoot),
            dateModified = NullableDate(row.DateModified),
            imageType = row.ImageType.ToString(),
            row.Width,
            row.Height,
            blurHash = row.Blurhash is null ? null : Encoding.UTF8.GetString(row.Blurhash)
        }).OrderBy(row => row.imageType, StringComparer.Ordinal).ThenBy(row => row.path, StringComparer.Ordinal).ToArray();
    var links = final.LinkedChildren.AsNoTracking().Where(row => row.ParentId == subject.Id || row.ChildId == subject.Id).AsEnumerable()
        .Select(row => new { parentId = Id(row.ParentId), childId = Id(row.ChildId), childType = (int)row.ChildType, row.SortOrder })
        .OrderBy(row => row.parentId, StringComparer.Ordinal).ThenBy(row => row.SortOrder).ToArray();
    var parentRows = final.BaseItems.AsNoTracking().Where(row => parentLookup.Keys.Contains(row.Id)).AsEnumerable()
        .Select(row => new { id = Id(row.Id), row.Type, parentId = row.ParentId.HasValue ? Id(row.ParentId.Value) : null,
            row.IsFolder, dataIsNull = row.Data is null }).OrderBy(row => row.id, StringComparer.Ordinal).ToArray();

    results.Add(new
    {
        name,
        type = typeName,
        parentKind,
        nativeType = subject.GetType().FullName,
        requiresJson,
        constructor,
        resolvedLive,
        mapper = new
        {
            columnCount = mapperColumns.Count,
            columns = mapperColumns,
            dataText = NormalizeDataText(mapped.Data, sampleRoot),
            data = ProjectData(mapped.Data, sampleRoot)
        },
        stored = new
        {
            columnCount = storedColumns.Count,
            columns = storedColumns,
            dataIsNull = stored.Data is null,
            dataText = NormalizeDataText(stored.Data, sampleRoot),
            data = ProjectData(stored.Data, sampleRoot)
        },
        lookup = ProjectItem(hydrated, sampleRoot),
        relations = new { ancestors, providers, values, maps, lockedFields, trailerTypes, images, links },
        parentRows
    });
}

var assemblies = new[]
{
    typeof(BaseItem).Assembly,
    typeof(ItemPersistenceService).Assembly,
    typeof(JellyfinDbContext).Assembly,
    typeof(SqliteDatabaseProvider).Assembly
}.Distinct().Select(assembly => new
{
    name = assembly.GetName().Name,
    path = assembly.Location,
    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
}).ToArray();
var result = new
{
    actualFrozenNativeResolverEntityTypes = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    exactTypeCount = expectedTypes.Length,
    caseCount = results.Count,
    mappedColumnCount = 72,
    results,
    assemblies,
    scope = "Actual frozen CLR constructors, BaseItemMapper.Map, ItemPersistenceService.SaveItems, EF SQLite and BaseItemMapper.DeserializeBaseItem for the exact fifteen entity types in the candidate's production directory resolvers. Sixteen independent cases include physical and by-name MusicArtist plus AudioBook, Book, Photo and PhotoAlbum. Controlled resolved values mirror the narrow candidate drafts; Season and Episode parent relationship fields are assigned exactly as frozen SeasonResolver/EpisodeResolver do, but no filesystem resolver is executed. Each case records constructor/live/hydrated typed defaults, including normalized nullable Folder.DateLastMediaAdded and Folder.LinkedChildrenLoaded across constructor, resolved live state and hydrated lookup; all 72 mapped BaseItems scalar columns; exact normalized Data text plus parsed Data/null policy; and complete subject ancestor/provider/value/locked/trailer/link relations. Parent lookup, empty collection folders, library options, path reversal and fixed timestamps are controls. No LibraryManager.CreateItems cache/events, Folder.ValidateChildren, metadata providers, recursive scan, PostgreSQL candidate, faults/cancellation, HTTP, migration or release acceptance."
};
File.WriteAllText(outputPath, JsonSerializer.Serialize(result, json) + "\n");

static BaseItem Create(string type) => type switch
{
    "Folder" => new Folder(),
    "Movie" => new Movie(),
    "Video" => new Video(),
    "Trailer" => new Trailer(),
    "MusicVideo" => new MusicVideo(),
    "Series" => new Series(),
    "Season" => new Season(),
    "Episode" => new Episode(),
    "Audio" => new AudioItem(),
    "AudioBook" => new AudioBook(),
    "MusicAlbum" => new MusicAlbum(),
    "MusicArtist" => new MusicArtist(),
    "Book" => new Book(),
    "Photo" => new Photo(),
    "PhotoAlbum" => new PhotoAlbum(),
    _ => throw new ArgumentOutOfRangeException(nameof(type), type, "Unknown resolver entity type.")
};

static void ApplyResolverEntityValues(BaseItem item, int index, string type, string parentKind, string root,
    Folder rootParent, Series seriesParent, Season seasonParent, MusicArtist artistParent, MusicAlbum albumParent,
    Video linkedAlternate)
{
    item.Id = Guid.Parse($"93000000-0000-0000-0000-{index.ToString("D12", System.Globalization.CultureInfo.InvariantCulture)}");
    item.Name = "Resolved " + type;
    item.Path = Path.Combine(root, type is "Movie" or "Video" or "Trailer" or "MusicVideo" or "Episode" or "Audio" or "AudioBook" or "Book" or "Photo"
        ? type + ".media"
        : type);
    item.ParentId = parentKind switch
    {
        "root" => rootParent.Id,
        "series" => seriesParent.Id,
        "season" => seasonParent.Id,
        "artist" => artistParent.Id,
        "album" => albumParent.Id,
        "none" => Guid.Empty,
        _ => throw new ArgumentOutOfRangeException(nameof(parentKind), parentKind, "Unknown parent kind.")
    };
    item.DateCreated = new DateTime(2026, 10, 7, 1, 2, 3, DateTimeKind.Utc).AddTicks(index);
    item.DateModified = new DateTime(2026, 10, 7, 2, 3, 4, DateTimeKind.Utc).AddTicks(index);
    item.DateLastSaved = new DateTime(2026, 10, 7, 3, 4, 5, DateTimeKind.Utc).AddTicks(index);
    item.DateLastRefreshed = new DateTime(2026, 10, 7, 4, 5, 6, DateTimeKind.Utc).AddTicks(index);
    item.PresentationUniqueKey = "resolver-key-" + type.ToLowerInvariant();
    item.ProductionYear = 2026;
    item.Size = 4096 + index;
    item.RunTimeTicks = 10000000L * index;
    item.Width = 1920;
    item.Height = 1080;
    item.IsLocked = true;
    item.LockedFields = [MetadataField.Name];
    item.Genres = ["Resolver Genre"];
    item.Studios = ["Resolver Studio"];
    item.Tags = ["Resolver Tag"];
    item.ProductionLocations = ["Resolver Location"];
    item.ProviderIds["ResolverOracle"] = type;
    item.RemoteTrailers = [new MediaUrl { Url = "https://resolver.invalid/" + type.ToLowerInvariant(), Name = "Resolver trailer" }];
    item.ImageInfos =
    [
        new ItemImageInfo
        {
            Path = Path.Combine(root, type + "-primary.jpg"),
            Type = ImageType.Primary,
            DateModified = new DateTime(2026, 10, 7, 5, 6, 7, DateTimeKind.Utc).AddTicks(index),
            Width = 640,
            Height = 360,
            BlurHash = "resolver-blur-" + type.ToLowerInvariant()
        }
    ];
    if (item is Video video)
    {
        video.AdditionalParts = [Path.Combine(root, type + "-part2.media")];
        video.LocalAlternateVersions = [Path.Combine(root, type + "-alternate.media")];
        video.SubtitleFiles = [Path.Combine(root, type + ".eng.srt")];
        video.AudioFiles = [Path.Combine(root, type + ".commentary.mka")];
        video.LinkedAlternateVersions =
        [
            new LinkedChild
            {
                ItemId = linkedAlternate.Id,
                Type = MediaBrowser.Controller.Entities.LinkedChildType.LinkedAlternateVersion
            }
        ];
    }
    if (item is Trailer trailer) trailer.TrailerTypes = [TrailerType.LocalTrailer, TrailerType.Archive];
    if (item is Series series) series.AirDays = [DayOfWeek.Monday, DayOfWeek.Wednesday];
    if (item is Season season)
    {
        season.SeriesId = seriesParent.Id;
        season.SeriesName = seriesParent.Name;
        season.IndexNumber = 2;
    }
    if (item is Episode episode)
    {
        episode.SeriesId = seriesParent.Id;
        episode.SeriesName = seriesParent.Name;
        episode.SeasonId = seasonParent.Id;
        episode.SeasonName = seasonParent.Name;
        episode.IndexNumber = 3;
        episode.ParentIndexNumber = 2;
    }
    if (item is IHasArtist hasArtist) hasArtist.Artists = ["Resolver Artist"];
    if (item is IHasAlbumArtist hasAlbumArtist) hasAlbumArtist.AlbumArtists = ["Resolver Album Artist"];
    if (item is AudioItem audio)
    {
        audio.Album = albumParent.Name;
        audio.IsInMixedFolder = true;
        audio.LyricFiles = [Path.Combine(root, type + ".lrc")];
    }
}

static object ProjectItem(BaseItem item, string root)
{
    var hasSeries = item as IHasSeries;
    var episode = item as Episode;
    var video = item as Video;
    var audio = item as AudioItem;
    var folder = item as Folder;
    var series = item as Series;
    var artist = item as MusicArtist;
    return new
    {
        type = item.GetType().FullName,
        id = Id(item.Id),
        parentId = Id(item.ParentId),
        name = item.Name,
        path = ProjectPath(item.Path, root),
        isFolder = item.IsFolder,
        isRoot = folder?.IsRoot,
        dateLastMediaAdded = NullableDate(folder?.DateLastMediaAdded),
        linkedChildrenLoaded = folder?.LinkedChildrenLoaded,
        mediaType = item.MediaType.ToString(),
        sourceType = item.SourceType.ToString(),
        unratedType = item.GetBlockUnratedType().ToString(),
        mixed = item.IsInMixedFolder,
        locked = item.IsLocked,
        productionYear = item.ProductionYear,
        size = item.Size,
        runTimeTicks = item.RunTimeTicks,
        width = item.Width,
        height = item.Height,
        dates = new { created = Date(item.DateCreated), modified = Date(item.DateModified), saved = Date(item.DateLastSaved), refreshed = NullableDate(item.DateLastRefreshed) },
        lists = new
        {
            Genres = item.Genres?.ToArray(),
            Studios = item.Studios?.ToArray(),
            Tags = item.Tags?.ToArray(),
            ProductionLocations = item.ProductionLocations?.ToArray(),
            artists = item is IHasArtist hasArtist ? hasArtist.Artists?.ToArray() : null,
            albumArtists = item is IHasAlbumArtist hasAlbumArtist ? hasAlbumArtist.AlbumArtists?.ToArray() : null,
            remoteTrailers = item.RemoteTrailers?.Select(value => new { value.Url, value.Name }).ToArray()
        },
        images = item.ImageInfos?.Select(value => new
        {
            path = ProjectPath(value.Path, root),
            type = value.Type.ToString(),
            dateModified = Date(value.DateModified),
            value.Width,
            value.Height,
            value.BlurHash
        }).ToArray(),
        providerIds = item.ProviderIds?.OrderBy(value => value.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(value => value.Key, value => value.Value, StringComparer.OrdinalIgnoreCase),
        lockedFields = item.LockedFields?.Select(value => value.ToString()).ToArray(),
        video = video is null ? null : new
        {
            primaryVersionId = video.PrimaryVersionId.HasValue ? Id(video.PrimaryVersionId.Value) : null,
            additionalParts = video.AdditionalParts?.Select(value => ProjectPath(value, root)).ToArray(),
            localAlternates = video.LocalAlternateVersions?.Select(value => ProjectPath(value, root)).ToArray(),
            linkedAlternates = video.LinkedAlternateVersions?.Select(value => new { itemId = value.ItemId.HasValue ? Id(value.ItemId.Value) : null, type = value.Type.ToString() }).ToArray(),
            subtitleFiles = video.SubtitleFiles?.Select(value => ProjectPath(value, root)).ToArray(),
            audioFiles = video.AudioFiles?.Select(value => ProjectPath(value, root)).ToArray(),
            videoType = video.VideoType.ToString(),
            video.IsPlaceHolder,
            video.HasSubtitles
        },
        trailerTypes = item is Trailer trailer ? trailer.TrailerTypes?.Select(value => value.ToString()).ToArray() : null,
        airDays = series?.AirDays?.Select(value => value.ToString()).ToArray(),
        lyricFiles = audio?.LyricFiles?.Select(value => ProjectPath(value, root)).ToArray(),
        series = hasSeries is null ? null : new
        {
            seriesId = Id(hasSeries.SeriesId),
            hasSeries.SeriesName,
            hasSeries.SeriesPresentationUniqueKey,
            seasonId = episode is null ? null : Id(episode.SeasonId),
            seasonName = episode?.SeasonName
        },
        musicArtist = artist is null ? null : new { artist.IsAccessedByName, artist.IsFolder }
    };
}

static Microsoft.EntityFrameworkCore.Metadata.IProperty[] ScalarProperties(JellyfinDbContext context) =>
    context.Model.FindEntityType(typeof(BaseItemEntity))!.GetProperties().ToArray();

static Dictionary<string, object?> ProjectColumns(BaseItemEntity row,
    IReadOnlyList<Microsoft.EntityFrameworkCore.Metadata.IProperty> properties, string root) =>
    properties.ToDictionary(property => property.Name, property =>
    {
        if (property.PropertyInfo is null) throw new InvalidOperationException("A mapped column has no CLR property: " + property.Name);
        var value = property.PropertyInfo.GetValue(row);
        if (value is null) return null;
        if (property.Name == "Data") return ProjectData((string)value, root);
        if (value is Guid identifier) return Id(identifier);
        if (value is DateTime timestamp) return Date(timestamp);
        if (value is string text) return ProjectPath(text, root);
        return value;
    });

static JsonNode? ProjectData(string? value, string root)
{
    if (value is null) return null;
    var node = JsonNode.Parse(value);
    Rewrite(node);
    return node;

    void Rewrite(JsonNode? current)
    {
        if (current is JsonObject obj)
        {
            foreach (var (key, child) in obj.ToArray())
            {
                if (child is JsonValue scalar && scalar.TryGetValue<string>(out var text)) obj[key] = ProjectPath(text, root);
                else Rewrite(child);
            }
        }
        else if (current is JsonArray array)
        {
            for (var index = 0; index < array.Count; index++)
            {
                if (array[index] is JsonValue scalar && scalar.TryGetValue<string>(out var text)) array[index] = ProjectPath(text, root);
                else Rewrite(array[index]);
            }
        }
    }
}

static string? NormalizeDataText(string? value, string root)
{
    if (value is null) return null;
    return value.Replace(root.Replace("\\", "\\\\", StringComparison.Ordinal), "$STATE", StringComparison.Ordinal)
        .Replace(root, "$STATE", StringComparison.Ordinal);
}

static string? ProjectPath(string? value, string root) => value?.Replace(root, "$STATE", StringComparison.Ordinal);
static string Id(Guid value) => value.ToString("D").ToLowerInvariant();
static string Date(DateTime value) => value.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture);
static string? NullableDate(DateTime? value) => value.HasValue ? Date(value.Value) : null;
static string ValueKey(ItemValue value) => $"$VALUE/{(int)value.Type}/{value.Value}";

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class
    {
        var value = Create<T, Stub>();
        ((Stub)(object)value).Handler = handler;
        return value;
    }
    public static object? Default(Type type) => type == typeof(void)
        ? null
        : type == typeof(Task)
            ? Task.CompletedTask
            : type.IsValueType
                ? Activator.CreateInstance(type)
                : null;
}

public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext() => new(
        new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance),
        new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
