// Same-run LibraryManager lookup and bounded cache resource consumers.
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BitFaster.Caching.Lru;
using Emby.Server.Implementations.Library;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var inputText = File.ReadAllText(args[0]);
var input = JsonDocument.Parse(inputText).RootElement;
var results = new List<object>();
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var reads = new List<string>();
    var items = new Dictionary<Guid, BaseItem>();
    var configuration = new ServerConfiguration { CacheSize = sample.GetProperty("capacity").GetInt32() };
    var config = Control.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => configuration,
        "add_ConfigurationUpdated" => null,
        _ => throw new NotSupportedException("Unexpected configuration collaborator: " + method.Name)
    });
    var repository = Control.Make<IItemRepository>((method, values) => {
        if (method.Name != "RetrieveItem") throw new NotSupportedException("Unexpected repository collaborator: " + method.Name);
        var id = (Guid)values![0]!; reads.Add(Id(id));
        return items.GetValueOrDefault(id);
    });
    LibraryManager? manager = null; string? constructorException = null;
    try {
        var constructor = typeof(LibraryManager).GetConstructors().Single();
        var arguments = constructor.GetParameters().Select(parameter => parameter.ParameterType == typeof(IServerConfigurationManager) ? (object)config
            : parameter.ParameterType == typeof(IItemRepository) ? repository
            : parameter.ParameterType == typeof(ILoggerFactory) ? NullLoggerFactory.Instance
            : parameter.ParameterType == typeof(Emby.Naming.Common.NamingOptions) ? new Emby.Naming.Common.NamingOptions()
            : null).ToArray();
        manager = (LibraryManager)constructor.Invoke(arguments);
    } catch (TargetInvocationException error) { constructorException = error.InnerException!.GetType().Name; }
    var observations = new List<object>();
    var resources = new List<object>();
    if (manager is not null) {
        var cache = (FastConcurrentLru<Guid, BaseItem>)typeof(LibraryManager).GetField("_cache", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(manager)!;
        foreach (var operation in sample.GetProperty("operations").EnumerateArray()) {
            var action = operation.GetProperty("action").GetString()!;
            var number = operation.TryGetProperty("id", out var idElement) ? idElement.GetInt32() : 0;
            var id = Key(number); string? returned = null; string? exception = null;
            try {
                if (action is "register" or "seed") {
                    var nativeType = operation.GetProperty("type").GetString()!;
                    var type = typeof(BaseItem).Assembly.GetType(nativeType) ?? typeof(LibraryManager).Assembly.GetType(nativeType)
                        ?? throw new TypeLoadException(nativeType);
                    var item = (BaseItem)Activator.CreateInstance(type)!;
                    item.Id = id; item.Name = operation.GetProperty("name").GetString();
                    items[id] = item;
                    if (action == "register") manager.RegisterItem(item);
                } else if (action == "get") returned = manager.GetItemById(id)?.Name;
                else if (action == "drop-row") items.Remove(id);
                else if (action == "remove") cache.TryRemove(id);
                else if (action == "clear") cache.Clear();
                else throw new NotSupportedException(action);
            } catch (Exception error) { exception = error.GetType().Name; }
            if (cache.Count > cache.Capacity) throw new InvalidOperationException("The item cache exceeded its configured bound.");
            observations.Add(new { action, id = Id(id), returned, exception, reads = reads.ToArray() });
        }
        var released = new List<ReleasedResource>();
        var values = new Dictionary<Guid, string>();
        var resourceCache = new FastConcurrentLru<Guid, Resource>(configuration.CacheSize);
        Resource Create(Guid id, string name) => new(id, name, resource => released.Add(new(Id(resource.Id), resource.Name)));
        foreach (var operation in sample.GetProperty("operations").EnumerateArray()) {
            var action = operation.GetProperty("action").GetString()!;
            var id = Key(operation.TryGetProperty("id", out var value) ? value.GetInt32() : 0);
            string? returned = null;
            if (action is "register" or "seed") {
                var name = operation.GetProperty("name").GetString()!;
                values[id] = name;
                if (action == "register") resourceCache.AddOrUpdate(id, Create(id, name));
            } else if (action == "get") {
                if (resourceCache.TryGet(id, out var resource)) returned = resource.Name;
                else if (values.TryGetValue(id, out var name)) {
                    resourceCache.AddOrUpdate(id, Create(id, name)); returned = name;
                }
            } else if (action == "drop-row") values.Remove(id);
            else if (action == "remove") resourceCache.TryRemove(id);
            else if (action == "clear") resourceCache.Clear();
            else throw new NotSupportedException(action);
            if (resourceCache.Count > resourceCache.Capacity) throw new InvalidOperationException("The resource cache exceeded its configured bound.");
            resources.Add(new { action, id = Id(id), returned,
                released = released.OrderBy(entry => entry.id, StringComparer.Ordinal).ThenBy(entry => entry.name, StringComparer.Ordinal).ToArray() });
        }
    }
    results.Add(new { name = sample.GetProperty("name").GetString(), constructorException, observations, resources });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualNativeLibraryManagerCache = true,
    inputSha256 = Hash(Encoding.UTF8.GetBytes(inputText)), processorCount = Environment.ProcessorCount,
    defaultCacheSize = new ServerConfiguration().CacheSize, results,
    assemblies = new[] { typeof(LibraryManager).Assembly, typeof(BaseItem).Assembly, typeof(FastConcurrentLru<,>).Assembly, typeof(ServerConfiguration).Assembly }
        .Distinct().Select(assembly => new { name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }),
    scope = "Same-run designated Native LibraryManager constructor/RegisterItem/GetItemById with controlled repository/configuration, plus the supplied BitFaster cache consuming IDisposable resources. Observations cover lookup results, repository fallback and resource release for every neutral operation. SQL/file deletion, metadata saves, native authentication, clients and release acceptance are outside this component scope." },
    new JsonSerializerOptions { WriteIndented = true }) + "\n");
static Guid Key(int number) => Guid.Parse("99e00000-0000-0000-0000-" + number.ToString("D12"));
static string Id(Guid value) => value.ToString("D");
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public record ReleasedResource(string id, string name);
public sealed class Resource(Guid id, string name, Action<Resource> release) : IDisposable {
    public Guid Id { get; } = id;
    public string Name { get; } = name;
    public void Dispose() => release(this);
}
public class Control : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var result = Create<T, Control>(); ((Control)(object)result).Handler = handler; return result;
    }
}
