// Current-pinned full-27 constructor, DeserializeBaseItem boundary and SaveItems lifecycle oracle.
using System.Collections;
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
using Jellyfin.Extensions.Json;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Drawing;
using MediaBrowser.Model.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using AudioItem = MediaBrowser.Controller.Entities.Audio.Audio;
using DatabaseLinkedChildType = Jellyfin.Database.Implementations.Entities.LinkedChildType;
using PlaylistItem = MediaBrowser.Controller.Playlists.Playlist;
using PlaylistsFolderItem = Emby.Server.Implementations.Playlists.PlaylistsFolder;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));

var inputText = File.ReadAllText(args[0]);
var input = JsonDocument.Parse(inputText).RootElement;
var outputPath = Path.GetFullPath(args[1]);
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
var outputJson = new JsonSerializerOptions { WriteIndented = true };
outputJson.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());

var definitions = input.GetProperty("coreTypes").EnumerateArray().Select((value, index) => new TypeDefinition(
    index + 1,
    value.GetProperty("name").GetString()!,
    value.GetProperty("fullName").GetString()!,
    value.GetProperty("requiresJson").GetBoolean())).ToArray();
var malformedNames = input.GetProperty("malformedTypes").EnumerateArray().Select(value => value.GetString()!).ToArray();
var sourceOnlyMalformedNames = input.GetProperty("sourceOnlyMalformedTypes").EnumerateArray().Select(value => value.GetString()!).ToArray();
var boundaryDefinitions = input.GetProperty("boundaryCases").EnumerateArray().Select(value => new BoundaryDefinition(
    value.GetProperty("name").GetString()!,
    value.GetProperty("fullName").GetString()!,
    value.GetProperty("mode").GetString()!,
    value.TryGetProperty("data", out var data) ? data.GetString() : null,
    value.TryGetProperty("storedType", out var storedType) ? storedType.GetString() : null)).ToArray();
var saveItemsNames = input.GetProperty("saveItemsTypes").EnumerateArray().Select(value => value.GetString()!).ToArray();
if (input.GetProperty("schemaVersion").GetInt32() != 1 || definitions.Length != 27
    || definitions.Select(value => value.FullName).Distinct(StringComparer.Ordinal).Count() != 27
    || malformedNames.Length != 15 || malformedNames.Distinct(StringComparer.Ordinal).Count() != 15
    || sourceOnlyMalformedNames.Length != 12 || sourceOnlyMalformedNames.Distinct(StringComparer.Ordinal).Count() != 12
    || boundaryDefinitions.Length != 10 || boundaryDefinitions.Select(value => value.Name).Distinct(StringComparer.Ordinal).Count() != 10
    || saveItemsNames.Length != 27 || saveItemsNames.Distinct(StringComparer.Ordinal).Count() != 27)
{
    throw new InvalidOperationException("The input must contain exactly 27 core types, 15 JSON-malformed types, 12 source-only malformed types and 10 distinct boundary cases.");
}

var explicitRegistryNames = new[]
{
    typeof(Folder).FullName!, typeof(AggregateFolder).FullName!, typeof(UserRootFolder).FullName!,
    typeof(CollectionFolder).FullName!, typeof(UserView).FullName!, typeof(PlaylistsFolderItem).FullName!,
    typeof(PlaylistItem).FullName!, typeof(Movie).FullName!, typeof(Video).FullName!, typeof(Episode).FullName!,
    typeof(Series).FullName!, typeof(Season).FullName!, typeof(BoxSet).FullName!, typeof(AudioItem).FullName!,
    typeof(AudioBook).FullName!, typeof(MusicVideo).FullName!, typeof(Trailer).FullName!, typeof(MusicAlbum).FullName!,
    typeof(MusicArtist).FullName!, typeof(Person).FullName!, typeof(Genre).FullName!, typeof(MusicGenre).FullName!,
    typeof(Studio).FullName!, typeof(Year).FullName!, typeof(Photo).FullName!, typeof(PhotoAlbum).FullName!, typeof(Book).FullName!
};
if (!definitions.Select(value => value.FullName).Order(StringComparer.Ordinal)
    .SequenceEqual(explicitRegistryNames.Order(StringComparer.Ordinal), StringComparer.Ordinal))
{
    throw new InvalidOperationException("The input does not match the explicit exact-full-name registry.");
}
if (!saveItemsNames.ToHashSet(StringComparer.Ordinal).SetEquals(explicitRegistryNames))
{
    throw new InvalidOperationException("SaveItems cases must cover the same exact 27 known constructor/mapper types.");
}

foreach (var definition in definitions)
{
    var actual = BaseItemMapper.TypeRequiresDeserialization(Create(definition.FullName).GetType());
    if (actual != definition.RequiresJson)
    {
        throw new InvalidOperationException($"TypeRequiresDeserialization changed for {definition.FullName}: {actual}.");
    }
}

var malformedSet = malformedNames.ToHashSet(StringComparer.Ordinal);
if (!definitions.Where(value => value.RequiresJson).Select(value => value.FullName).ToHashSet(StringComparer.Ordinal).SetEquals(malformedSet))
{
    throw new InvalidOperationException("Malformed cases must cover exactly the 15 JSON-required types.");
}
if (!definitions.Where(value => !value.RequiresJson).Select(value => value.FullName).ToHashSet(StringComparer.Ordinal)
    .SetEquals(sourceOnlyMalformedNames))
{
    throw new InvalidOperationException("Source-only malformed cases must cover exactly the 12 RequiresSourceSerialisation types.");
}
var expectedBoundaryModes = new[]
{
    "sql-null", "data", "data", "data", "data", "data", "data", "explicit-skip", "configured-skip", "unknown-type"
}.Order(StringComparer.Ordinal);
if (!boundaryDefinitions.All(value => explicitRegistryNames.Contains(value.FullName, StringComparer.Ordinal))
    || !boundaryDefinitions.Select(value => value.Mode).Order(StringComparer.Ordinal).SequenceEqual(expectedBoundaryModes, StringComparer.Ordinal))
{
    throw new InvalidOperationException("Boundary cases must use known seed types and the exact 7 data, 2 skip and 1 unknown-type modes.");
}

var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration"
    ? new ServerConfiguration()
    : Stub.Default(method.ReturnType));
BaseItem.ConfigurationManager = configuration;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ReverseVirtualPath" or "ExpandVirtualPath"
    ? values![0]
    : Stub.Default(method.ReturnType));
CollectionFolder.ApplicationHost = appHost;

var results = new List<object>();
foreach (var definition in definitions)
{
    results.Add(RunCase(definition, "core", null));
}

foreach (var fullName in malformedNames)
{
    var definition = definitions.Single(value => value.FullName == fullName);
    results.Add(RunCase(definition, "malformed", "bad{"));
}

foreach (var fullName in sourceOnlyMalformedNames)
{
    var definition = definitions.Single(value => value.FullName == fullName);
    results.Add(RunCase(definition, "source-malformed", "bad{"));
}

foreach (var boundary in boundaryDefinitions)
{
    var definition = definitions.Single(value => value.FullName == boundary.FullName);
    results.Add(RunCase(definition, boundary.Name, boundary.Data, new CaseOptions(
        ForceNullData: boundary.Mode == "sql-null",
        ExplicitSkip: boundary.Mode == "explicit-skip",
        ConfiguredSkip: boundary.Mode == "configured-skip",
        StoredTypeOverride: boundary.Mode == "unknown-type" ? boundary.StoredType : null)));
}

foreach (var fullName in saveItemsNames)
{
    results.Add(RunSaveItemsCase(definitions.Single(value => value.FullName == fullName)));
}

object RunCase(TypeDefinition definition, string kind, string? forcedData, CaseOptions? options = null)
{
    var caseName = kind + "-" + definition.Name;
    var caseRoot = Path.Combine(stateRoot, caseName);
    Directory.CreateDirectory(caseRoot);
    var subjectId = Guid.Parse($"95000000-0000-0000-{definition.Index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-{(kind == "core" ? 1 : 2).ToString("D12", System.Globalization.CultureInfo.InvariantCulture)}");
    var rootId = Guid.Parse($"95100000-0000-0000-{definition.Index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000001");
    var seriesId = Guid.Parse($"95100000-0000-0000-{definition.Index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000002");
    var seasonId = Guid.Parse($"95100000-0000-0000-{definition.Index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000003");
    var linkedId = Guid.Parse($"95100000-0000-0000-{definition.Index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000004");
    var userId = Guid.Parse($"95100000-0000-0000-{definition.Index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000005");
    var valueId = Guid.Parse($"95100000-0000-0000-{definition.Index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000006");

    var rootParent = new Folder { Id = rootId, Name = "DB root", Path = Path.Combine(caseRoot, "library") };
    var seriesParent = new Series { Id = seriesId, ParentId = rootId, Name = "DB series", Path = Path.Combine(rootParent.Path, "series") };
    var seasonParent = new Season
    {
        Id = seasonId,
        ParentId = seriesId,
        SeriesId = seriesId,
        SeriesName = seriesParent.Name,
        Name = "DB season",
        Path = Path.Combine(seriesParent.Path, "season")
    };
    var linkedChild = new Folder { Id = linkedId, ParentId = rootId, Name = "DB linked child", Path = Path.Combine(rootParent.Path, "linked") };
    var lookup = new Dictionary<Guid, BaseItem>
    {
        [rootId] = rootParent,
        [seriesId] = seriesParent,
        [seasonId] = seasonParent,
        [linkedId] = linkedChild
    };
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetItemById" => lookup.GetValueOrDefault((Guid)values![0]!),
        "GetCollectionFolders" => new List<Folder>(),
        "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Default(method.ReturnType)
    });

    var constructor = Create(definition.FullName);
    var constructorTwin = Create(definition.FullName);
    var constructorProjection = ProjectItem(constructor, caseRoot);
    var constructorTypedJson = SerializeTyped(constructor, caseRoot);
    var mutableIsolation = ProjectMutableIsolation(constructor, constructorTwin);
    var computedTraits = ProjectComputedTraits(definition.FullName, definition.Index);

    string? data;
    object poisonProjection;
    object poisonTypedJson;
    if (options?.ForceNullData == true)
    {
        data = null;
        poisonProjection = new { intentionallyAbsent = true };
        poisonTypedJson = new { intentionallyAbsent = true };
    }
    else if (forcedData is not null)
    {
        data = forcedData;
        poisonProjection = new { intentionallyAbsent = true };
        poisonTypedJson = new { intentionallyAbsent = true };
    }
    else if (definition.RequiresJson)
    {
        var poison = Create(definition.FullName);
        ApplyJsonPoison(poison, definition.Index, caseRoot, rootParent, seriesParent, seasonParent, linkedChild);
        poisonProjection = ProjectItem(poison, caseRoot);
        var serialized = SerializeTyped(poison, caseRoot, requireSuccess: true);
        poisonTypedJson = serialized;
        data = JsonSerializer.Serialize(poison, poison.GetType(), JsonDefaults.Options);
    }
    else
    {
        data = "{\"RemoteTrailers\":[{\"Url\":\"https://poison.invalid/source-only\",\"Name\":\"source-only poison\"}],\"UnknownPoison\":\"must be ignored\"}";
        poisonProjection = new { sourceOnlyPoison = true };
        poisonTypedJson = ProjectJsonText(data, caseRoot);
    }

    var overlay = Create(definition.FullName);
    ApplyDatabaseOverlay(overlay, definition.Index, caseRoot, subjectId, rootParent, seriesParent, seasonParent, linkedChild);
    var overlayProjection = ProjectItem(overlay, caseRoot);
    var row = BaseItemMapper.Map(overlay, appHost);
    row.Data = data;
    if (options?.StoredTypeOverride is not null) row.Type = options.StoredTypeOverride;
    var user = new Jellyfin.Database.Implementations.Entities.User("typed-oracle", "oracle-auth", "oracle-reset") { Id = userId };
    row.UserData =
    [
        new Jellyfin.Database.Implementations.Entities.UserData
        {
            ItemId = subjectId,
            Item = row,
            UserId = userId,
            User = user,
            CustomDataKey = "typed-oracle-key",
            Rating = 8.5,
            PlaybackPositionTicks = 123456789,
            PlayCount = 3,
            IsFavorite = true,
            LastPlayedDate = Utc(2026, 10, 7, 7, 8, 9, definition.Index),
            Played = true,
            AudioStreamIndex = 2,
            SubtitleStreamIndex = 4,
            Likes = false
        }
    ];

    var factory = new SqlFactory(Path.Combine(caseRoot, "native.db"));
    using (var initial = factory.CreateDbContext())
    {
        initial.Database.EnsureCreated();
        initial.Users.Add(user);
        initial.BaseItems.AddRange(
            BaseItemMapper.Map(rootParent, appHost),
            BaseItemMapper.Map(seriesParent, appHost),
            BaseItemMapper.Map(seasonParent, appHost),
            BaseItemMapper.Map(linkedChild, appHost));
        initial.BaseItems.Add(row);
        initial.SaveChanges();

        initial.AncestorIds.Add(new AncestorId
        {
            ParentItemId = rootId,
            ItemId = subjectId,
            ParentItem = null!,
            Item = null!
        });
        var itemValue = new ItemValue
        {
            ItemValueId = valueId,
            Type = ItemValueType.Genre,
            Value = "DB relation genre",
            CleanValue = "db relation genre"
        };
        initial.ItemValues.Add(itemValue);
        initial.ItemValuesMap.Add(new ItemValueMap
        {
            ItemId = subjectId,
            ItemValueId = valueId,
            Item = null!,
            ItemValue = itemValue
        });
        if (overlay is Folder or Video)
        {
            initial.LinkedChildren.Add(new LinkedChildEntity
            {
                ParentId = subjectId,
                ChildId = linkedId,
                ChildType = overlay is Video ? DatabaseLinkedChildType.LinkedAlternateVersion : DatabaseLinkedChildType.Manual,
                SortOrder = 7
            });
        }

        initial.SaveChanges();
    }

    using var final = factory.CreateDbContext();
    var stored = final.BaseItems.AsNoTracking().AsSplitQuery()
        .Include(value => value.Provider)
        .Include(value => value.LockedFields)
        .Include(value => value.TrailerTypes)
        .Include(value => value.Images)
        .Include(value => value.LinkedChildEntities)
        .Include(value => value.UserData)
        .Single(value => value.Id == subjectId);
    var scalarProperties = ScalarProperties(final);
    if (scalarProperties.Length != 72)
    {
        throw new InvalidOperationException($"Expected 72 BaseItems scalar columns, found {scalarProperties.Length}.");
    }

    var logger = new CaptureLogger();
    BaseItem? hydrated;
    if (options?.ConfiguredSkip == true)
    {
        var configuredSkip = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration"
            ? new ServerConfiguration { SkipDeserializationForBasicTypes = true }
            : Stub.Default(method.ReturnType));
        var repository = new BaseItemRepository(factory, appHost, Stub.Make<IItemTypeLookup>((method, _) => Stub.Default(method.ReturnType)), configuredSkip, logger);
        hydrated = repository.DeserializeBaseItem(stored);
    }
    else
    {
        hydrated = BaseItemMapper.DeserializeBaseItem(stored, logger, appHost, options?.ExplicitSkip == true);
    }
    if (hydrated is null && options?.StoredTypeOverride is null)
    {
        throw new InvalidOperationException("A known exact full name hydrated as null.");
    }
    object hydratedProjection = hydrated is null ? new { isNull = true } : ProjectItem(hydrated, caseRoot);
    object hydratedTypedJson = hydrated is null ? new { intentionallyAbsent = true } : SerializeTyped(hydrated, caseRoot);
    return new
    {
        name = caseName,
        kind,
        shortName = definition.Name,
        fullName = stored.Type,
        requiresJson = definition.RequiresJson,
        constructor = new
        {
            item = constructorProjection,
            typedJson = constructorTypedJson,
            mutableIsolation,
            computedTraits
        },
        poison = new { item = poisonProjection, typedJson = poisonTypedJson },
        databaseOverlay = new
        {
            live = overlayProjection,
            columnCount = scalarProperties.Length,
            columns = ProjectColumns(stored, scalarProperties, caseRoot),
            data = ProjectJsonText(stored.Data, caseRoot),
            relations = ProjectRelations(final, subjectId, caseRoot)
        },
        hydrated = new
        {
            item = hydratedProjection,
            typedJson = hydratedTypedJson
        },
        logs = logger.Events
    };
}

object RunSaveItemsCase(TypeDefinition definition)
{
    var caseName = "saveitems-" + definition.Name;
    var caseRoot = Path.Combine(stateRoot, caseName);
    Directory.CreateDirectory(caseRoot);
    var subjectId = SaveGuid(definition.Index, 1);
    var controls = CreateSaveControls(definition.Index, subjectId, caseRoot);
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetItemById" => controls.Lookup.GetValueOrDefault((Guid)values![0]!),
        "GetCollectionFolders" => new List<Folder>(),
        "GetLibraryOptions" => new LibraryOptions(),
        "GetLocalAlternateVersionIds" => Array.Empty<Guid>(),
        _ => Stub.Default(method.ReturnType)
    });

    var factory = new SqlFactory(Path.Combine(caseRoot, "native.db"));
    using (var initial = factory.CreateDbContext())
    {
        initial.Database.EnsureCreated();
        initial.BaseItems.AddRange(controls.Items.Select(value => BaseItemMapper.Map(value, appHost)));
        initial.SaveChanges();
    }

    var subject = Create(definition.FullName);
    subject.Id = subjectId;
    controls.Lookup[subjectId] = subject;
    var persistenceLogger = new CaptureLogger();
    var persistence = new ItemPersistenceService(factory, appHost, persistenceLogger);

    object SaveStage(string stage, Action apply)
    {
        apply();
        var live = ProjectSaveItem(subject, caseRoot);
        var liveTypedJson = SerializeTyped(subject, caseRoot, requireSuccess: true);
        var mapped = BaseItemMapper.Map(subject, appHost);
        object mapper;
        using (var model = factory.CreateDbContext())
        {
            var properties = ScalarProperties(model);
            if (properties.Length != 72) throw new InvalidOperationException($"Expected 72 mapped BaseItems columns, found {properties.Length}.");
            mapper = new
            {
                columnCount = properties.Length,
                columns = ProjectColumns(mapped, properties, caseRoot),
                data = ProjectJsonText(mapped.Data, caseRoot)
            };
        }

        var logOffset = persistenceLogger.Events.Count;
        persistence.SaveItems([subject], CancellationToken.None);
        var logs = persistenceLogger.Events.Skip(logOffset).ToArray();
        return new
        {
            stage,
            live,
            liveTypedJson,
            mapper,
            stored = ProjectSaveSnapshot(factory, appHost, subjectId, controls, caseRoot),
            logs
        };
    }

    void MarkOwned(Video control)
    {
        using var ownership = factory.CreateDbContext();
        var row = ownership.BaseItems.Single(value => value.Id == control.Id);
        row.OwnerId = subjectId;
        ownership.SaveChanges();
        control.OwnerId = subjectId;
    }

    var created = SaveStage("created", () => ApplySaveValues(subject, definition.Index, 1, caseRoot, controls));
    MarkOwned(controls.LocalA);
    var updated = SaveStage("updated", () => ApplySaveValues(subject, definition.Index, 2, caseRoot, controls));
    MarkOwned(controls.LocalB);
    var cleared = SaveStage("cleared", () => ApplySaveClear(subject, definition.Index));
    return new
    {
        name = caseName,
        kind = "saveitems",
        shortName = definition.Name,
        fullName = definition.FullName,
        requiresJson = definition.RequiresJson,
        stages = new { created, updated, cleared }
    };
}

var assemblies = new[]
{
    typeof(BaseItem).Assembly,
    typeof(PlaylistsFolderItem).Assembly,
    typeof(BaseItemMapper).Assembly,
    typeof(JellyfinDbContext).Assembly,
    typeof(SqliteDatabaseProvider).Assembly
}.Distinct().Select(assembly => new
{
    name = assembly.GetName().Name,
    path = assembly.Location,
    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
}).ToArray();
var jsonPropertyManifest = ProjectJsonPropertyManifest(definitions.Select(value => Create(value.FullName).GetType()).Concat(
[
    typeof(MediaUrl),
    typeof(LinkedChild),
    typeof(PlaylistUserPermissions),
    typeof(ItemImageInfo)
]).Distinct().ToArray());
var jsonPropertyManifestText = JsonSerializer.Serialize(jsonPropertyManifest, outputJson);
var result = new
{
    actualFrozenFull27TypedCore = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    exactTypeCount = definitions.Length,
    coreCaseCount = definitions.Length,
    malformedCaseCount = malformedNames.Length,
    sourceOnlyMalformedCaseCount = sourceOnlyMalformedNames.Length,
    boundaryCaseCount = boundaryDefinitions.Length,
    saveItemsCaseCount = saveItemsNames.Length,
    caseCount = results.Count,
    mappedColumnCount = 72,
    jsonPropertyManifestSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(jsonPropertyManifestText))).ToLowerInvariant(),
    jsonPropertyManifest,
    results,
    assemblies,
    scope = "Current-pinned full-known-constructor/mapper type oracle: the original 64 constructor/DeserializeBaseItem cases are retained as full objects, followed by one actual ItemPersistenceService.SaveItems created-updated-cleared lifecycle for each of the same 27 exact CLR types. Every save stage records live typed state, actual JsonDefaults raw/parsed Data, all 72 mapped and stored BaseItems scalar columns, hydrated typed state, provider/lock/trailer/image/linked/user-data/ancestor/value relations and persistence logs. TrailerTypes update/clear behavior is observed rather than assumed. The top-level JsonDefaults property manifest comes from GetTypeInfo for the 27 types plus MediaUrl, LinkedChild, PlaylistUserPermissions and ItemImageInfo; it separates serializable accessors from ignored metadata and preserves declared order/type/nullability evidence. Raw random native relationship IDs remain unmodified. This is the 27 known constructor/deserializer/persistence type registry, not the set of runtime resolvers or producers. It does not claim recursive scan, HTTP, PostgreSQL, migration, candidate correctness or release acceptance."
};
File.WriteAllText(outputPath, JsonSerializer.Serialize(result, outputJson) + "\n");

static BaseItem Create(string fullName) => fullName switch
{
    "MediaBrowser.Controller.Entities.Folder" => new Folder(),
    "MediaBrowser.Controller.Entities.AggregateFolder" => new AggregateFolder(),
    "MediaBrowser.Controller.Entities.UserRootFolder" => new UserRootFolder(),
    "MediaBrowser.Controller.Entities.CollectionFolder" => new CollectionFolder(),
    "MediaBrowser.Controller.Entities.UserView" => new UserView(),
    "Emby.Server.Implementations.Playlists.PlaylistsFolder" => new PlaylistsFolderItem(),
    "MediaBrowser.Controller.Playlists.Playlist" => new PlaylistItem(),
    "MediaBrowser.Controller.Entities.Movies.Movie" => new Movie(),
    "MediaBrowser.Controller.Entities.Video" => new Video(),
    "MediaBrowser.Controller.Entities.TV.Episode" => new Episode(),
    "MediaBrowser.Controller.Entities.TV.Series" => new Series(),
    "MediaBrowser.Controller.Entities.TV.Season" => new Season(),
    "MediaBrowser.Controller.Entities.Movies.BoxSet" => new BoxSet(),
    "MediaBrowser.Controller.Entities.Audio.Audio" => new AudioItem(),
    "MediaBrowser.Controller.Entities.AudioBook" => new AudioBook(),
    "MediaBrowser.Controller.Entities.MusicVideo" => new MusicVideo(),
    "MediaBrowser.Controller.Entities.Trailer" => new Trailer(),
    "MediaBrowser.Controller.Entities.Audio.MusicAlbum" => new MusicAlbum(),
    "MediaBrowser.Controller.Entities.Audio.MusicArtist" => new MusicArtist(),
    "MediaBrowser.Controller.Entities.Person" => new Person(),
    "MediaBrowser.Controller.Entities.Genre" => new Genre(),
    "MediaBrowser.Controller.Entities.Audio.MusicGenre" => new MusicGenre(),
    "MediaBrowser.Controller.Entities.Studio" => new Studio(),
    "MediaBrowser.Controller.Entities.Year" => new Year(),
    "MediaBrowser.Controller.Entities.Photo" => new Photo(),
    "MediaBrowser.Controller.Entities.PhotoAlbum" => new PhotoAlbum(),
    "MediaBrowser.Controller.Entities.Book" => new Book(),
    _ => throw new ArgumentOutOfRangeException(nameof(fullName), fullName, "Unknown exact native type.")
};

static Guid SaveGuid(int typeIndex, int value) => Guid.Parse(
    $"96000000-0000-0000-{typeIndex.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-{value.ToString("D12", System.Globalization.CultureInfo.InvariantCulture)}");

static SaveControls CreateSaveControls(int index, Guid subjectId, string root)
{
    var rootA = new Folder { Id = SaveGuid(index, 10), Name = "Save root A", Path = Path.Combine(root, "library-a") };
    var rootB = new Folder { Id = SaveGuid(index, 11), Name = "Save root B", Path = Path.Combine(root, "library-b") };
    var seriesA = new Series { Id = SaveGuid(index, 12), ParentId = rootA.Id, Name = "Save series A", Path = Path.Combine(rootA.Path, "series-a") };
    var seriesB = new Series { Id = SaveGuid(index, 13), ParentId = rootB.Id, Name = "Save series B", Path = Path.Combine(rootB.Path, "series-b") };
    var seasonA = new Season
    {
        Id = SaveGuid(index, 14), ParentId = seriesA.Id, SeriesId = seriesA.Id, SeriesName = seriesA.Name,
        SeriesPresentationUniqueKey = "save-series-a", Name = "Save season A", Path = Path.Combine(seriesA.Path, "season-a")
    };
    var seasonB = new Season
    {
        Id = SaveGuid(index, 15), ParentId = seriesB.Id, SeriesId = seriesB.Id, SeriesName = seriesB.Name,
        SeriesPresentationUniqueKey = "save-series-b", Name = "Save season B", Path = Path.Combine(seriesB.Path, "season-b")
    };
    var artistA = new MusicArtist { Id = SaveGuid(index, 16), ParentId = rootA.Id, Name = "Save artist A", Path = Path.Combine(rootA.Path, "artist-a") };
    var artistB = new MusicArtist { Id = SaveGuid(index, 17), ParentId = rootB.Id, Name = "Save artist B", Path = Path.Combine(rootB.Path, "artist-b") };
    var albumA = new MusicAlbum { Id = SaveGuid(index, 18), ParentId = artistA.Id, Name = "Save album A", Path = Path.Combine(artistA.Path, "album-a") };
    var albumB = new MusicAlbum { Id = SaveGuid(index, 19), ParentId = artistB.Id, Name = "Save album B", Path = Path.Combine(artistB.Path, "album-b") };
    var folderChildA = new Folder { Id = SaveGuid(index, 20), ParentId = rootA.Id, Name = "Save folder child A", Path = Path.Combine(rootA.Path, "child-a") };
    var folderChildB = new Folder { Id = SaveGuid(index, 21), ParentId = rootB.Id, Name = "Save folder child B", Path = Path.Combine(rootB.Path, "child-b") };
    var localA = new Video
    {
        Id = SaveGuid(index, 22), ParentId = rootA.Id, Name = "Save local A", Path = Path.Combine(root, "local-a.media")
    };
    var localB = new Video
    {
        Id = SaveGuid(index, 23), ParentId = rootB.Id, Name = "Save local B", Path = Path.Combine(root, "local-b.media")
    };
    var linkedA = new Video { Id = SaveGuid(index, 24), ParentId = rootA.Id, Name = "Save linked A", Path = Path.Combine(root, "linked-a.media") };
    var linkedB = new Video { Id = SaveGuid(index, 25), ParentId = rootB.Id, Name = "Save linked B", Path = Path.Combine(root, "linked-b.media") };
    BaseItem[] items =
    [
        rootA, rootB, seriesA, seriesB, seasonA, seasonB, artistA, artistB, albumA, albumB,
        folderChildA, folderChildB, localA, localB, linkedA, linkedB
    ];
    return new SaveControls(
        rootA, rootB, seriesA, seriesB, seasonA, seasonB, artistA, artistB, albumA, albumB,
        folderChildA, folderChildB, localA, localB, linkedA, linkedB, items, items.ToDictionary(value => value.Id));
}

static void ApplySaveValues(BaseItem item, int index, int phase, string root, SaveControls controls)
{
    var update = phase == 2;
    var marker = update ? "update" : "create";
    var parentRoot = update ? controls.RootB : controls.RootA;
    var seriesParent = update ? controls.SeriesB : controls.SeriesA;
    var seasonParent = update ? controls.SeasonB : controls.SeasonA;
    var artistParent = update ? controls.ArtistB : controls.ArtistA;
    var albumParent = update ? controls.AlbumB : controls.AlbumA;
    var folderChild = update ? controls.FolderChildB : controls.FolderChildA;
    var localAlternate = update ? controls.LocalB : controls.LocalA;
    var linkedAlternate = update ? controls.LinkedB : controls.LinkedA;

    item.ParentId = item switch
    {
        Episode => seasonParent.Id,
        Season => seriesParent.Id,
        AudioItem => albumParent.Id,
        MusicAlbum => artistParent.Id,
        _ => parentRoot.Id
    };
    item.OwnerId = parentRoot.Id;
    item.ChannelId = SaveGuid(index, update ? 102 : 101);
    item.Name = $"Save {marker} {item.GetType().Name}";
    item.Path = Path.Combine(root, $"{marker}-{item.GetType().Name}" + (item is Video or AudioItem or Photo or Book ? ".media" : string.Empty));
    item.DateCreated = Utc(update ? 2026 : 2025, phase, 2, 3, 4, 5, index);
    item.DateModified = Utc(update ? 2026 : 2025, phase + 2, 3, 4, 5, 6, index);
    item.DateLastSaved = Utc(update ? 2026 : 2025, phase + 4, 4, 5, 6, 7, index);
    item.DateLastRefreshed = Utc(update ? 2026 : 2025, phase + 6, 5, 6, 7, 8, index);
    item.PremiereDate = Utc(update ? 2024 : 2023, phase, 6, 7, 8, 9, index);
    item.EndDate = Utc(update ? 2028 : 2027, phase, 7, 8, 9, 10, index);
    item.CommunityRating = update ? 9.25f : 7.75f;
    item.CriticRating = update ? 91.5f : 81.5f;
    item.CustomRating = update ? "UPDATE-RATING" : "CREATE-RATING";
    item.OfficialRating = update ? "DB-R" : "DB-PG";
    item.Overview = $"Save {marker} overview";
    item.OriginalTitle = $"Save {marker} original";
    item.OriginalLanguage = update ? "eng" : "zho";
    item.Tagline = $"Save {marker} tagline";
    item.HomePageUrl = $"https://save.invalid/{marker}";
    item.ExternalId = $"external-{marker}-{index}";
    item.ExternalSeriesId = $"external-series-{marker}-{index}";
    item.IndexNumber = update ? 22 : 11;
    item.ParentIndexNumber = update ? 44 : 33;
    item.InheritedParentalRatingValue = update ? 18 : 13;
    item.InheritedParentalRatingSubValue = update ? 2 : 1;
    item.ProductionYear = update ? 2032 : 2024;
    item.RunTimeTicks = update ? 9876543210123 : 1234567890123;
    item.Size = update ? 987654321 : 123456789;
    item.TotalBitrate = update ? 7654321 : 3456789;
    item.Width = update ? 7680 : 3840;
    item.Height = update ? 4320 : 2160;
    item.IsLocked = !update;
    item.IsInMixedFolder = true;
    item.IsVirtualItem = update;
    item.IsShortcut = true;
    item.ShortcutPath = Path.Combine(root, marker + "-shortcut");
    item.Container = update ? "mkv-update" : "mkv-create";
    item.PreferredMetadataLanguage = update ? "en-US" : "zh-TW";
    item.PreferredMetadataCountryCode = update ? "US" : "TW";
    item.PresentationUniqueKey = $"save-{marker}-presentation-{index}";
    item.Album = $"Save {marker} album";
    item.LUFS = update ? -8.25f : -12.5f;
    item.NormalizationGain = update ? 1.75f : 2.5f;
    item.Audio = update ? MediaBrowser.Model.LiveTv.ProgramAudio.DolbyDigital : MediaBrowser.Model.LiveTv.ProgramAudio.Atmos;
    item.ExtraType = update ? ExtraType.Interview : ExtraType.Featurette;
    item.ForcedSortName = $"{marker}-forced-sort";
    item.SortName = $"{marker}-sort";
    item.Genres = [$"{marker} genre one", $"{marker} genre two"];
    item.Studios = [$"{marker} studio"];
    item.Tags = [$"{marker} tag one", $"{marker} tag two"];
    item.ProductionLocations = [$"{marker} location"];
    item.ProviderIds.Clear();
    item.ProviderIds[$"Provider{phase}"] = $"provider-value-{marker}";
    item.ProviderIds["SharedProvider"] = $"shared-{marker}";
    item.LockedFields = update ? [MetadataField.Overview, MetadataField.Tags] : [MetadataField.Name, MetadataField.Genres];
    item.RemoteTrailers =
    [
        new MediaUrl
        {
            Url = $"https://save.invalid/{marker}/trailer?type={item.GetType().Name}",
            Name = update ? "更新 trailer > & \"two\"" : "首存 trailer <>& \"one\""
        }
    ];
    item.ImageInfos =
    [
        new ItemImageInfo
        {
            Path = Path.Combine(root, $"{marker}-primary.jpg"), Type = update ? ImageType.Logo : ImageType.Primary,
            DateModified = Utc(2026, update ? 9 : 8, 8, 9, 10, 11, index), Width = update ? 801 : 601,
            Height = update ? 451 : 351, BlurHash = $"{marker}-primary-blur"
        },
        new ItemImageInfo
        {
            Path = Path.Combine(root, $"{marker}-secondary.jpg"), Type = update ? ImageType.Thumb : ImageType.Backdrop,
            DateModified = Utc(2026, update ? 10 : 7, 9, 10, 11, 12, index), Width = update ? 802 : 602,
            Height = update ? 452 : 352, BlurHash = $"{marker}-secondary-blur"
        }
    ];

    if (item is Folder folder)
    {
        folder.IsRoot = !update;
        folder.DateLastMediaAdded = Utc(2026, update ? 12 : 11, 10, 11, 12, 13, index);
        folder.LinkedChildren = [new LinkedChild { ItemId = folderChild.Id, Type = update ? MediaBrowser.Controller.Entities.LinkedChildType.Shortcut : MediaBrowser.Controller.Entities.LinkedChildType.Manual }];
    }
    if (item is AggregateFolder aggregate) aggregate.PhysicalLocationsList = [Path.Combine(root, marker + "-aggregate")];
    if (item is CollectionFolder collection)
    {
        collection.CollectionType = update ? Jellyfin.Data.Enums.CollectionType.music : Jellyfin.Data.Enums.CollectionType.movies;
        collection.PhysicalLocationsList = [Path.Combine(root, marker + "-collection")];
        collection.PhysicalFolderIds = [parentRoot.Id, folderChild.Id];
    }
    if (item is UserView userView)
    {
        userView.ViewType = update ? Jellyfin.Data.Enums.CollectionType.tvshows : Jellyfin.Data.Enums.CollectionType.movies;
        userView.DisplayParentId = folderChild.Id;
        userView.UserId = SaveGuid(index, update ? 112 : 111);
    }
    if (item is PlaylistItem playlist)
    {
        playlist.OwnerUserId = SaveGuid(index, update ? 114 : 113);
        playlist.OpenAccess = !update;
        playlist.Shares = [new PlaylistUserPermissions(SaveGuid(index, update ? 116 : 115), !update)];
        playlist.PlaylistMediaType = update ? Jellyfin.Data.Enums.MediaType.Video : Jellyfin.Data.Enums.MediaType.Audio;
    }
    if (item is Video video)
    {
        var sensitivePart = item is Movie && !update ? "電影-part-<>&-\"one\".media" : $"{marker}-part.media";
        video.AdditionalParts = [Path.Combine(root, sensitivePart)];
        video.LocalAlternateVersions = [localAlternate.Path];
        video.LinkedAlternateVersions = [new LinkedChild { ItemId = linkedAlternate.Id, Type = MediaBrowser.Controller.Entities.LinkedChildType.LinkedAlternateVersion }];
        video.SubtitleFiles = [Path.Combine(root, $"{marker}.srt")];
        video.AudioFiles = [Path.Combine(root, $"{marker}.mka")];
        video.VideoType = update ? VideoType.VideoFile : VideoType.Iso;
        video.Timestamp = update ? MediaBrowser.Model.MediaInfo.TransportStreamTimestamp.Valid : MediaBrowser.Model.MediaInfo.TransportStreamTimestamp.Zero;
        video.DefaultVideoStreamIndex = update ? 8 : 6;
        video.IsoType = update ? MediaBrowser.Model.Entities.IsoType.BluRay : MediaBrowser.Model.Entities.IsoType.Dvd;
        video.Video3DFormat = update ? MediaBrowser.Model.Entities.Video3DFormat.MVC : MediaBrowser.Model.Entities.Video3DFormat.HalfSideBySide;
        video.AspectRatio = update ? "16:9" : "4:3";
        video.IsPlaceHolder = !update;
        video.HasSubtitles = true;
        video.PrimaryVersionId = linkedAlternate.Id;
    }
    if (item is Movie movie) movie.TmdbCollectionName = update ? "Updated Collection" : "Created Collection";
    if (item is Trailer trailer) trailer.TrailerTypes = update ? [TrailerType.ComingSoonToDvd] : [TrailerType.Archive, TrailerType.LocalTrailer];
    if (item is Series series)
    {
        series.AirDays = update ? [DayOfWeek.Tuesday, DayOfWeek.Thursday] : [DayOfWeek.Monday, DayOfWeek.Wednesday];
        series.AirTime = update ? "22:30" : "20:15";
        series.DisplayOrder = update ? "update-order" : "create-order";
        series.Status = update ? SeriesStatus.Ended : SeriesStatus.Continuing;
    }
    if (item is BoxSet boxSet)
    {
        boxSet.DisplayOrder = update ? "update-order" : "create-order";
        boxSet.LibraryFolderIds = [parentRoot.Id, folderChild.Id];
    }
    if (item is IHasSeries hasSeries)
    {
        hasSeries.SeriesId = seriesParent.Id;
        hasSeries.SeriesName = seriesParent.Name;
        hasSeries.SeriesPresentationUniqueKey = $"save-series-{marker}";
    }
    if (item is Episode episode)
    {
        episode.SeasonId = seasonParent.Id;
        episode.SeasonName = seasonParent.Name;
        episode.AirsBeforeSeasonNumber = update ? 20 : 10;
        episode.AirsAfterSeasonNumber = update ? 21 : 11;
        episode.AirsBeforeEpisodeNumber = update ? 22 : 12;
        episode.IndexNumberEnd = update ? 23 : 13;
    }
    if (item is IHasArtist hasArtist) hasArtist.Artists = [$"{marker} artist one", $"{marker} artist two"];
    if (item is IHasAlbumArtist hasAlbumArtist) hasAlbumArtist.AlbumArtists = [$"{marker} album artist"];
    if (item is AudioItem audio)
    {
        audio.HasLyrics = !update;
        audio.LyricFiles = [Path.Combine(root, $"{marker}.lrc")];
    }
    if (item is Photo photo)
    {
        photo.CameraMake = update ? "更新相機 > & \"two\"" : "首存相機 <>& \"one\"";
        photo.CameraModel = update ? "Model Two" : "Model One";
        photo.Software = update ? "Software Two" : "Software One";
        photo.ExposureTime = update ? 2.5 : 1.25;
        photo.FocalLength = update ? 85.5 : 55.5;
        photo.Orientation = update ? ImageOrientation.LeftBottom : ImageOrientation.RightTop;
        photo.Aperture = update ? 4.0 : 2.8;
        photo.ShutterSpeed = update ? 0.25 : 0.125;
        photo.Latitude = update ? 25.25 : 23.5;
        photo.Longitude = update ? 121.75 : 120.5;
        photo.Altitude = update ? 30.5 : 12.5;
        photo.IsoSpeedRating = update ? 800 : 640;
    }
}

static void ApplySaveClear(BaseItem item, int index)
{
    item.ParentId = Guid.Empty;
    item.OwnerId = Guid.Empty;
    item.ChannelId = Guid.Empty;
    item.Name = "Save cleared " + item.GetType().Name;
    item.Path = null;
    item.DateCreated = DateTime.MinValue;
    item.DateModified = DateTime.MinValue;
    item.DateLastSaved = DateTime.MinValue;
    item.DateLastRefreshed = DateTime.MinValue;
    item.PremiereDate = null;
    item.EndDate = null;
    item.CommunityRating = null;
    item.CriticRating = null;
    item.CustomRating = null;
    item.OfficialRating = null;
    item.Overview = null;
    item.OriginalTitle = null;
    item.OriginalLanguage = null;
    item.Tagline = null;
    item.HomePageUrl = null;
    item.ExternalId = null;
    item.ExternalSeriesId = null;
    item.IndexNumber = null;
    item.ParentIndexNumber = null;
    item.InheritedParentalRatingValue = null;
    item.InheritedParentalRatingSubValue = null;
    item.ProductionYear = null;
    item.RunTimeTicks = null;
    item.Size = null;
    item.TotalBitrate = null;
    item.Width = 0;
    item.Height = 0;
    item.IsLocked = false;
    item.IsInMixedFolder = false;
    item.IsVirtualItem = false;
    item.IsShortcut = false;
    item.ShortcutPath = null;
    item.Container = null;
    item.PreferredMetadataLanguage = null;
    item.PreferredMetadataCountryCode = null;
    item.PresentationUniqueKey = null;
    item.Album = null;
    item.LUFS = null;
    item.NormalizationGain = null;
    item.Audio = null;
    item.ExtraType = null;
    item.ForcedSortName = null;
    item.SortName = string.Empty;
    item.Genres = [];
    item.Studios = [];
    item.Tags = [];
    item.ProductionLocations = [];
    item.ProviderIds.Clear();
    item.LockedFields = [];
    item.RemoteTrailers = [];
    item.ImageInfos = [];
    if (item is Folder folder)
    {
        folder.IsRoot = false;
        folder.DateLastMediaAdded = null;
        folder.LinkedChildren = [];
    }
    if (item is AggregateFolder aggregate) aggregate.PhysicalLocationsList = [];
    if (item is CollectionFolder collection)
    {
        collection.CollectionType = null;
        collection.PhysicalLocationsList = [];
        collection.PhysicalFolderIds = [];
    }
    if (item is UserView userView)
    {
        userView.ViewType = null;
        userView.DisplayParentId = Guid.Empty;
        userView.UserId = null;
    }
    if (item is PlaylistItem playlist)
    {
        playlist.OwnerUserId = Guid.Empty;
        playlist.OpenAccess = false;
        playlist.Shares = [];
        playlist.PlaylistMediaType = Jellyfin.Data.Enums.MediaType.Unknown;
    }
    if (item is Video video)
    {
        video.AdditionalParts = [];
        video.LocalAlternateVersions = [];
        video.LinkedAlternateVersions = [];
        video.SubtitleFiles = [];
        video.AudioFiles = [];
        video.VideoType = VideoType.VideoFile;
        video.Timestamp = null;
        video.DefaultVideoStreamIndex = null;
        video.IsoType = null;
        video.Video3DFormat = null;
        video.AspectRatio = null;
        video.IsPlaceHolder = false;
        video.HasSubtitles = false;
        video.PrimaryVersionId = null;
    }
    if (item is Movie movie) movie.TmdbCollectionName = null;
    if (item is Trailer trailer) trailer.TrailerTypes = [];
    if (item is Series series)
    {
        series.AirDays = [];
        series.AirTime = null;
        series.DisplayOrder = null;
        series.Status = null;
    }
    if (item is BoxSet boxSet)
    {
        boxSet.DisplayOrder = null;
        boxSet.LibraryFolderIds = [];
    }
    if (item is IHasSeries hasSeries)
    {
        hasSeries.SeriesId = Guid.Empty;
        hasSeries.SeriesName = null;
        hasSeries.SeriesPresentationUniqueKey = null;
    }
    if (item is Episode episode)
    {
        episode.SeasonId = Guid.Empty;
        episode.SeasonName = null;
        episode.AirsBeforeSeasonNumber = null;
        episode.AirsAfterSeasonNumber = null;
        episode.AirsBeforeEpisodeNumber = null;
        episode.IndexNumberEnd = null;
    }
    if (item is IHasArtist hasArtist) hasArtist.Artists = [];
    if (item is IHasAlbumArtist hasAlbumArtist) hasAlbumArtist.AlbumArtists = [];
    if (item is AudioItem audio)
    {
        audio.HasLyrics = null;
        audio.LyricFiles = [];
    }
    if (item is Photo photo)
    {
        photo.CameraMake = null;
        photo.CameraModel = null;
        photo.Software = null;
        photo.ExposureTime = null;
        photo.FocalLength = null;
        photo.Orientation = null;
        photo.Aperture = null;
        photo.ShutterSpeed = null;
        photo.Latitude = null;
        photo.Longitude = null;
        photo.Altitude = null;
        photo.IsoSpeedRating = null;
    }
}

static object ProjectSaveItem(BaseItem item, string root) => new
{
    item = ProjectItem(item, root),
    mappedBase = new
    {
        item.SortName,
        item.ForcedSortName,
        item.PreferredMetadataLanguage,
        item.PreferredMetadataCountryCode,
        item.Album,
        item.LUFS,
        item.NormalizationGain,
        item.TotalBitrate,
        audio = item.Audio?.ToString(),
        extraType = item.ExtraType?.ToString(),
        item.HomePageUrl,
        item.ExternalId,
        item.ExternalSeriesId,
        item.InheritedParentalRatingValue,
        item.InheritedParentalRatingSubValue,
        item.IndexNumber,
        item.ParentIndexNumber,
        item.PresentationUniqueKey
    }
};

static object ProjectSaveSnapshot(SqlFactory factory, IServerApplicationHost appHost, Guid subjectId, SaveControls controls, string root)
{
    using var context = factory.CreateDbContext();
    var stored = context.BaseItems.AsNoTracking().AsSplitQuery()
        .Include(value => value.Provider)
        .Include(value => value.LockedFields)
        .Include(value => value.TrailerTypes)
        .Include(value => value.Images)
        .Include(value => value.LinkedChildEntities)
        .Include(value => value.UserData)
        .Single(value => value.Id == subjectId);
    var properties = ScalarProperties(context);
    if (properties.Length != 72)
    {
        throw new InvalidOperationException($"Expected 72 stored BaseItems columns, found {properties.Length}.");
    }

    var hydrationLogger = new CaptureLogger();
    var hydrated = BaseItemMapper.DeserializeBaseItem(stored, hydrationLogger, appHost, skipDeserialization: false)
        ?? throw new InvalidOperationException("A just-saved known exact full name hydrated as null.");
    var controlIds = controls.Items.Select(value => value.Id).ToArray();
    var controlRows = context.BaseItems.AsNoTracking().Where(value => controlIds.Contains(value.Id)).AsEnumerable()
        .Select(value => new
        {
            id = Id(value.Id),
            value.Type,
            value.Name,
            parentId = value.ParentId.HasValue ? Id(value.ParentId.Value) : null,
            ownerId = value.OwnerId.HasValue ? Id(value.OwnerId.Value) : null,
            primaryVersionId = value.PrimaryVersionId.HasValue ? Id(value.PrimaryVersionId.Value) : null,
            value.PresentationUniqueKey,
            path = ProjectPath(value.Path, root)
        })
        .OrderBy(value => value.id, StringComparer.Ordinal)
        .ToArray();
    var presentControlIds = controlRows.Select(value => value.id).ToHashSet(StringComparer.Ordinal);
    var missingControlIds = controlIds.Select(Id).Where(value => !presentControlIds.Contains(value)).Order(StringComparer.Ordinal).ToArray();

    return new
    {
        columnCount = properties.Length,
        columns = ProjectColumns(stored, properties, root),
        data = ProjectJsonText(stored.Data, root),
        relations = ProjectSaveRelations(context, subjectId, root),
        hydrated = ProjectSaveItem(hydrated, root),
        hydratedTypedJson = SerializeTyped(hydrated, root, requireSuccess: true),
        hydrationLogs = hydrationLogger.Events,
        controls = new { rows = controlRows, missingIds = missingControlIds }
    };
}

static object ProjectSaveRelations(JellyfinDbContext db, Guid itemId, string root)
{
    var providers = db.BaseItemProviders.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), value.ProviderId, value.ProviderValue })
        .OrderBy(value => value.ProviderId, StringComparer.Ordinal).ThenBy(value => value.ProviderValue, StringComparer.Ordinal).ToArray();
    var lockedFields = db.BaseItemMetadataFields.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), value.Id }).OrderBy(value => value.Id).ToArray();
    var trailerTypes = db.BaseItemTrailerTypes.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), value.Id }).OrderBy(value => value.Id).ToArray();
    var images = db.BaseItemImageInfos.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new
        {
            itemId = Id(value.ItemId),
            id = Id(value.Id),
            path = ProjectPath(value.Path, root),
            dateModified = NullableDate(value.DateModified),
            imageType = value.ImageType.ToString(),
            value.Width,
            value.Height,
            blurHash = value.Blurhash is null ? null : Encoding.UTF8.GetString(value.Blurhash)
        }).OrderBy(value => value.imageType, StringComparer.Ordinal).ThenBy(value => value.path, StringComparer.Ordinal).ThenBy(value => value.id, StringComparer.Ordinal).ToArray();
    var links = db.LinkedChildren.AsNoTracking().Where(value => value.ParentId == itemId || value.ChildId == itemId).AsEnumerable()
        .Select(value => new { parentId = Id(value.ParentId), childId = Id(value.ChildId), childType = value.ChildType.ToString(), value.SortOrder })
        .OrderBy(value => value.parentId, StringComparer.Ordinal).ThenBy(value => value.SortOrder).ThenBy(value => value.childId, StringComparer.Ordinal).ToArray();
    var userData = db.UserData.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new
        {
            itemId = Id(value.ItemId),
            userId = Id(value.UserId),
            value.CustomDataKey,
            value.Rating,
            value.PlaybackPositionTicks,
            value.PlayCount,
            value.IsFavorite,
            lastPlayedDate = NullableDate(value.LastPlayedDate),
            value.Played,
            value.AudioStreamIndex,
            value.SubtitleStreamIndex,
            value.Likes,
            retentionDate = NullableDate(value.RetentionDate)
        }).OrderBy(value => value.userId, StringComparer.Ordinal).ThenBy(value => value.CustomDataKey, StringComparer.Ordinal).ToArray();
    var ancestors = db.AncestorIds.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), parentItemId = Id(value.ParentItemId) })
        .OrderBy(value => value.parentItemId, StringComparer.Ordinal).ToArray();
    var valueEntities = db.ItemValues.AsNoTracking().AsEnumerable()
        .OrderBy(value => (int)value.Type).ThenBy(value => value.Value, StringComparer.Ordinal).ThenBy(value => value.CleanValue, StringComparer.Ordinal)
        .ThenBy(value => value.ItemValueId)
        .ToArray();
    var valueKeys = valueEntities.ToDictionary(value => value.ItemValueId,
        value => $"$VALUE/{(int)value.Type}/{value.Value}");
    var values = valueEntities.Select(value => new
    {
        id = Id(value.ItemValueId),
        semanticKey = valueKeys[value.ItemValueId],
        type = value.Type.ToString(),
        typeValue = (int)value.Type,
        value.Value,
        value.CleanValue
    }).ToArray();
    var maps = db.ItemValuesMap.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new
        {
            itemId = Id(value.ItemId),
            itemValueId = Id(value.ItemValueId),
            semanticKey = valueKeys.GetValueOrDefault(value.ItemValueId)
        })
        .OrderBy(value => value.semanticKey, StringComparer.Ordinal).ThenBy(value => value.itemValueId, StringComparer.Ordinal).ToArray();
    return new { providers, lockedFields, trailerTypes, images, links, userData, ancestors, values, maps };
}

static object ProjectJsonPropertyManifest(Type[] types)
{
    var nullability = new NullabilityInfoContext();
    var typeEntries = types.Select((type, typeIndex) =>
    {
        var typeInfo = JsonDefaults.Options.GetTypeInfo(type);
        var properties = typeInfo.Properties.Select((property, propertyIndex) =>
        {
            var member = property.AttributeProvider as MemberInfo;
            var clrProperty = member as PropertyInfo;
            var directIgnore = member?.GetCustomAttribute<JsonIgnoreAttribute>(inherit: false);
            var inheritedIgnore = directIgnore is null ? member?.GetCustomAttribute<JsonIgnoreAttribute>(inherit: true) : null;
            var excludedFromSerializableContract = property.Get is null && property.Set is null;
            object? nullable = null;
            string? nullabilityErrorType = null;
            string? nullabilityErrorMessage = null;
            if (clrProperty is not null)
            {
                try
                {
                    var info = nullability.Create(clrProperty);
                    nullable = new
                    {
                        readState = info.ReadState.ToString(),
                        writeState = info.WriteState.ToString(),
                        elementType = info.ElementType is null ? null : new
                        {
                            type = info.ElementType.Type.FullName ?? info.ElementType.Type.ToString(),
                            readState = info.ElementType.ReadState.ToString(),
                            writeState = info.ElementType.WriteState.ToString()
                        },
                        genericTypeArguments = info.GenericTypeArguments.Select(value => new
                        {
                            type = value.Type.FullName ?? value.Type.ToString(),
                            readState = value.ReadState.ToString(),
                            writeState = value.WriteState.ToString()
                        }).ToArray()
                    };
                }
                catch (Exception error)
                {
                    nullabilityErrorType = error.GetBaseException().GetType().FullName;
                    nullabilityErrorMessage = error.GetBaseException().Message;
                }
            }

            return new
            {
                index = propertyIndex,
                jsonName = property.Name,
                clrPropertyName = member?.Name,
                propertyType = property.PropertyType.FullName ?? property.PropertyType.ToString(),
                propertyAssemblyQualifiedType = property.PropertyType.AssemblyQualifiedName,
                declaringType = member?.DeclaringType?.FullName,
                attributeProviderType = member?.GetType().FullName,
                jsonHasGet = property.Get is not null,
                jsonHasSet = property.Set is not null,
                jsonHasShouldSerialize = property.ShouldSerialize is not null,
                clrCanRead = clrProperty?.CanRead,
                clrCanWrite = clrProperty?.CanWrite,
                clrGetterPublic = clrProperty?.GetMethod?.IsPublic,
                clrSetterPublic = clrProperty?.SetMethod?.IsPublic,
                getterOnly = property.Get is not null && property.Set is null,
                setterOnly = property.Get is null && property.Set is not null,
                excludedFromSerializableContract,
                directJsonIgnoreCondition = directIgnore?.Condition.ToString(),
                inheritedJsonIgnoreCondition = inheritedIgnore?.Condition.ToString(),
                property.Order,
                property.IsRequired,
                property.IsExtensionData,
                numberHandling = property.NumberHandling?.ToString(),
                objectCreationHandling = property.ObjectCreationHandling?.ToString(),
                customConverter = property.CustomConverter?.GetType().FullName,
                nullable,
                nullabilityErrorType,
                nullabilityErrorMessage
            };
        }).ToArray();

        return new
        {
            index = typeIndex,
            fullName = type.FullName,
            assemblyQualifiedName = type.AssemblyQualifiedName,
            typeInfoKind = typeInfo.Kind.ToString(),
            typeInfoPropertyCount = properties.Length,
            serializablePropertyCount = properties.Count(value => !value.excludedFromSerializableContract),
            ignoredOrMetadataOnlyPropertyCount = properties.Count(value => value.excludedFromSerializableContract),
            serializableProperties = properties.Where(value => !value.excludedFromSerializableContract).ToArray(),
            ignoredOrMetadataOnlyProperties = properties.Where(value => value.excludedFromSerializableContract).ToArray()
        };
    }).ToArray();

    return new
    {
        schemaVersion = 1,
        source = "JsonDefaults.Options.GetTypeInfo(type).Properties",
        options = new
        {
            JsonDefaults.Options.DefaultIgnoreCondition,
            JsonDefaults.Options.PropertyNameCaseInsensitive,
            propertyNamingPolicy = JsonDefaults.Options.PropertyNamingPolicy?.GetType().FullName,
            dictionaryKeyPolicy = JsonDefaults.Options.DictionaryKeyPolicy?.GetType().FullName,
            JsonDefaults.Options.NumberHandling,
            JsonDefaults.Options.UnmappedMemberHandling,
            JsonDefaults.Options.PreferredObjectCreationHandling,
            JsonDefaults.Options.IgnoreReadOnlyProperties,
            JsonDefaults.Options.IgnoreReadOnlyFields,
            JsonDefaults.Options.IncludeFields,
            encoder = JsonDefaults.Options.Encoder?.GetType().FullName,
            typeInfoResolver = JsonDefaults.Options.TypeInfoResolver?.GetType().FullName,
            converters = JsonDefaults.Options.Converters.Select(value => value.GetType().FullName).ToArray()
        },
        typeCount = typeEntries.Length,
        types = typeEntries
    };
}

static void ApplyJsonPoison(BaseItem item, int index, string root, Folder rootParent, Series seriesParent, Season seasonParent, Folder linkedChild)
{
    item.Id = Guid.Parse($"95200000-0000-0000-{index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000001");
    item.ParentId = rootParent.Id;
    item.Name = "JSON poison name";
    item.Path = Path.Combine(root, "json-poison", item.GetType().Name);
    item.DateCreated = Utc(2025, 1, 2, 3, 4, 5, index);
    item.DateModified = Utc(2025, 2, 3, 4, 5, 6, index);
    item.DateLastSaved = Utc(2025, 3, 4, 5, 6, 7, index);
    item.DateLastRefreshed = Utc(2025, 4, 5, 6, 7, 8, index);
    item.Genres = ["JSON poison genre"];
    item.Studios = ["JSON poison studio"];
    item.Tags = ["JSON poison tag"];
    item.ProductionLocations = ["JSON poison location"];
    item.ProviderIds["JsonPoison"] = "must-be-overlaid";
    item.LockedFields = [MetadataField.Overview];
    item.RemoteTrailers = [new MediaUrl { Url = "https://poison.invalid/json", Name = "JSON poison trailer" }];
    item.ImageInfos = [new ItemImageInfo
    {
        Path = Path.Combine(root, "json-poison.jpg"),
        Type = ImageType.Backdrop,
        DateModified = Utc(2025, 5, 6, 7, 8, 9, index),
        Width = 13,
        Height = 17,
        BlurHash = "json-poison-blur"
    }];
    item.ProductionYear = 1999;
    item.Size = 999;
    item.Container = "json-poison-container";
    item.IsShortcut = true;
    item.ShortcutPath = Path.Combine(root, "json-poison-shortcut");
    item.RunTimeTicks = 9999;
    item.Width = 111;
    item.Height = 222;
    item.IsLocked = false;
    item.PresentationUniqueKey = "json-poison-key";
    if (item is Folder folder)
    {
        folder.IsRoot = false;
        folder.DateLastMediaAdded = Utc(2025, 6, 7, 8, 9, 10, index);
        folder.LinkedChildren = [new LinkedChild { ItemId = linkedChild.Id, Type = MediaBrowser.Controller.Entities.LinkedChildType.Shortcut }];
    }

    if (item is AggregateFolder aggregate) aggregate.PhysicalLocationsList = [Path.Combine(root, "json-aggregate")];
    if (item is CollectionFolder collection)
    {
        collection.CollectionType = Jellyfin.Data.Enums.CollectionType.movies;
        collection.PhysicalLocationsList = [Path.Combine(root, "json-collection")];
        collection.PhysicalFolderIds = [rootParent.Id];
    }

    if (item is UserView userView)
    {
        userView.ViewType = Jellyfin.Data.Enums.CollectionType.tvshows;
        userView.DisplayParentId = linkedChild.Id;
        userView.UserId = Guid.Parse("95200000-0000-0000-0000-000000000010");
    }

    if (item is PlaylistItem playlist)
    {
        playlist.OwnerUserId = Guid.Parse("95200000-0000-0000-0000-000000000011");
        playlist.OpenAccess = true;
        playlist.Shares = [new PlaylistUserPermissions(Guid.Parse("95200000-0000-0000-0000-000000000012"), true)];
        playlist.PlaylistMediaType = Jellyfin.Data.Enums.MediaType.Audio;
    }

    if (item is Video video)
    {
        video.AdditionalParts = [Path.Combine(root, "json-part.media")];
        video.LocalAlternateVersions = [Path.Combine(root, "json-alternate.media")];
        video.LinkedAlternateVersions = [new LinkedChild { ItemId = linkedChild.Id, Type = MediaBrowser.Controller.Entities.LinkedChildType.LinkedAlternateVersion }];
        video.SubtitleFiles = [Path.Combine(root, "json.srt")];
        video.AudioFiles = [Path.Combine(root, "json.mka")];
        video.VideoType = VideoType.Iso;
        video.Timestamp = MediaBrowser.Model.MediaInfo.TransportStreamTimestamp.Zero;
        video.DefaultVideoStreamIndex = 4;
        video.IsoType = MediaBrowser.Model.Entities.IsoType.Dvd;
        video.Video3DFormat = MediaBrowser.Model.Entities.Video3DFormat.HalfSideBySide;
        video.AspectRatio = "4:3";
        video.IsPlaceHolder = true;
        video.HasSubtitles = true;
        video.PrimaryVersionId = linkedChild.Id;
    }

    if (item is Trailer trailer) trailer.TrailerTypes = [TrailerType.Archive];
    if (item is Movie movie) movie.TmdbCollectionName = "JSON poison collection";
    if (item is Series series)
    {
        series.AirDays = [DayOfWeek.Sunday];
        series.AirTime = "01:23";
        series.DisplayOrder = "JsonPoisonOrder";
        series.Status = SeriesStatus.Unreleased;
    }

    if (item is BoxSet boxSet)
    {
        boxSet.DisplayOrder = "JsonPoisonOrder";
        boxSet.LibraryFolderIds = [rootParent.Id];
    }

    if (item is Episode episode)
    {
        episode.AirsBeforeSeasonNumber = 90;
        episode.AirsAfterSeasonNumber = 91;
        episode.AirsBeforeEpisodeNumber = 92;
        episode.IndexNumberEnd = 93;
        episode.SeriesId = seriesParent.Id;
        episode.SeriesName = "JSON poison series";
        episode.SeriesPresentationUniqueKey = "json-poison-series-key";
        episode.SeasonId = seasonParent.Id;
        episode.SeasonName = "JSON poison season";
    }

    if (item is AudioItem audio)
    {
        audio.Artists = ["JSON poison artist"];
        audio.AlbumArtists = ["JSON poison album artist"];
        audio.LyricFiles = [Path.Combine(root, "json.lrc")];
        audio.HasLyrics = true;
    }

    if (item is MusicVideo musicVideo) musicVideo.Artists = ["JSON poison artist"];
    if (item is MusicAlbum musicAlbum)
    {
        musicAlbum.Artists = ["JSON poison artist"];
        musicAlbum.AlbumArtists = ["JSON poison album artist"];
    }

    if (item is Photo photo)
    {
        photo.CameraMake = "JSON camera make";
        photo.CameraModel = "JSON camera model";
        photo.Software = "JSON software";
        photo.ExposureTime = 1.25;
        photo.FocalLength = 55.5;
        photo.Orientation = ImageOrientation.RightTop;
        photo.Aperture = 2.8;
        photo.ShutterSpeed = 0.125;
        photo.Latitude = 23.5;
        photo.Longitude = 121.5;
        photo.Altitude = 12.5;
        photo.IsoSpeedRating = 640;
    }
}

static void ApplyDatabaseOverlay(BaseItem item, int index, string root, Guid id, Folder rootParent, Series seriesParent, Season seasonParent, Folder linkedChild)
{
    item.Id = id;
    item.ParentId = rootParent.Id;
    item.Name = "DB overlay " + item.GetType().Name;
    item.Path = Path.Combine(root, "db-overlay", item is Video or AudioItem or Photo or Book ? item.GetType().Name + ".media" : item.GetType().Name);
    item.DateCreated = Utc(2026, 1, 2, 3, 4, 5, index);
    item.DateModified = Utc(2026, 2, 3, 4, 5, 6, index);
    item.DateLastSaved = Utc(2026, 3, 4, 5, 6, 7, index);
    item.DateLastRefreshed = Utc(2026, 4, 5, 6, 7, 8, index);
    item.EndDate = Utc(2027, 1, 2, 3, 4, 5, index);
    item.PremiereDate = Utc(2024, 1, 2, 3, 4, 5, index);
    item.CommunityRating = 7.25f;
    item.CriticRating = 82.5f;
    item.CustomRating = "DB-CUSTOM";
    item.OfficialRating = "DB-PG";
    item.Overview = "DB overlay overview";
    item.OriginalTitle = "DB overlay original title";
    item.OriginalLanguage = "zho";
    item.Tagline = "DB overlay tagline";
    item.IndexNumber = 8;
    item.ParentIndexNumber = 4;
    item.ProductionYear = 2026;
    item.RunTimeTicks = 1234567890123;
    item.Size = 987654321;
    item.Container = "db-overlay-container";
    item.IsShortcut = true;
    item.ShortcutPath = Path.Combine(root, "db-overlay-shortcut");
    item.Width = 3840;
    item.Height = 2160;
    item.ChannelId = Guid.Parse($"95400000-0000-0000-{index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000001");
    item.IsLocked = true;
    item.IsInMixedFolder = true;
    item.IsVirtualItem = true;
    item.PreferredMetadataLanguage = "zh-TW";
    item.PreferredMetadataCountryCode = "TW";
    item.PresentationUniqueKey = "db-overlay-key";
    item.Genres = ["DB genre one", "DB genre two"];
    item.Studios = ["DB studio"];
    item.Tags = ["DB tag"];
    item.ProductionLocations = ["DB location"];
    item.ProviderIds["DbOverlay"] = "authoritative";
    item.LockedFields = [MetadataField.Name, MetadataField.Genres];
    item.RemoteTrailers = [new MediaUrl { Url = "https://db.invalid/trailer", Name = "DB trailer" }];
    item.ImageInfos = [new ItemImageInfo
    {
        Path = Path.Combine(root, "db-overlay-primary.jpg"),
        Type = ImageType.Primary,
        DateModified = Utc(2026, 5, 6, 7, 8, 9, index),
        Width = 640,
        Height = 360,
        BlurHash = "db-overlay-blur"
    }];
    if (item is Folder folder)
    {
        folder.IsRoot = true;
        folder.DateLastMediaAdded = Utc(2026, 6, 7, 8, 9, 10, index);
        folder.LinkedChildren = [new LinkedChild { ItemId = linkedChild.Id, Type = MediaBrowser.Controller.Entities.LinkedChildType.Shortcut }];
    }

    if (item is AggregateFolder aggregate) aggregate.PhysicalLocationsList = [Path.Combine(root, "db-aggregate")];
    if (item is CollectionFolder collection)
    {
        collection.CollectionType = Jellyfin.Data.Enums.CollectionType.music;
        collection.PhysicalLocationsList = [Path.Combine(root, "db-collection")];
        collection.PhysicalFolderIds = [rootParent.Id];
    }

    if (item is UserView userView)
    {
        userView.ViewType = Jellyfin.Data.Enums.CollectionType.movies;
        userView.DisplayParentId = linkedChild.Id;
        userView.UserId = Guid.Parse("95300000-0000-0000-0000-000000000010");
    }

    if (item is PlaylistItem playlist)
    {
        playlist.OwnerUserId = Guid.Parse("95300000-0000-0000-0000-000000000011");
        playlist.OpenAccess = false;
        playlist.Shares = [new PlaylistUserPermissions(Guid.Parse("95300000-0000-0000-0000-000000000012"), false)];
        playlist.PlaylistMediaType = Jellyfin.Data.Enums.MediaType.Video;
    }

    if (item is Video video)
    {
        video.AdditionalParts = [Path.Combine(root, "db-part.media")];
        video.LocalAlternateVersions = [Path.Combine(root, "db-alternate.media")];
        video.LinkedAlternateVersions = [new LinkedChild { ItemId = linkedChild.Id, Type = MediaBrowser.Controller.Entities.LinkedChildType.LinkedAlternateVersion }];
        video.SubtitleFiles = [Path.Combine(root, "db.srt")];
        video.AudioFiles = [Path.Combine(root, "db.mka")];
        video.VideoType = VideoType.VideoFile;
        video.Timestamp = MediaBrowser.Model.MediaInfo.TransportStreamTimestamp.Valid;
        video.DefaultVideoStreamIndex = 7;
        video.IsoType = MediaBrowser.Model.Entities.IsoType.BluRay;
        video.Video3DFormat = MediaBrowser.Model.Entities.Video3DFormat.MVC;
        video.AspectRatio = "16:9";
        video.IsPlaceHolder = false;
        video.HasSubtitles = true;
        video.PrimaryVersionId = linkedChild.Id;
    }

    if (item is Trailer trailer) trailer.TrailerTypes = [TrailerType.LocalTrailer, TrailerType.Archive];
    if (item is Movie movie) movie.TmdbCollectionName = "DB overlay collection";
    if (item is Series series)
    {
        series.AirDays = [DayOfWeek.Monday, DayOfWeek.Wednesday];
        series.AirTime = "20:15";
        series.DisplayOrder = "DbOverlayOrder";
        series.Status = SeriesStatus.Ended;
    }

    if (item is BoxSet boxSet)
    {
        boxSet.DisplayOrder = "DbOverlayOrder";
        boxSet.LibraryFolderIds = [rootParent.Id, linkedChild.Id];
    }

    if (item is Season season)
    {
        season.SeriesId = seriesParent.Id;
        season.SeriesName = seriesParent.Name;
        season.SeriesPresentationUniqueKey = "db-series-key";
    }

    if (item is Episode episode)
    {
        episode.AirsBeforeSeasonNumber = 10;
        episode.AirsAfterSeasonNumber = 11;
        episode.AirsBeforeEpisodeNumber = 12;
        episode.IndexNumberEnd = 13;
        episode.SeriesId = seriesParent.Id;
        episode.SeriesName = seriesParent.Name;
        episode.SeriesPresentationUniqueKey = "db-series-key";
        episode.SeasonId = seasonParent.Id;
        episode.SeasonName = seasonParent.Name;
    }

    if (item is AudioBook audioBook)
    {
        audioBook.SeriesId = seriesParent.Id;
        audioBook.SeriesName = seriesParent.Name;
        audioBook.SeriesPresentationUniqueKey = "db-series-key";
    }

    if (item is Book book)
    {
        book.SeriesId = seriesParent.Id;
        book.SeriesName = seriesParent.Name;
        book.SeriesPresentationUniqueKey = "db-series-key";
    }

    if (item is AudioItem audio)
    {
        audio.Artists = ["DB artist"];
        audio.AlbumArtists = ["DB album artist"];
        audio.Album = "DB album";
        audio.LyricFiles = [Path.Combine(root, "db.lrc")];
        audio.HasLyrics = false;
    }

    if (item is MusicVideo musicVideo) musicVideo.Artists = ["DB music video artist"];
    if (item is MusicAlbum musicAlbum)
    {
        musicAlbum.Artists = ["DB album artist member"];
        musicAlbum.AlbumArtists = ["DB primary album artist"];
    }

    if (item is Photo photo)
    {
        photo.CameraMake = "DB camera make";
        photo.CameraModel = "DB camera model";
        photo.Software = "DB software";
        photo.ExposureTime = 2.5;
        photo.FocalLength = 35.0;
        photo.Orientation = ImageOrientation.LeftBottom;
        photo.Aperture = 4.0;
        photo.ShutterSpeed = 0.25;
        photo.Latitude = 25.0;
        photo.Longitude = 121.0;
        photo.Altitude = 30.0;
        photo.IsoSpeedRating = 800;
    }
}

#pragma warning disable CS0618 // LinkedChild legacy fields are deliberately projected as native compatibility evidence.
static object ProjectItem(BaseItem item, string root)
{
    var folder = item as Folder;
    var video = item as Video;
    var audio = item as AudioItem;
    var series = item as Series;
    var movie = item as Movie;
    var trailer = item as Trailer;
    var hasSeries = item as IHasSeries;
    var episode = item as Episode;
    var collection = item as IHasCollectionType;
    var aggregate = item as AggregateFolder;
    var collectionFolder = item as CollectionFolder;
    var userView = item as UserView;
    var playlist = item as PlaylistItem;
    var boxSet = item as BoxSet;
    var photo = item as Photo;
    var musicArtist = item as MusicArtist;
    return new
    {
        type = item.GetType().FullName,
        id = Id(item.Id),
        parentId = Id(item.ParentId),
        ownerId = Id(item.OwnerId),
        channelId = Id(item.ChannelId),
        displayParentId = Id(item.DisplayParentId),
        item.Name,
        path = ProjectPath(item.Path, root),
        item.IsFolder,
        item.IsHidden,
        item.IsDisplayedAsFolder,
        mediaType = item.MediaType.ToString(),
        sourceType = item.SourceType.ToString(),
        item.IsHD,
        unratedType = item.GetBlockUnratedType().ToString(),
        collectionType = collection?.CollectionType?.ToString(),
        item.Container,
        item.IsShortcut,
        shortcutPath = ProjectPath(item.ShortcutPath, root),
        item.IsInMixedFolder,
        item.IsLocked,
        item.IsVirtualItem,
        item.ProductionYear,
        item.Size,
        item.RunTimeTicks,
        item.Width,
        item.Height,
        item.CommunityRating,
        item.CriticRating,
        item.Overview,
        item.OfficialRating,
        item.CustomRating,
        item.OriginalTitle,
        item.OriginalLanguage,
        item.Tagline,
        dates = new
        {
            created = Date(item.DateCreated),
            modified = Date(item.DateModified),
            saved = Date(item.DateLastSaved),
            refreshed = NullableDate(item.DateLastRefreshed),
            premiere = NullableDate(item.PremiereDate),
            end = NullableDate(item.EndDate)
        },
        lists = new
        {
            Genres = item.Genres?.ToArray(),
            Studios = item.Studios?.ToArray(),
            Tags = item.Tags?.ToArray(),
            ProductionLocations = item.ProductionLocations?.ToArray(),
            artists = item is IHasArtist hasArtist ? hasArtist.Artists?.ToArray() : null,
            albumArtists = item is IHasAlbumArtist hasAlbumArtist ? hasAlbumArtist.AlbumArtists?.ToArray() : null,
            remoteTrailers = item.RemoteTrailers?.Select(value => value is null ? null : new { value.Url, value.Name }).ToArray()
        },
        providerIds = item.ProviderIds?.OrderBy(value => value.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(value => value.Key, value => value.Value, StringComparer.OrdinalIgnoreCase),
        lockedFields = item.LockedFields?.Select(value => value.ToString()).ToArray(),
        images = item.ImageInfos?.Select(value => new
        {
            path = ProjectPath(value.Path, root),
            type = value.Type.ToString(),
            dateModified = Date(value.DateModified),
            value.Width,
            value.Height,
            value.BlurHash
        }).ToArray(),
        userData = item.UserData?.Select(value => new
        {
            itemId = Id(value.ItemId),
            userId = Id(value.UserId),
            value.CustomDataKey,
            value.Rating,
            value.PlaybackPositionTicks,
            value.PlayCount,
            value.IsFavorite,
            lastPlayedDate = NullableDate(value.LastPlayedDate),
            value.Played,
            value.AudioStreamIndex,
            value.SubtitleStreamIndex,
            value.Likes,
            retentionDate = NullableDate(value.RetentionDate)
        }).ToArray(),
        folder = folder is null ? null : new
        {
            folder.IsRoot,
            dateLastMediaAdded = NullableDate(folder.DateLastMediaAdded),
            folder.LinkedChildrenLoaded,
            linkedChildren = folder.LinkedChildren?.Select(value => new
            {
                itemId = value.ItemId.HasValue ? Id(value.ItemId.Value) : null,
                path = ProjectPath(value.Path, root),
                type = value.Type.ToString(),
                libraryItemId = value.LibraryItemId
            }).ToArray()
        },
        aggregateFolder = aggregate is null ? null : new
        {
            physicalLocationsList = aggregate.PhysicalLocationsList?.Select(value => ProjectPath(value, root)).ToArray(),
            virtualChildCount = aggregate.VirtualChildren.Count
        },
        collectionFolder = collectionFolder is null ? null : new
        {
            physicalLocationsList = collectionFolder.PhysicalLocationsList?.Select(value => ProjectPath(value, root)).ToArray(),
            physicalFolderIds = collectionFolder.PhysicalFolderIds?.Select(Id).ToArray(),
            collectionType = collectionFolder.CollectionType?.ToString()
        },
        userView = userView is null ? null : new
        {
            viewType = userView.ViewType?.ToString(),
            displayParentId = Id(userView.DisplayParentId),
            userId = userView.UserId.HasValue ? Id(userView.UserId.Value) : null
        },
        playlist = playlist is null ? null : new
        {
            ownerUserId = Id(playlist.OwnerUserId),
            playlist.OpenAccess,
            playlistMediaType = playlist.PlaylistMediaType.ToString(),
            shares = playlist.Shares?.Select(value => new { userId = Id(value.UserId), value.CanEdit }).ToArray()
        },
        boxSet = boxSet is null ? null : new
        {
            boxSet.DisplayOrder,
            libraryFolderIds = boxSet.LibraryFolderIds?.Select(Id).ToArray()
        },
        video = video is null ? null : new
        {
            primaryVersionId = video.PrimaryVersionId.HasValue ? Id(video.PrimaryVersionId.Value) : null,
            additionalParts = video.AdditionalParts?.Select(value => ProjectPath(value, root)).ToArray(),
            localAlternateVersions = video.LocalAlternateVersions?.Select(value => ProjectPath(value, root)).ToArray(),
            linkedAlternateVersions = video.LinkedAlternateVersions?.Select(value => new
            {
                itemId = value.ItemId.HasValue ? Id(value.ItemId.Value) : null,
                path = ProjectPath(value.Path, root),
                type = value.Type.ToString(),
                libraryItemId = value.LibraryItemId
            }).ToArray(),
            subtitleFiles = video.SubtitleFiles?.Select(value => ProjectPath(value, root)).ToArray(),
            audioFiles = video.AudioFiles?.Select(value => ProjectPath(value, root)).ToArray(),
            videoType = video.VideoType.ToString(),
            timestamp = video.Timestamp?.ToString(),
            video.DefaultVideoStreamIndex,
            isoType = video.IsoType?.ToString(),
            video3DFormat = video.Video3DFormat?.ToString(),
            video.AspectRatio,
            video.IsPlaceHolder,
            video.HasSubtitles
        },
        movie = movie is null ? null : new { movie.TmdbCollectionName },
        trailerTypes = trailer?.TrailerTypes?.Select(value => value.ToString()).ToArray(),
        series = series is null ? null : new
        {
            airDays = series.AirDays?.Select(value => value.ToString()).ToArray(),
            series.AirTime,
            series.DisplayOrder,
            status = series.Status?.ToString()
        },
        seriesLink = hasSeries is null ? null : new
        {
            seriesId = Id(hasSeries.SeriesId),
            hasSeries.SeriesName,
            hasSeries.SeriesPresentationUniqueKey,
            seasonId = episode is null ? null : Id(episode.SeasonId),
            seasonName = episode?.SeasonName,
            episode = episode is null ? null : new
            {
                episode.AirsBeforeSeasonNumber,
                episode.AirsAfterSeasonNumber,
                episode.AirsBeforeEpisodeNumber,
                episode.IndexNumberEnd,
                episode.AiredSeasonNumber
            }
        },
        audio = audio is null ? null : new
        {
            audio.Album,
            audio.HasLyrics,
            lyricFiles = audio.LyricFiles?.Select(value => ProjectPath(value, root)).ToArray()
        },
        photo = photo is null ? null : new
        {
            photo.CameraMake,
            photo.CameraModel,
            photo.Software,
            photo.ExposureTime,
            photo.FocalLength,
            orientation = photo.Orientation?.ToString(),
            photo.Aperture,
            photo.ShutterSpeed,
            photo.Latitude,
            photo.Longitude,
            photo.Altitude,
            photo.IsoSpeedRating
        },
        musicArtist = musicArtist is null ? null : new { musicArtist.IsAccessedByName, musicArtist.IsFolder }
    };
}
#pragma warning restore CS0618

static object SerializeTyped(BaseItem item, string root, bool requireSuccess = false)
{
    try
    {
        var text = JsonSerializer.Serialize(item, item.GetType(), JsonDefaults.Options);
        return new { success = true, text = NormalizeText(text, root), parsed = ProjectNode(JsonNode.Parse(text), root), errorType = (string?)null, errorMessage = (string?)null };
    }
    catch (Exception error)
    {
        if (requireSuccess) throw;
        return new { success = false, text = (string?)null, parsed = (JsonNode?)null, errorType = error.GetType().FullName, errorMessage = error.Message };
    }
}

static object ProjectComputedTraits(string fullName, int index)
{
    var fresh = Create(fullName);
    var heightItem = Create(fullName);
    var channelItem = Create(fullName);
    var constructor = Snapshot(fresh);

    heightItem.Height = 719;
    var height719 = Snapshot(heightItem);
    heightItem.Height = 720;
    var height720 = Snapshot(heightItem);

    channelItem.ChannelId = Guid.Empty;
    var emptyChannel = Snapshot(channelItem);
    channelItem.ChannelId = Guid.Parse($"95500000-0000-0000-{index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)}-000000000001");
    var nonemptyChannel = Snapshot(channelItem);

    return new { constructor, height719, height720, emptyChannel, nonemptyChannel };

    static object Snapshot(BaseItem value) => new
    {
        value.Height,
        value.IsHD,
        channelId = Id(value.ChannelId),
        sourceType = value.SourceType.ToString(),
        mediaType = value.MediaType.ToString(),
        unratedType = value.GetBlockUnratedType().ToString(),
        value.IsFolder,
        value.IsHidden,
        value.IsDisplayedAsFolder
    };
}

static object ProjectJsonText(string? text, string root)
{
    if (text is null) return new { isNull = true, text = (string?)null, parsed = (JsonNode?)null, parseErrorType = (string?)null, parseErrorMessage = (string?)null };
    try
    {
        return new { isNull = false, text = NormalizeText(text, root), parsed = ProjectNode(JsonNode.Parse(text), root), parseErrorType = (string?)null, parseErrorMessage = (string?)null };
    }
    catch (Exception error)
    {
        return new { isNull = false, text = NormalizeText(text, root), parsed = (JsonNode?)null, parseErrorType = error.GetType().FullName, parseErrorMessage = error.Message };
    }
}

static JsonNode? ProjectNode(JsonNode? node, string root)
{
    var copy = node?.DeepClone();
    Rewrite(copy);
    return copy;

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

static object ProjectMutableIsolation(BaseItem first, BaseItem second)
{
    var names = new[]
    {
        "Genres", "Studios", "Tags", "ProductionLocations", "ProviderIds", "LockedFields", "ImageInfos", "RemoteTrailers", "UserData",
        "LinkedChildren", "PhysicalLocationsList", "PhysicalFolderIds", "Shares", "LibraryFolderIds", "AdditionalParts", "LocalAlternateVersions",
        "LinkedAlternateVersions", "SubtitleFiles", "AudioFiles", "TrailerTypes", "AirDays", "Artists", "AlbumArtists", "LyricFiles"
    };
    var facts = new SortedDictionary<string, object?>(StringComparer.Ordinal);
    foreach (var name in names)
    {
        var property = first.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
        if (property?.GetMethod is null || property.GetIndexParameters().Length != 0) continue;
        try
        {
            var left = property.GetValue(first);
            var right = property.GetValue(second);
            facts[name] = new
            {
                leftNull = left is null,
                rightNull = right is null,
                sameReference = left is not null && ReferenceEquals(left, right),
                leftCount = CollectionCount(left),
                rightCount = CollectionCount(right),
                errorType = (string?)null,
                errorMessage = (string?)null
            };
        }
        catch (Exception error)
        {
            facts[name] = new
            {
                leftNull = false,
                rightNull = false,
                sameReference = false,
                leftCount = (int?)null,
                rightCount = (int?)null,
                errorType = error.GetBaseException().GetType().FullName,
                errorMessage = error.GetBaseException().Message
            };
        }
    }

    return facts;
}

static int? CollectionCount(object? value)
{
    if (value is null) return null;
    if (value is ICollection collection) return collection.Count;
    var count = value.GetType().GetProperty("Count", BindingFlags.Instance | BindingFlags.Public);
    return count?.PropertyType == typeof(int) ? (int?)count.GetValue(value) : null;
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
        if (property.Name == "Data") return ProjectJsonText((string)value, root);
        if (value is Guid identifier) return Id(identifier);
        if (value is DateTime timestamp) return Date(timestamp);
        if (value is string text) return ProjectPath(text, root);
        return value;
    });

static object ProjectRelations(JellyfinDbContext db, Guid itemId, string root)
{
    var providers = db.BaseItemProviders.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), value.ProviderId, value.ProviderValue })
        .OrderBy(value => value.ProviderId, StringComparer.Ordinal).ToArray();
    var lockedFields = db.BaseItemMetadataFields.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), value.Id }).OrderBy(value => value.Id).ToArray();
    var trailerTypes = db.BaseItemTrailerTypes.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), value.Id }).OrderBy(value => value.Id).ToArray();
    var images = db.BaseItemImageInfos.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new
        {
            itemId = Id(value.ItemId),
            id = Id(value.Id),
            path = ProjectPath(value.Path, root),
            dateModified = NullableDate(value.DateModified),
            imageType = value.ImageType.ToString(),
            value.Width,
            value.Height,
            blurHash = value.Blurhash is null ? null : Encoding.UTF8.GetString(value.Blurhash)
        }).OrderBy(value => value.imageType, StringComparer.Ordinal).ToArray();
    var links = db.LinkedChildren.AsNoTracking().Where(value => value.ParentId == itemId || value.ChildId == itemId).AsEnumerable()
        .Select(value => new { parentId = Id(value.ParentId), childId = Id(value.ChildId), childType = value.ChildType.ToString(), value.SortOrder })
        .OrderBy(value => value.parentId, StringComparer.Ordinal).ThenBy(value => value.SortOrder).ToArray();
    var userData = db.UserData.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new
        {
            itemId = Id(value.ItemId),
            userId = Id(value.UserId),
            value.CustomDataKey,
            value.Rating,
            value.PlaybackPositionTicks,
            value.PlayCount,
            value.IsFavorite,
            lastPlayedDate = NullableDate(value.LastPlayedDate),
            value.Played,
            value.AudioStreamIndex,
            value.SubtitleStreamIndex,
            value.Likes,
            retentionDate = NullableDate(value.RetentionDate)
        }).OrderBy(value => value.userId, StringComparer.Ordinal).ToArray();
    var ancestors = db.AncestorIds.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), parentItemId = Id(value.ParentItemId) })
        .OrderBy(value => value.parentItemId, StringComparer.Ordinal).ToArray();
    var values = db.ItemValues.AsNoTracking().AsEnumerable().OrderBy(value => value.ItemValueId)
        .Select(value => new { id = Id(value.ItemValueId), type = value.Type.ToString(), value.Value, value.CleanValue }).ToArray();
    var maps = db.ItemValuesMap.AsNoTracking().Where(value => value.ItemId == itemId).AsEnumerable()
        .Select(value => new { itemId = Id(value.ItemId), itemValueId = Id(value.ItemValueId) })
        .OrderBy(value => value.itemValueId, StringComparer.Ordinal).ToArray();
    return new { providers, lockedFields, trailerTypes, images, links, userData, ancestors, values, maps };
}

static string? NormalizeText(string? value, string root) => value?.Replace(root.Replace("\\", "\\\\", StringComparison.Ordinal), "$STATE", StringComparison.Ordinal)
    .Replace(root, "$STATE", StringComparison.Ordinal);
static string? ProjectPath(string? value, string root) => value?.Replace(root, "$STATE", StringComparison.Ordinal);
static string Id(Guid value) => value.ToString("D").ToLowerInvariant();
static string Date(DateTime value) => value.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture);
static string? NullableDate(DateTime? value) => value.HasValue ? Date(value.Value) : null;
static DateTime Utc(int year, int month, int day, int hour, int minute, int second, int ticks) =>
    new DateTime(year, month, day, hour, minute, second, DateTimeKind.Utc).AddTicks(ticks);

public sealed record TypeDefinition(int Index, string Name, string FullName, bool RequiresJson);
public sealed record BoundaryDefinition(string Name, string FullName, string Mode, string? Data, string? StoredType);
public sealed record CaseOptions(bool ForceNullData = false, bool ExplicitSkip = false, bool ConfiguredSkip = false, string? StoredTypeOverride = null);
public sealed record SaveControls(
    Folder RootA,
    Folder RootB,
    Series SeriesA,
    Series SeriesB,
    Season SeasonA,
    Season SeasonB,
    MusicArtist ArtistA,
    MusicArtist ArtistB,
    MusicAlbum AlbumA,
    MusicAlbum AlbumB,
    Folder FolderChildA,
    Folder FolderChildB,
    Video LocalA,
    Video LocalB,
    Video LinkedA,
    Video LinkedB,
    IReadOnlyList<BaseItem> Items,
    Dictionary<Guid, BaseItem> Lookup);

public sealed class CaptureLogger : ILogger, ILogger<BaseItemRepository>, ILogger<ItemPersistenceService>
{
    public List<object> Events { get; } = [];
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        Events.Add(new
        {
            level = logLevel.ToString(),
            eventId = eventId.Id,
            eventName = eventId.Name,
            message = formatter(state, exception),
            exceptionType = exception?.GetType().FullName,
            exceptionMessage = exception?.Message
        });
    }
}

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
