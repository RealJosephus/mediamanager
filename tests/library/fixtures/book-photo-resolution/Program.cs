// Frozen BookFileNameParser, BookResolver, PhotoResolver, PhotoAlbumResolver and ResolverHelper oracle.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Naming.Book;
using Emby.Naming.Common;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Library.Resolvers;
using Emby.Server.Implementations.Library.Resolvers.Books;
using Emby.Server.Implementations.Localization;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

var inputText = File.ReadAllText(args[0]);
var input = JsonDocument.Parse(inputText).RootElement;
var outputPath = Path.GetFullPath(args[1]);
var stateRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(stateRoot);
var json = new JsonSerializerOptions { WriteIndented = true };

var parser = input.GetProperty("parser").EnumerateArray().Select(value =>
{
    var source = value.ValueKind == JsonValueKind.Null ? null : value.GetString();
    var parsed = BookFileNameParser.Parse(source);
    return new { source, parsed.Name, parsed.SeriesName, parsed.Index, parentIndex = parsed.ParentIndex, parsed.Year };
}).ToArray();

var supportedImages = new[]
{
    "tiff", "tif", "jpeg", "jpg", "png", "cr2", "crw", "nef", "orf", "pef", "arw", "webp",
    "gif", "bmp", "erf", "raf", "rw2", "nrw", "dng", "ico", "astc", "ktx", "pkm", "wbmp", "avif"
};
var results = new List<object>();
foreach (var sample in input.GetProperty("resolvers").EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(stateRoot, name);
    var media = Path.Combine(root, "media");
    Directory.CreateDirectory(media);
    foreach (var directory in Strings("directories"))
        Directory.CreateDirectory(Path.Combine(media, Native(directory)));
    foreach (var file in Strings("files"))
    {
        var filename = Path.Combine(media, Native(file));
        Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
        File.WriteAllText(filename, "native resolver control", Encoding.UTF8);
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
    var parent = new Folder
    {
        Id = Guid.Parse("95000000-0000-0000-0000-000000000001"),
        Name = "Physical root",
        Path = media
    };
    var libraryOptions = new LibraryOptions
    {
        EnablePhotos = !sample.TryGetProperty("enablePhotos", out var enabled) || enabled.GetBoolean()
    };
    var manager = Stub.Make<ILibraryManager>((method, values) => method.Name switch
    {
        "GetLibraryOptions" => libraryOptions,
        "GetNewItemId" => Guid.Parse("95000000-0000-0000-0000-000000000002"),
        "GetItemById" => values is not null && values.Length > 0 && values[0] is Guid id && id == parent.Id ? parent : null,
        "GetCollectionFolders" => new List<Folder>(),
        _ => Stub.Default(method.ReturnType)
    });
    BaseItem.LibraryManager = manager;
    var imageProcessor = Stub.Make<IImageProcessor>((method, _) => method.Name == "get_SupportedInputFormats"
        ? supportedImages : Stub.Default(method.ReturnType));
    IItemResolver resolver = sample.GetProperty("resolver").GetString() switch
    {
        "book" => new BookResolver(),
        "photo" => new PhotoResolver(imageProcessor, new NamingOptions(), directoryService),
        "photoAlbum" => new PhotoAlbumResolver(imageProcessor, new NamingOptions()),
        var value => throw new ArgumentOutOfRangeException("resolver", value, "Unknown resolver")
    };
    var target = Path.Combine(media, Native(sample.GetProperty("target").GetString()!));
    var info = fileSystem.GetFileSystemInfo(target)
        ?? throw new InvalidOperationException("The target does not exist: " + target);
    var resolve = new ItemResolveArgs(paths, manager)
    {
        Parent = parent,
        FileInfo = info,
        FileSystemChildren = info.IsDirectory ? directoryService.GetFileSystemEntries(target) : [],
        CollectionType = Enum.Parse<CollectionType>(sample.GetProperty("collectionType").GetString()!),
        LibraryOptions = libraryOptions
    };
    var item = resolver.ResolvePath(resolve);
    if (item is not null) ResolverHelper.SetInitialItemValues(item, resolve, fileSystem, manager);
    results.Add(new
    {
        name,
        resolver = sample.GetProperty("resolver").GetString(),
        collectionType = sample.GetProperty("collectionType").GetString(),
        enablePhotos = libraryOptions.EnablePhotos,
        priority = (int)resolver.Priority,
        resolved = Project(item)
    });

    IEnumerable<string> Strings(string property) => sample.TryGetProperty(property, out var values)
        ? values.EnumerateArray().Select(value => value.GetString()!) : [];
    string Native(string value) => value.Replace('/', Path.DirectorySeparatorChar);
    string? ProjectPath(string? value) => value?.Replace(media, "$MEDIA", StringComparison.Ordinal).Replace('\\', '/');
    object? Project(BaseItem? item) => item is null ? null : new
    {
        type = item.GetType().FullName,
        name = item.Name,
        path = ProjectPath(item.Path),
        parentId = item.ParentId.ToString("D").ToLowerInvariant(),
        item.IsFolder,
        mediaType = item.MediaType.ToString(),
        item.IsInMixedFolder,
        item.ProductionYear,
        seriesName = item is Book book ? book.SeriesName : null,
        index = item.IndexNumber,
        parentIndex = item.ParentIndexNumber
    };
}

var assemblies = new[]
{
    typeof(BaseItem).Assembly,
    typeof(BookResolver).Assembly,
    typeof(BookFileNameParser).Assembly
}.Distinct().Select(assembly => new
{
    name = assembly.GetName().Name,
    sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
}).ToArray();
var output = new
{
    actualFrozenBookPhotoResolution = true,
    inputSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(inputText))).ToLowerInvariant(),
    parser,
    results,
    assemblies,
    scope = "Actual frozen BookFileNameParser, BookResolver, PhotoResolver, PhotoAlbumResolver, ResolverHelper, ManagedFileSystem and DirectoryService over real files. Covers collection gates, supported extensions, artwork prefixes, sibling-video ownership, EnablePhotos, single-book directory collapse, parsed book metadata, resolver priorities and initialized names/paths. LibraryManager identity, parent lookup, image decoding and persistence are controls. No Folder.ValidateChildren, CreateItems, recursive scanning, database writes, watcher, metadata providers, faults, concurrency, HTTP, migration or release acceptance."
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
