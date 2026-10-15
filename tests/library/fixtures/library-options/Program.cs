using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Emby.Server.Implementations.Serialization;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
var json = new JsonSerializerOptions { WriteIndented = true, Converters = { new JsonStringEnumConverter() } };
var serializer = new MyXmlSerializer();
CollectionFolder.XmlSerializer = serializer;
BaseItem.Logger = NullLogger<BaseItem>.Instance;
var observations = new List<object>();
foreach (var sample in input.EnumerateArray()) {
    CollectionFolder.OnCollectionFolderChange();
    var name = sample.GetProperty("name").GetString()!;
    var state = Path.GetFullPath(Path.Combine(args[1], name));
    var directory = Path.Combine(state, "root", "default", "Library");
    Directory.CreateDirectory(directory);
    var filename = Path.Combine(directory, "options.xml");
    string Map(string value) => value.Replace("{data}", Path.Combine(state, "data"), StringComparison.Ordinal)
        .Replace("{metadata}", Path.Combine(state, "metadata"), StringComparison.Ordinal);
    var reverseCalls = new List<string>();
    CollectionFolder.ApplicationHost = Stub.Make<IServerApplicationHost>((method, parameters) => {
        if (method.Name == "ExpandVirtualPath") return ((string)parameters![0]!).Replace("%AppDataPath%", Path.Combine(state, "data"), StringComparison.OrdinalIgnoreCase)
            .Replace("%MetadataPath%", Path.Combine(state, "metadata"), StringComparison.OrdinalIgnoreCase);
        if (method.Name == "ReverseVirtualPath") {
            var value = (string)parameters![0]!; reverseCalls.Add(value);
            if (sample.TryGetProperty("reverseFailure", out var failure) && failure.GetBoolean()) throw new IOException("Controlled reverse path failure.");
            return value.Replace(Path.Combine(state, "data"), "%AppDataPath%", StringComparison.OrdinalIgnoreCase)
                .Replace(Path.Combine(state, "metadata"), "%MetadataPath%", StringComparison.OrdinalIgnoreCase);
        }
        return Stub.Default(method.ReturnType);
    });
    if (sample.TryGetProperty("xml", out var initialXml)) File.WriteAllText(filename, Map(initialXml.GetString()!), new UTF8Encoding(false));
    if (sample.TryGetProperty("directoryFile", out var directoryFile) && directoryFile.GetBoolean()) Directory.CreateDirectory(filename);
    if (sample.TryGetProperty("parentFile", out var parentFile) && parentFile.GetBoolean()) { Directory.Delete(directory, true); File.WriteAllText(directory, "Retained parent file."); }
    var before = CollectionFolder.GetLibraryOptions(directory);
    var sameCachedBefore = ReferenceEquals(before, CollectionFolder.GetLibraryOptions(directory));
    LibraryOptions? requested = null;
    var events = new List<object>();
    EventHandler<LibraryOptionsUpdatedEventArgs> observer = (_, value) => {
        events.Add(new { path = value.LibraryPath, options = JsonSerializer.SerializeToElement(value.LibraryOptions, json), sameRequested = ReferenceEquals(requested, value.LibraryOptions) });
        if (sample.TryGetProperty("eventFailure", out var eventFailure) && eventFailure.GetBoolean()) throw new IOException("Controlled event failure.");
    };
    CollectionFolder.LibraryOptionsUpdated += observer;
    string? failureName = null;
    if (sample.TryGetProperty("options", out var options)) {
        requested = JsonSerializer.Deserialize<LibraryOptions>(options.GetRawText(), json)!;
        if (requested.PathInfos != null) foreach (var info in requested.PathInfos) if (info?.Path != null) info.Path = Map(info.Path);
        if (sample.TryGetProperty("missingDirectory", out var missing) && missing.GetBoolean()) Directory.Delete(directory, true);
        if (sample.TryGetProperty("readOnly", out var readOnly) && readOnly.GetBoolean()) { if (!File.Exists(filename)) File.WriteAllText(filename, "<LibraryOptions/>"); File.SetAttributes(filename, FileAttributes.ReadOnly); }
        try { CollectionFolder.SaveLibraryOptions(directory, requested); }
        catch (Exception error) { failureName = error.GetType().Name; }
    }
    CollectionFolder.LibraryOptionsUpdated -= observer;
    var cached = CollectionFolder.GetLibraryOptions(directory);
    byte[]? bytes = File.Exists(filename) ? File.ReadAllBytes(filename) : null;
    LibraryOptions? disk = null;
    string? diskFailure = null;
    if (bytes != null) try { disk = (LibraryOptions)serializer.DeserializeFromBytes(typeof(LibraryOptions), bytes)!; } catch (Exception error) { diskFailure = error.GetType().Name; }
    CollectionFolder.OnCollectionFolderChange();
    var reopened = CollectionFolder.GetLibraryOptions(directory);
    observations.Add(new { name, before, sameCachedBefore, requested, cached, sameRequested = ReferenceEquals(requested, cached),
        failure = failureName, reverseCalls, events, xml = bytes == null ? null : Convert.ToBase64String(bytes), disk, diskFailure, reopened });
    if (File.Exists(filename)) File.SetAttributes(filename, FileAttributes.Normal);
}
var assemblies = new[] { typeof(CollectionFolder).Assembly, typeof(MyXmlSerializer).Assembly, typeof(LibraryOptions).Assembly, typeof(object).Assembly }.Distinct()
    .Select(assembly => new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() });
File.WriteAllText(args[2], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(),
    actualCollectionFolder = true, actualXmlSerializer = true, realFiles = true, applicationHostControlled = true, observations, assemblies }, json));

public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? parameters) => Handler(method!, parameters);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
