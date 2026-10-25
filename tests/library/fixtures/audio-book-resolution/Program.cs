// Frozen AudioBookNameParser, AudioResolver, AudioBookListResolver and ResolverHelper oracle.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Naming.AudioBook;
using Emby.Naming.Common;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Resolvers;
using Emby.Server.Implementations.Library.Resolvers.Audio;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging.Abstractions;

var inputText = File.ReadAllText(args[0]);
var input = JsonDocument.Parse(inputText).RootElement;
var outputPath = Path.GetFullPath(args[1]);
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
var json = new JsonSerializerOptions { WriteIndented = true };
var naming = new NamingOptions();

var names = input.GetProperty("names").EnumerateArray().Select(value =>
{
    var source = value.GetString()!;
    var parsed = new AudioBookNameParser(naming).Parse(source);
    return new { source, parsed.Name, parsed.Year };
}).ToArray();

var results = new List<object>();
foreach (var sample in input.GetProperty("resolvers").EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(stateRoot, name);
    var media = Path.Combine(root, Native(sample.GetProperty("parentName").GetString()!));
    Directory.CreateDirectory(media);
    var entryDefinitions = sample.GetProperty("entries").EnumerateArray().ToArray();
    foreach (var entry in entryDefinitions)
    {
        var filename = Path.Combine(media, Native(entry.GetProperty("path").GetString()!));
        if (entry.GetProperty("kind").GetString() == "directory")
        {
            Directory.CreateDirectory(filename);
        }
        else
        {
            Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
            File.WriteAllText(filename, "native audiobook control", Encoding.UTF8);
        }
    }

    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch
    {
        "get_RootFolderPath" => Path.Combine(root, "root"),
        "get_ProgramDataPath" => root,
        "get_InternalMetadataPath" => Path.Combine(root, "metadata"),
        "get_DataPath" => Path.Combine(root, "data"),
        _ => Stub.Default(method.ReturnType)
    });
    var configuration = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch
    {
        "get_Configuration" => new ServerConfiguration(),
        "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration { UseFileCreationTimeForDateAdded = true },
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = configuration;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(configuration, NullLogger<LocalizationManager>.Instance);
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    BaseItem.FileSystem = fileSystem;
    var directoryService = new DirectoryService(fileSystem);
    var aggregate = new AggregateFolder
    {
        Id = Guid.Parse("96000000-0000-0000-0000-000000000001"),
        Name = "Aggregate",
        Path = Path.Combine(root, "aggregate")
    };
    var physicalRoot = new Folder
    {
        Id = Guid.Parse("96000000-0000-0000-0000-000000000002"),
        ParentId = aggregate.Id,
        Name = "Physical root",
        Path = Path.Combine(root, "physical")
    };
    var parent = new Folder
    {
        Id = Guid.Parse("96000000-0000-0000-0000-000000000003"),
        ParentId = sample.GetProperty("parentTop").GetBoolean() ? aggregate.Id : physicalRoot.Id,
        Name = Path.GetFileName(media),
        Path = media
    };
    var items = new Dictionary<Guid, BaseItem>
    {
        [aggregate.Id] = aggregate,
        [physicalRoot.Id] = physicalRoot,
        [parent.Id] = parent
    };
    var libraryOptions = new LibraryOptions();
    var manager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetLibraryOptions" => libraryOptions,
        "GetNewItemId" => Guid.Parse("96000000-0000-0000-0000-000000000004"),
        "GetItemById" => values is not null && values.Length > 0 && values[0] is Guid id && items.TryGetValue(id, out var item)
            ? item : null,
        "GetCollectionFolders" => new List<Folder>(),
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.LibraryManager = manager;
    var resolver = new AudioResolver(naming);
    var collectionType = Enum.Parse<CollectionType>(sample.GetProperty("collectionType").GetString()!);
    var entries = entryDefinitions.Select(entry => fileSystem.GetFileSystemInfo(
        Path.Combine(media, Native(entry.GetProperty("path").GetString()!)))
        ?? throw new InvalidOperationException("Fixture entry is unavailable.")).ToList();
    var mode = sample.GetProperty("mode").GetString()!;
    object? projected;
    if (mode == "multiple")
    {
        var resolved = ((IMultiItemResolver)resolver).ResolveMultiple(parent, entries, collectionType, directoryService);
        foreach (var item in resolved.Items)
            ResolverHelper.SetInitialItemValues(item, parent, manager, directoryService);
        projected = new
        {
            items = resolved.Items.Select(Project).ToArray(),
            extraFiles = resolved.ExtraFiles.Select(value => ProjectPath(value.FullName)).ToArray()
        };
    }
    else
    {
        var target = Path.Combine(media, Native(sample.GetProperty("target").GetString()!));
        var info = fileSystem.GetFileSystemInfo(target)
            ?? throw new InvalidOperationException("The target does not exist: " + target);
        var resolve = new ItemResolveArgs(paths, manager)
        {
            Parent = parent,
            FileInfo = info,
            FileSystemChildren = info.IsDirectory
                ? entries.Where(value => string.Equals(Path.GetDirectoryName(value.FullName), target,
                    StringComparison.OrdinalIgnoreCase)).ToArray()
                : [],
            CollectionType = collectionType,
            LibraryOptions = libraryOptions
        };
        var item = resolver.ResolvePath(resolve);
        if (item is not null) ResolverHelper.SetInitialItemValues(item, resolve, fileSystem, manager);
        projected = Project(item);
    }
    results.Add(new
    {
        name,
        mode,
        collectionType = sample.GetProperty("collectionType").GetString(),
        parentTop = sample.GetProperty("parentTop").GetBoolean(),
        priority = (int)resolver.Priority,
        resolved = projected
    });

    string Native(string value) => value.Replace('/', Path.DirectorySeparatorChar);
    string? ProjectPath(string? value) => value?.Replace(media, "$MEDIA", StringComparison.Ordinal).Replace('\\', '/');
    object? Project(BaseItem? item) => item is null ? null : new
    {
        type = item.GetType().FullName,
        item.Name,
        path = ProjectPath(item.Path),
        parentId = item.ParentId.ToString("D").ToLowerInvariant(),
        item.IsFolder,
        mediaType = item.MediaType.ToString(),
        item.IsInMixedFolder,
        item.ProductionYear,
        item.IsShortcut,
        artists = item is MediaBrowser.Controller.Entities.Audio.Audio audio ? audio.Artists : null,
        albumArtists = item is MediaBrowser.Controller.Entities.Audio.Audio albumAudio ? albumAudio.AlbumArtists : null
    };
}

var assemblies = new[]
{
    typeof(BaseItem).Assembly,
    typeof(AudioResolver).Assembly,
    typeof(AudioBookNameParser).Assembly
}.Distinct().Select(assembly => new
{
    name = assembly.GetName().Name,
    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
}).ToArray();
var output = new
{
    actualFrozenAudioBookResolution = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    names,
    results,
    assemblies,
    scope = "Actual frozen AudioBookNameParser, AudioResolver, AudioBookListResolver, ResolverHelper, ManagedFileSystem and DirectoryService over real files. Covers resolver priority, books collection gating, multi versus single dispatch, top-parent mixed state, supported/cue/stream/video-overlap extensions, year parsing, single-file directory collapse, multiple-audio rejection and explicit multi extras. LibraryManager IDs, parent lookup and file timestamps are controls. No Folder.ValidateChildren, CreateItems, recursive scan, database persistence, metadata providers, playlist parsing, faults, concurrency, HTTP, migration or release acceptance."
};
File.WriteAllText(outputPath, JsonSerializer.Serialize(output, json) + "\n");

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
