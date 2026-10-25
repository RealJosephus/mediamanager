using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Xml.Linq;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Configuration;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Extensions.Json;
using MediaBrowser.Common.Net;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging.Abstractions;

var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals, WriteIndented = true };
var consume = args[0] == "consume";
var outputFile = args[consume ? 2 : 1];
var inputBytes = File.ReadAllBytes(args[consume ? 1 : 0]);
using var document = JsonDocument.Parse(inputBytes);
var input = document.RootElement;
var serializer = new MyXmlSerializer();
var outputRoot = Path.Combine(Path.GetDirectoryName(outputFile)!, "states"); Directory.CreateDirectory(outputRoot);
object Failure(Exception failure) => new { message = failure.Message, type = failure.GetType().Name,
    hresult = failure.HResult, cause = failure.InnerException is null ? null : Failure(failure.InnerException) };

JsonNode? Expand(JsonElement value, string root) => value.ValueKind switch {
    JsonValueKind.Object => new JsonObject(value.EnumerateObject().Select(property => KeyValuePair.Create(property.Name, Expand(property.Value, root)))),
    JsonValueKind.Array => new JsonArray(value.EnumerateArray().Select(item => Expand(item, root)).ToArray()),
    JsonValueKind.String when value.GetString()!.StartsWith("@/", StringComparison.Ordinal)
        => JsonValue.Create(Path.Combine(root, value.GetString()![2..].Replace('/', Path.DirectorySeparatorChar))),
    _ => JsonNode.Parse(value.GetRawText())
};

void Apply(object target, JsonElement values, string root) {
    foreach (var property in values.EnumerateObject()) {
        var field = target.GetType().GetProperty(property.Name) ?? throw new InvalidOperationException("Unknown public configuration field: " + property.Name);
        var expanded = Expand(property.Value, root);
        field.SetValue(target, JsonSerializer.Deserialize(expanded?.ToJsonString() ?? "null", field.PropertyType, options));
    }
}

object Disk(string filename, Type type) {
    byte[]? bytes = File.Exists(filename) ? File.ReadAllBytes(filename) : null;
    object? value = null, error = null; string[]? elements = null;
    if (bytes is not null) {
        try { value = serializer.DeserializeFromBytes(type, bytes); }
        catch (Exception failure) { error = Failure(failure); }
        try { elements = XDocument.Parse(Encoding.UTF8.GetString(bytes)).Root!.Elements().Where(element => element.Name.NamespaceName.Length == 0).Select(element => element.Name.LocalName).ToArray(); }
        catch { }
    }
    return new { bytes = bytes is null ? null : Convert.ToBase64String(bytes), directory = Directory.Exists(filename),
        accepted = bytes is null ? (bool?)null : error is null, value, error, elements };
}

object[] Tree(string root) {
    return Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories).Order(StringComparer.Ordinal).Select(filename => {
        var directory = Directory.Exists(filename);
        var relative = Path.GetRelativePath(root, filename).Replace(Path.DirectorySeparatorChar, '/');
        return (object)new { path = relative, directory, bytes = directory || relative is "config/system.xml" or "config/network.xml" ? null : Convert.ToBase64String(File.ReadAllBytes(filename)) };
    }).ToArray();
}

object Observe(JsonElement sample, int index) {
    var root = Path.Combine(outputRoot, index.ToString()); Directory.CreateDirectory(root);
    var name = sample.GetProperty("name").GetString()!;
    var operation = sample.GetProperty("operation").GetString()!;
    foreach (var relative in input.GetProperty("directories").EnumerateArray()) Directory.CreateDirectory(Path.Combine(root, relative.GetString()!));
    var configDirectory = Path.Combine(root, "config"); Directory.CreateDirectory(configDirectory);
    var filename = Path.Combine(configDirectory, "system.xml");
    var initial = new ServerConfiguration(); Apply(initial, input.GetProperty("initial"), root);
    if (sample.TryGetProperty("initial", out var initialChanges)) Apply(initial, initialChanges, root);
    serializer.SerializeToFile(initial, filename);
    serializer.SerializeToFile(new NetworkConfiguration(), Path.Combine(configDirectory, "network.xml"));
    var preselected = sample.TryGetProperty("preselectedCache", out var cache) ? cache.GetString()! : Path.Combine(root, "preselected-cache");
    var paths = new ServerApplicationPaths(root, Path.Combine(root, "log"), configDirectory, preselected, Path.Combine(root, "web"));
    ServerConfigurationManager? manager = null;
    void Action(string action) {
        switch (action) {
            case "metadata-file": File.WriteAllText(Path.Combine(root, "metadata-file"), "metadata path is a file"); break;
            case "initial-cache-other-marker": File.WriteAllText(Path.Combine(root, "cache-initial", ".jellyfin-data"), "foreign marker"); break;
            case "cache-other-marker": File.WriteAllText(Path.Combine(root, "cache-next", ".jellyfin-data"), "foreign marker"); break;
            case "cache-marker-and-tag": File.WriteAllText(Path.Combine(root, "cache-next", ".jellyfin-cache"), "existing marker"); File.WriteAllText(Path.Combine(root, "cache-next", "CACHEDIR.TAG"), "existing cache tag"); break;
            case "cache-own-marker-case": File.WriteAllText(Path.Combine(root, "cache-next", ".jellyfin-CACHE"), "existing differently cased marker"); break;
            case "cache-marker-directory": Directory.CreateDirectory(Path.Combine(root, "cache-next", ".jellyfin-directory")); break;
            case "metadata-next-file": Directory.Delete(Path.Combine(root, "metadata-next"), true); File.WriteAllText(Path.Combine(root, "metadata-next"), "metadata path became a file"); break;
            case "cache-next-file": Directory.Delete(Path.Combine(root, "cache-next"), true); File.WriteAllText(Path.Combine(root, "cache-next"), "cache path became a file"); break;
            case "remove-config-directory": Directory.Delete(configDirectory, true); break;
            case "configuration-target-directory": File.Delete(filename); Directory.CreateDirectory(filename); break;
            case "remove-configuration-target-directory": Directory.Delete(filename); break;
            case "readonly-system": File.SetAttributes(filename, FileAttributes.ReadOnly); break;
            case "live-metadata-file": File.WriteAllText(Path.Combine(root, "metadata-file"), "metadata path is a file"); manager!.Configuration.MetadataPath = Path.Combine(root, "metadata-file"); break;
            case "add-unmodeled": {
                var xml = XDocument.Load(filename); xml.Root!.SetAttributeValue(XNamespace.Xmlns + "u", "urn:future");
                xml.Root.SetAttributeValue(XName.Get("flag", "urn:future"), "retained input");
                xml.Root.Add(new XText("before"), new XElement(XName.Get("extra", "urn:future"), new XAttribute("a", "v"), "x", new XElement(XName.Get("child", "urn:future")), "y"), new XText("after"));
                File.WriteAllText(filename, xml.ToString()); break;
            }
            default: throw new InvalidOperationException("Unknown physical configuration action: " + action);
        }
    }
    void Actions(string property) { if (sample.TryGetProperty(property, out var actions)) foreach (var action in actions.EnumerateArray()) Action(action.GetString()!); }
    Actions("seed");
    object? initializationError = null;
    try { manager = new ServerConfigurationManager(paths, NullLoggerFactory.Instance, serializer); manager.RegisterConfiguration<NetworkConfigurationFactory>(); }
    catch (Exception failure) { initializationError = Failure(failure); }
    JsonElement Snapshot() => JsonSerializer.SerializeToElement(new { configuration = manager?.Configuration,
        network = manager?.GetNetworkConfiguration(), metadataPath = paths.InternalMetadataPath, cachePath = paths.CachePath,
        disk = Disk(filename, typeof(ServerConfiguration)), networkDisk = Disk(Path.Combine(configDirectory, "network.xml"), typeof(NetworkConfiguration)), tree = Tree(root) }, options);
    var initialized = Snapshot();
    if (initializationError is not null || operation == "initialize") return new { name, root, operation,
        initialized = initializationError is null, initializationError, initialState = initialized, before = initialized, requested = (JsonElement?)null,
        accepted = initializationError is null, error = initializationError, updating = Array.Empty<JsonElement>(), namedUpdating = Array.Empty<JsonElement>(),
        namedUpdated = Array.Empty<JsonElement>(), afterCall = initialized, continuation = Array.Empty<JsonElement>(), updated = Array.Empty<JsonElement>(), laterUpdated = false, afterDrain = initialized };

    Actions("before");
    var before = Snapshot();
    var updating = new List<JsonElement>(); var namedUpdating = new List<JsonElement>(); var namedUpdated = new List<JsonElement>(); var updated = new List<JsonElement>();
    using var releaseUpdated = new ManualResetEventSlim(false); using var completedUpdated = new SemaphoreSlim(0); using var laterCompleted = new SemaphoreSlim(0);
    var laterUpdated = false;
    manager!.ConfigurationUpdating += (_, incoming) => {
        updating.Add(JsonSerializer.SerializeToElement(new { state = Snapshot(), next = incoming.Argument }, options));
        if (sample.TryGetProperty("updating", out var changes)) Apply(incoming.Argument, changes, root);
        Actions("duringUpdating");
        if (sample.TryGetProperty("updatingFailure", out var throws) && throws.GetBoolean()) throw new InvalidOperationException("Controlled updating failure.");
    };
    manager.NamedConfigurationUpdating += (_, incoming) => {
        namedUpdating.Add(JsonSerializer.SerializeToElement(new { name = incoming.Key, state = Snapshot(), next = incoming.NewConfiguration }, options));
        if (sample.TryGetProperty("namedUpdating", out var changes)) Apply(incoming.NewConfiguration, changes, root);
        if (sample.TryGetProperty("namedUpdatingFailure", out var throws) && throws.GetBoolean()) throw new InvalidOperationException("Controlled named updating failure.");
    };
    manager.NamedConfigurationUpdated += (_, incoming) => namedUpdated.Add(JsonSerializer.SerializeToElement(new { name = incoming.Key, state = Snapshot(), next = incoming.NewConfiguration }, options));
    manager.ConfigurationUpdated += (_, _) => {
        try {
            if (!releaseUpdated.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("The controlled updated event was not released.");
            lock (updated) updated.Add(Snapshot());
            if (sample.TryGetProperty("updatedFailure", out var throws) && throws.GetBoolean()) throw new InvalidOperationException("Controlled updated failure.");
        } finally { completedUpdated.Release(); }
    };
    manager.ConfigurationUpdated += (_, _) => { laterUpdated = true; laterCompleted.Release(); };

    JsonElement? requested = null; object? error = null;
    var previous = manager.Configuration;
    ServerConfiguration? incoming = null;
    NameValuePair[]? originalIncomingContentTypes = null;
    var successfulServerSaves = 0;
    try {
        if (operation == "replace") {
            var next = new ServerConfiguration(); Apply(next, input.GetProperty("next"), root);
            if (sample.TryGetProperty("next", out var changes)) Apply(next, changes, root);
            incoming = next; originalIncomingContentTypes = next.ContentTypes;
            requested = JsonSerializer.SerializeToElement(next, options);
            manager.ReplaceConfiguration(next);
            successfulServerSaves++;
        } else if (operation == "network") {
            var network = manager.GetNetworkConfiguration(); Apply(network, sample.GetProperty("changes"), root);
            requested = JsonSerializer.SerializeToElement(network, options);
            manager.SaveConfiguration(NetworkConfigurationStore.StoreKey, network);
        } else {
            Apply(manager.Configuration, sample.GetProperty("changes"), root);
            requested = JsonSerializer.SerializeToElement(manager.Configuration, options);
            manager.SaveConfiguration();
            successfulServerSaves++;
        }
    } catch (Exception failure) { error = Failure(failure); }
    var afterCall = Snapshot();
    var continuation = new List<JsonElement>();
    if (sample.TryGetProperty("continuation", out var steps)) foreach (var step in steps.EnumerateArray()) {
        var target = step.GetProperty("target").GetString()!; object? continuationError = null;
        try {
            switch (target) {
                case "incoming": Apply(incoming!, step.GetProperty("changes"), root); break;
                case "current": Apply(manager.Configuration, step.GetProperty("changes"), root); break;
                case "previous": Apply(previous, step.GetProperty("changes"), root); break;
                case "originalIncomingContentTypes": originalIncomingContentTypes![0].Value = step.GetProperty("value").GetString(); break;
                case "filesystem": Action(step.GetProperty("action").GetString()!); break;
                case "save": manager.SaveConfiguration(); successfulServerSaves++; break;
                default: throw new InvalidOperationException("Unknown retained configuration operation: " + target);
            }
        } catch (Exception failure) { continuationError = Failure(failure); }
        continuation.Add(JsonSerializer.SerializeToElement(new { name = step.GetProperty("name").GetString(), target,
            error = continuationError, state = Snapshot(), incoming, previous, originalIncomingContentTypes }, options));
    }
    releaseUpdated.Set();
    var eventDeadline = DateTime.UtcNow.AddSeconds(10);
    for (var saved = 0; saved < successfulServerSaves; saved++) {
        var remaining = eventDeadline - DateTime.UtcNow;
        if (remaining <= TimeSpan.Zero || !completedUpdated.Wait(remaining)) throw new TimeoutException("The actual configuration updated event did not complete.");
    }
    // The final event handler is part of the multicast callback; wait for that
    // actual effect after a successful first handler before observing it.
    if (!(sample.TryGetProperty("updatedFailure", out var updatedThrows) && updatedThrows.GetBoolean()))
        for (var saved = 0; saved < successfulServerSaves; saved++) {
            var remaining = eventDeadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero || !laterCompleted.Wait(remaining)) throw new TimeoutException("The actual later updated handler did not complete.");
        }
    var afterDrain = Snapshot();
    if (File.Exists(filename)) File.SetAttributes(filename, FileAttributes.Normal);
    return new { name, root, operation, initialized = true, initializationError, initialState = initialized, before, requested, accepted = error is null,
        error, updating, namedUpdating, namedUpdated, afterCall, continuation, updated, laterUpdated, afterDrain };
}

var results = consume ? input.EnumerateArray().Select(sample => (object)new {
    name = sample.GetProperty("name").GetString(), root = sample.GetProperty("root").GetString(),
    disk = Disk(sample.GetProperty("filename").GetString()!, sample.GetProperty("root").GetString() == "server" ? typeof(ServerConfiguration) : typeof(NetworkConfiguration))
}).ToArray() : input.GetProperty("cases").EnumerateArray().Select((sample, index) => Observe(sample, index)).ToArray();
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location)).Select(assembly => new {
    name = assembly.GetName().Name, filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }).OrderBy(row => row.name).ToArray();
File.WriteAllText(outputFile, JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)),
    actualServerConfigurationManager = !consume, actualXmlSerializer = true, actualPathEffects = !consume, actualQueuedEvents = !consume, actualContinuedRead = consume,
    host = new { processorCount = Environment.ProcessorCount }, assemblies, results }, options) + "\n");
