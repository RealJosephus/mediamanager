// Records actual Jellyfin MovieNfoParser local-image filesystem and URI behavior.
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Providers;
using MediaBrowser.XbmcMetadata.Parsers;
using MediaBrowser.XbmcMetadata.Providers;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var filesystemRoot = Path.GetFullPath(args[2]);
Directory.CreateDirectory(filesystemRoot);
var results = new List<object>();
var ordinal = 0;

foreach (var sample in input.EnumerateArray())
{
    var name = sample.GetProperty("name").GetString()!;
    var root = Path.Combine(filesystemRoot, $"{ordinal++:D3}");
    Directory.CreateDirectory(root);
    var present = Path.Combine(root, "present image.jpg");
    var second = Path.Combine(root, "second image.jpg");
    var unicode = Path.Combine(root, "圖像-İ-中文.jpg");
    var missing = Path.Combine(root, "missing image.jpg");
    var directory = Path.Combine(root, "directory.jpg");
    var existing = Path.Combine(root, "preexisting image.jpg");
    File.WriteAllText(present, "present");
    File.WriteAllText(second, "second");
    File.WriteAllText(unicode, "unicode");
    File.WriteAllText(existing, "existing");
    Directory.CreateDirectory(directory);

    var replacements = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["{{PRESENT}}"] = present,
        ["{{SECOND}}"] = second,
        ["{{UNICODE}}"] = unicode,
        ["{{MISSING}}"] = missing,
        ["{{DIRECTORY}}"] = directory,
        ["{{PRESENT_URI}}"] = new Uri(present).AbsoluteUri,
        ["{{MISSING_URI}}"] = new Uri(missing).AbsoluteUri
    };
    var xml = sample.GetProperty("xml").GetString()!;
    foreach (var replacement in replacements)
    {
        xml = xml.Replace(replacement.Key, EscapeXml(replacement.Value), StringComparison.Ordinal);
    }
    var nfo = Path.Combine(root, "movie.nfo");
    File.WriteAllText(nfo, xml, new UTF8Encoding(false));

    var paths = DispatchProxy.Create<IApplicationPaths, PathsProxy>();
    ((PathsProxy)(object)paths).TempDirectory = Path.Combine(root, "temp");
    var filesystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var innerDirectories = new DirectoryService(filesystem);
    var cancellation = new CancellationTokenSource();
    if (sample.TryGetProperty("cancelBefore", out var cancelBefore) && cancelBefore.GetBoolean())
    {
        cancellation.Cancel();
    }

    var directories = DispatchProxy.Create<IDirectoryService, DirectoryServiceProxy>();
    var directoryProxy = (DirectoryServiceProxy)(object)directories;
    directoryProxy.Inner = innerDirectories;
    directoryProxy.Root = root;
    directoryProxy.Cancellation = cancellation;
    if (sample.TryGetProperty("failLookupAt", out var failLookupAt)) directoryProxy.FailAt = failLookupAt.GetInt32();
    if (sample.TryGetProperty("cancelAfterLookup", out var cancelAfterLookup)) directoryProxy.CancelAfter = cancelAfterLookup.GetInt32();

    var configuration = DispatchProxy.Create<IConfigurationManager, ConfigurationProxy>();
    ((ConfigurationProxy)(object)configuration).Options = new XbmcMetadataOptions();
    var providers = DispatchProxy.Create<IProviderManager, ProviderProxy>();
    var users = DispatchProxy.Create<IUserManager, UserManagerProxy>();
    var userData = DispatchProxy.Create<IUserDataManager, UserDataProxy>();
    var providerRuntime = sample.TryGetProperty("providerRuntime", out var providerFlag) && providerFlag.GetBoolean();
    Video movie = new Movie();
    IEnumerable<LocalImageInfo> resultImages = [];
    IEnumerable<(string Url, ImageType Type)> resultRemoteImages = [];
    string? exception = null;
    var hasMetadata = false;
    if (providerRuntime)
    {
        try
        {
            var source = new Movie { Path = Path.Combine(root, "movie.mkv") };
            var result = new RuntimeMovieNfoProvider(filesystem, configuration, providers, users, userData, directories)
                .GetMetadata(new ItemInfo(source), directories, cancellation.Token).GetAwaiter().GetResult();
            movie = result.Item;
            resultImages = result.Images;
            resultRemoteImages = result.RemoteImages;
            hasMetadata = result.HasMetadata;
        }
        catch (Exception error)
        {
            exception = error.GetType().Name;
        }
    }
    else
    {
        var result = new MetadataResult<Video> { Item = movie };
        foreach (var typeName in ReadStrings(sample, "existingLocal"))
        {
            var type = Enum.Parse<ImageType>(typeName);
            result.Images.Add(new LocalImageInfo { FileInfo = innerDirectories.GetFile(existing)!, Type = type });
        }
        foreach (var typeName in ReadStrings(sample, "existingRemote"))
        {
            result.RemoteImages.Add(($"https://preexisting.test/{typeName.ToLowerInvariant()}.jpg", Enum.Parse<ImageType>(typeName)));
        }

        try
        {
            new MovieNfoParser(NullLogger<MovieNfoParser>.Instance, configuration, providers, users, userData, directories)
                .Fetch(result, nfo, cancellation.Token);
            hasMetadata = true;
        }
        catch (Exception error)
        {
            exception = error.GetType().Name;
        }

        movie = result.Item;
        resultImages = result.Images;
        resultRemoteImages = result.RemoteImages;
    }

    results.Add(new
    {
        name,
        providerRuntime,
        raw = new
        {
            normalizedBytes = Encoding.UTF8.GetByteCount(Normalize(xml, root)),
            normalizedSha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(xml, root)))).ToLowerInvariant(),
            normalized = Normalize(xml, root)
        },
        exception,
        hasMetadata,
        item = new { movie.Name },
        lookups = directoryProxy.Calls,
        remoteImages = resultRemoteImages.Select(image => new { url = image.Url, type = image.Type.ToString() }).ToArray(),
        localImages = resultImages.Select(image => new
        {
            path = Normalize(image.FileInfo.FullName, root),
            name = image.FileInfo.Name,
            exists = image.FileInfo.Exists,
            isDirectory = image.FileInfo.IsDirectory,
            type = image.Type.ToString()
        }).ToArray()
    });
}

var output = JsonSerializer.Serialize(new
{
    schemaVersion = 1,
    candidateVerified = false,
    frozenJellyfinHead = "208c278b75abd897aefa1e1175126eac5e4dbfaa",
    inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    environment = new
    {
        os = Environment.OSVersion.ToString(),
        isWindows = OperatingSystem.IsWindows(),
        culture = CultureInfo.CurrentCulture.Name,
        uiCulture = CultureInfo.CurrentUICulture.Name
    },
    boundary = "Actual MovieNfoParser plus BaseNfoProvider/BaseVideoNfoProvider runtime result creation with ManagedFileSystem and DirectoryService over per-scene temporary files. The declared Windows matrix covers local path and UNC classification, System.Uri file forms with raw literal DirectoryService lookups, and remote authority, opaque, malformed-percent, ASCII display and component-specific IRI rendering. A delegating directory-service probe records literal paths and deterministically injects the declared failure/cancellation scenes.",
    uncovered = new[]
    {
        "non-Windows System.Uri and filesystem behavior",
        "reachable UNC share contents, reparse points, ACL races and path-length policy",
        "filesystem mutation races after parser acceptance",
        "XML grammar, encoding, NLS and URI normalization cases outside the declared input matrix",
        "non-Movie parsers and downstream image persistence"
    },
    results
}, json).ReplaceLineEndings("\n") + "\n";
File.WriteAllText(args[1], output, new UTF8Encoding(false));

static IEnumerable<string> ReadStrings(JsonElement sample, string name)
    => sample.TryGetProperty(name, out var values) ? values.EnumerateArray().Select(value => value.GetString()!) : [];

static string EscapeXml(string value)
    => value.Replace("&", "&amp;", StringComparison.Ordinal).Replace("<", "&lt;", StringComparison.Ordinal)
        .Replace(">", "&gt;", StringComparison.Ordinal).Replace("\"", "&quot;", StringComparison.Ordinal);

static string Normalize(string value, string root)
{
    var normalized = value.Replace(root, "$ROOT", StringComparison.OrdinalIgnoreCase);
    var uriRoot = new Uri(root + Path.DirectorySeparatorChar).AbsoluteUri.TrimEnd('/');
    return normalized.Replace(uriRoot, "$ROOT_URI", StringComparison.OrdinalIgnoreCase);
}

public class PathsProxy : DispatchProxy
{
    public string TempDirectory = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "get_TempDirectory" => TempDirectory,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class ConfigurationProxy : DispatchProxy
{
    public XbmcMetadataOptions Options = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetConfiguration" => Options,
        "add_ConfigurationUpdated" or "remove_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class ProviderProxy : DispatchProxy
{
    private readonly ExternalIdInfo[] _ids =
    [
        new("IMDb", "Imdb", ExternalIdMediaType.Movie),
        new("TMDb", "Tmdb", ExternalIdMediaType.Movie),
        new("TVDb", "Tvdb", ExternalIdMediaType.Series)
    ];

    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "GetExternalIdInfos" => _ids,
        "add_RefreshStarted" or "remove_RefreshStarted" or "add_RefreshCompleted" or "remove_RefreshCompleted"
            or "add_RefreshProgress" or "remove_RefreshProgress" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class UserManagerProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "add_OnUserUpdated" or "remove_OnUserUpdated" => null,
        "GetUserById" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public class UserDataProxy : DispatchProxy
{
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch
    {
        "add_UserDataSaved" or "remove_UserDataSaved" => null,
        _ => throw new NotSupportedException(method.Name)
    };
}

public sealed class RuntimeMovieNfoProvider : BaseVideoNfoProvider<Movie>
{
    public RuntimeMovieNfoProvider(
        IFileSystem fileSystem,
        IConfigurationManager configuration,
        IProviderManager providers,
        IUserManager users,
        IUserDataManager userData,
        IDirectoryService directories)
        : base(NullLogger<BaseVideoNfoProvider<Movie>>.Instance, fileSystem, configuration, providers, users, userData, directories)
    {
    }
}

public class DirectoryServiceProxy : DispatchProxy
{
    public IDirectoryService Inner = null!;
    public string Root = null!;
    public CancellationTokenSource Cancellation = null!;
    public int FailAt;
    public int CancelAfter;
    public List<object> Calls = [];
    private int _count;

    protected override object? Invoke(MethodInfo? method, object?[]? args)
    {
        if (method!.Name != "GetFile") return method.Invoke(Inner, args);
        var path = (string)args![0]!;
        var call = ++_count;
        if (call == FailAt)
        {
            Calls.Add(new { path = NormalizePath(path), outcome = "IOException" });
            throw new IOException("Injected directory-service failure.");
        }

        var file = Inner.GetFile(path);
        Calls.Add(new { path = NormalizePath(path), outcome = file is null ? "missing-or-directory" : "file" });
        if (call == CancelAfter) Cancellation.Cancel();
        return file;
    }

    private string NormalizePath(string value)
    {
        var normalized = value.Replace(Root, "$ROOT", StringComparison.OrdinalIgnoreCase);
        var uriRoot = new Uri(Root + Path.DirectorySeparatorChar).AbsoluteUri.TrimEnd('/');
        return normalized.Replace(uriRoot, "$ROOT_URI", StringComparison.OrdinalIgnoreCase);
    }
}
