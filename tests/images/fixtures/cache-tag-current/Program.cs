using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Drawing;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
using var declaration = JsonDocument.Parse(inputBytes);
var configuration = new ServerConfiguration { ParallelImageEncodingLimit = 1 };
var config = Proxy.Make<IServerConfigurationManager>((method, values) => method.Name switch {
    "get_Configuration" => configuration,
    _ => throw new NotSupportedException("Unexpected configuration access: " + method.Name)
});
var paths = Proxy.Unused<IServerApplicationPaths>();
var fileSystem = Proxy.Unused<IFileSystem>();
var encoder = Proxy.Unused<IImageEncoder>();
using var processor = new ImageProcessor(NullLogger<ImageProcessor>.Instance, paths, fileSystem, encoder, config);
var samples = new List<object>();
foreach (var sample in declaration.RootElement.GetProperty("samples").EnumerateArray()) {
    var baseItemPath = sample.GetProperty("baseItemPath").GetString()!;
    var imagePath = sample.GetProperty("imagePath").GetString()!;
    var modified = DateTime.Parse(sample.GetProperty("modified").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
    var item = new Movie { Path = baseItemPath };
    var dto = new BaseItemDto { Path = baseItemPath };
    var image = new ItemImageInfo { Path = imagePath, Type = ImageType.Primary, DateModified = modified };
    var chapter = new ChapterInfo { ImagePath = imagePath, ImageDateModified = modified };
    var user = new User("Image tag component", "component-authentication", "component-reset") {
        ProfileImage = new Jellyfin.Database.Implementations.Entities.ImageInfo(imagePath) { LastModified = modified }
    };
    samples.Add(new {
        name = sample.GetProperty("name").GetString(),
        baseItemPath, imagePath,
        modified = modified.ToString("yyyy-MM-dd HH:mm:ss.fffffff", CultureInfo.InvariantCulture),
        ticks = modified.Ticks.ToString(CultureInfo.InvariantCulture),
        stringTag = processor.GetImageCacheTag(baseItemPath, modified),
        itemTag = processor.GetImageCacheTag(item, image),
        dtoTag = processor.GetImageCacheTag(dto, image),
        chapterTag = processor.GetImageCacheTag(item, chapter),
        dtoChapterTag = processor.GetImageCacheTag(dto, chapter),
        userTag = processor.GetImageCacheTag(user),
        emptyChapterTag = processor.GetImageCacheTag(item, new ChapterInfo { ImageDateModified = modified }),
        emptyDtoChapterTag = processor.GetImageCacheTag(dto, new ChapterInfo { ImageDateModified = modified })
    });
}
var emptyUser = new User("No profile image", "component-authentication", "component-reset");
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualImageProcessor = true,
    inputSha256 = Hash(inputBytes),
    missingUserImageTag = processor.GetImageCacheTag(emptyUser),
    samples,
    assemblies = new[] { typeof(ImageProcessor).Assembly, typeof(BaseExtensions).Assembly, typeof(User).Assembly,
        typeof(Movie).Assembly, typeof(BaseItemDto).Assembly }.Distinct().Select(assembly => new {
            name = assembly.GetName().Name, filename = assembly.Location, sha256 = Hash(File.ReadAllBytes(assembly.Location))
        })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

public class Proxy : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Proxy>(); ((Proxy)(object)value).Handler = handler; return value;
    }
    public static T Unused<T>() where T : class => Make<T>((method, values) =>
        throw new NotSupportedException("Image tag calculation accessed " + typeof(T).Name + "." + method.Name));
}
