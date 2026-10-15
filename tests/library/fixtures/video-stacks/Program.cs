// Actual frozen MovieResolver.ResolveMultiple and VideoListResolver stack projection.
using System.Reflection;
using System.Text.Json;
using Emby.Naming.Common;
using Emby.Naming.Video;
using Emby.Server.Implementations.Library.Resolvers.Movies;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using Microsoft.Extensions.Logging.Abstractions;

var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) =>
    method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => Stub.Default(method.ReturnType));

foreach (var sample in input.EnumerateArray())
{
    var parentName = sample.GetProperty("parentName").GetString()!;
    var parent = new Folder
    {
        Id = Guid.Parse("97a50000-0000-0000-0000-000000000003"),
        Path = "Z:\\Media\\A\\" + parentName,
        Name = parentName
    };
    var intermediate = new Folder
    {
        Id = Guid.Parse("97a50000-0000-0000-0000-000000000002"),
        Path = "Z:\\Media\\A",
        Name = "A"
    };
    var top = new Folder
    {
        Id = Guid.Parse("97a50000-0000-0000-0000-000000000001"),
        Path = "Z:\\Media",
        Name = "Media"
    };
    var aggregate = new AggregateFolder { Id = Guid.Parse("97a50000-0000-0000-0000-000000000099") };
    parent.ParentId = intermediate.Id;
    intermediate.ParentId = top.Id;
    top.ParentId = aggregate.Id;
    var lookup = new BaseItem[] { parent, intermediate, top, aggregate }.ToDictionary(item => item.Id);
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, parameters) =>
        method.Name == "GetItemById" ? lookup.GetValueOrDefault((Guid)parameters![0]!) : Stub.Default(method.ReturnType));
    var directoryService = Stub.Make<IDirectoryService>((method, _) =>
        method.Name == "GetFileSystemEntries" ? Array.Empty<FileSystemMetadata>() : Stub.Default(method.ReturnType));
    var naming = new NamingOptions();
    var resolver = new MovieResolver(
        null!,
        NullLogger<MovieResolver>.Instance,
        naming,
        directoryService,
        new VideoListResolver(naming));
    var files = sample.GetProperty("files").EnumerateArray().Select(file => new FileSystemMetadata
    {
        Name = file.GetString()!,
        FullName = parent.Path + "\\" + file.GetString(),
        IsDirectory = false
    }).ToList();
    var collectionType = Enum.Parse<CollectionType>(sample.GetProperty("collectionType").GetString()!);
    var parseName = collectionType is not CollectionType.homevideos and not CollectionType.photos;
    var stacks = StackResolver.Resolve(files, naming).Select(stack => new
    {
        stack.Name,
        stack.IsDirectoryStack,
        stack.Files
    }).ToArray();
    var resolvedFiles = files.Select(file => VideoResolver.Resolve(
        file.FullName,
        file.IsDirectory,
        naming,
        parseName,
        "Z:\\Media")).Select(file => file is null ? null : new
        {
            file.Path,
            file.Name,
            file.Year,
            ExtraType = file.ExtraType?.ToString(),
            FileNameWithoutExtension = file.FileNameWithoutExtension.ToString()
        }).ToArray();
    var result = resolver.ResolveMultiple(parent, files, collectionType, directoryService);
    results.Add(new
    {
        name = sample.GetProperty("name").GetString(),
        stacks,
        resolvedFiles,
        items = result?.Items.Select(item =>
        {
            var video = (Video)item;
            return new
            {
                nativeType = item.GetType().ToString(),
                item.Name,
                item.Path,
                item.ProductionYear,
                item.IsInMixedFolder,
                video.AdditionalParts,
                video.LocalAlternateVersions,
                VideoType = video.VideoType.ToString()
            };
        }).ToArray(),
        extraFiles = result?.ExtraFiles.Select(file => file.FullName).ToArray()
    });
}

var assemblies = new[]
{
    typeof(BaseItem).Assembly,
    typeof(MovieResolver).Assembly,
    typeof(VideoListResolver).Assembly
}.Select(assembly => new
{
    name = assembly.GetName().Name,
    path = assembly.Location,
    sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location)))
        .ToLowerInvariant()
});

File.WriteAllText(args[1], JsonSerializer.Serialize(new
{
    actualFrozenVideoStackResolution = true,
    results,
    assemblies,
    scope = "Actual frozen MovieResolver.ResolveMultiple, VideoListResolver, StackResolver, VideoResolver and initial item values for file stacks and stack/alternate interaction under a real three-Folder parent chain. Parent lookup, file metadata and empty directory service are controls. Directory stacks, native scanner, owned-part refresh/persistence, deletion and complete library acceptance are outside this oracle."
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;

    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);

    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler)
        where T : class
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
