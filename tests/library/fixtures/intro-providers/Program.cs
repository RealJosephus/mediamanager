using System.Collections.Concurrent;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var bytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(bytes).RootElement;
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray())
{
    var rows = new Dictionary<Guid, BaseItem>();
    foreach (var row in input.GetProperty("items").EnumerateArray())
    {
        var item = Entity(row.GetProperty("type").GetString()!);
        item.Id = row.GetProperty("id").GetGuid(); item.Name = row.GetProperty("name").GetString(); rows[item.Id] = item;
    }
    var paths = input.GetProperty("paths").EnumerateArray().ToDictionary(path => path.GetProperty("path").GetString()!);
    var appPaths = Boundary.Make<IServerApplicationPaths>((method, _) => method.Name == "get_ProgramDataPath"
        ? input.GetProperty("programDataPath").GetString() : null);
    var caseSensitive = (sample.TryGetProperty("configuration", out var sampleConfiguration) ? sampleConfiguration : input.GetProperty("configuration"))
        .GetProperty("EnableCaseSensitiveItemIds").GetBoolean();
    var config = Boundary.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => new ServerConfiguration { EnableCaseSensitiveItemIds = caseSensitive }, "get_ApplicationPaths" => appPaths,
        "GetConfiguration" => new MetadataConfiguration(), "add_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException("Unexpected configuration call: " + method.Name)
    });
    var files = Boundary.Make<IFileSystem>((method, values) => method.Name switch {
        "GetFileSystemInfo" or "GetFileInfo" => new FileSystemMetadata { Exists = true,
            FullName = (string)values![0]!, Name = ((string)values[0]!).Replace('\\', '/').Split('/').Last(),
            Length = 100, CreationTimeUtc = DateTime.UnixEpoch, LastWriteTimeUtc = DateTime.UnixEpoch },
        "AreEqual" => Equals(values![0], values[1]),
        _ => throw new NotSupportedException("Unexpected filesystem call: " + method.Name)
    });
    var repository = Boundary.Make<IItemRepository>((method, values) => method.Name == "RetrieveItem"
        ? rows.GetValueOrDefault((Guid)values![0]!) : throw new NotSupportedException(method.Name));
    var constructor = typeof(LibraryManager).GetConstructors().Single();
    var arguments = constructor.GetParameters().Select(parameter => parameter.ParameterType == typeof(IServerConfigurationManager) ? (object)config
        : parameter.ParameterType == typeof(IItemRepository) ? repository : parameter.ParameterType == typeof(IFileSystem) ? files
        : parameter.ParameterType == typeof(ILoggerFactory) ? NullLoggerFactory.Instance
        : parameter.ParameterType == typeof(Emby.Naming.Common.NamingOptions) ? new Emby.Naming.Common.NamingOptions() : null).ToArray();
    var manager = (LibraryManager)constructor.Invoke(arguments);
    BaseItem.ConfigurationManager = config; BaseItem.FileSystem = files; BaseItem.LibraryManager = manager;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    foreach (var (path, definition) in paths)
    {
        var type = definition.GetProperty("type").GetString();
        if (type is null || !definition.GetProperty("saved").GetBoolean()) continue;
        var item = Entity(type); item.Path = path; item.Id = manager.GetNewItemId(path, item.GetType()); item.Name = "Persisted path video";
        rows[item.Id] = item;
    }
    var resolver = Boundary.Make<IItemResolver>((method, values) => {
        if (method.Name == "get_Priority") return ResolverPriority.First;
        var path = ((ItemResolveArgs)values![0]!).Path;
        if (!paths.TryGetValue(path, out var definition) || definition.GetProperty("type").GetString() is not string type) return null;
        if (definition.TryGetProperty("throw", out var fail) && fail.GetBoolean()) throw new InvalidOperationException("Controlled resolver failure.");
        var item = Entity(type); item.Name = "Unpersisted resolver name"; return item;
    });
    Set("EntityResolvers", new IItemResolver[] { resolver });
    Set("EntityResolutionIgnoreRules", Array.Empty<IResolverIgnoreRule>());
    var starts = new ConcurrentQueue<string>(); var completions = new ConcurrentQueue<string>();
    var providers = sample.GetProperty("providers").EnumerateArray().Select(provider => Boundary.Make<IIntroProvider>((method, _) =>
        method.Name == "get_Name" ? provider.GetProperty("name").GetString() : Provide(provider))).ToArray();
    Set("IntroProviders", providers);
    var status = 200;
    object[] items = [];
    try {
        items = (await manager.GetIntros(new Movie { Name = "Main feature" }, new User("Intro reader", "reader", "reader")))
            .Select(item => (object)new { Id = item.Id.ToString("N"), Type = item.GetType().Name, item.Name }).ToArray();
    } catch (ArgumentException) { status = 400; }
    results.Add(new { name = sample.GetProperty("name").GetString(), status, items, starts = starts.ToArray(), completions = completions.ToArray() });

    void Set(string property, object value) => typeof(LibraryManager).GetProperty(property, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, value);
    async Task<IEnumerable<IntroInfo>> Provide(JsonElement provider) {
        var name = provider.GetProperty("name").GetString()!; starts.Enqueue(name);
        if (provider.TryGetProperty("delayMs", out var delay)) await Task.Delay(delay.GetInt32());
        if (provider.TryGetProperty("throw", out var fail) && fail.GetBoolean()) throw new InvalidOperationException("Controlled provider failure.");
        completions.Enqueue(name);
        return provider.GetProperty("intros").EnumerateArray().Select(info => new IntroInfo {
            ItemId = info.TryGetProperty("ItemId", out var id) ? id.GetGuid() : null,
            Path = info.TryGetProperty("Path", out var path) ? path.GetString() : null
        }).ToArray();
    }
}
var assemblies = new[] { typeof(LibraryManager).Assembly, typeof(BaseItem).Assembly, Assembly.Load("jellyfin") }
    .Distinct().Select(assembly => new { assembly.FullName, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualLibraryManagerExecution = true,
    inputSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), results, assemblies,
    scope = "Actual LibraryManager.GetIntros/ResolveIntro/GetItemById/ResolvePath and resolver initialization. Provider, repository, filesystem and concrete resolver collaborators are controlled. Not native provider plugin loading, real filesystem, HTTP or DTO projection."
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static BaseItem Entity(string type) => type switch { "Video" => new Video(), "Movie" => new Movie(), "Audio" => new Audio(), _ => throw new ArgumentException(type) };
public class Boundary : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var proxy = Create<T, Boundary>(); ((Boundary)(object)proxy).Handler = handler; return proxy;
    }
}
