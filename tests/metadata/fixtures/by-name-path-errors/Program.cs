// Actual null-path entity hooks; no repository or filesystem callbacks.
using System.Reflection;
using System.Text.Json;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
    "get_InternalMetadataPath" => @"D:\State\metadata", "get_PeoplePath" => @"D:\State\metadata\People", _ => Stub.Default(method.ReturnType)
});
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_ApplicationPaths" => paths, "get_Configuration" => new ServerConfiguration(), _ => Stub.Default(method.ReturnType)
});
BaseItem.Logger = NullLogger<BaseItem>.Instance;
var results = new List<object>();
foreach (var sample in JsonDocument.Parse(File.ReadAllText(args[0])).RootElement.EnumerateArray()) {
    var type = typeof(BaseItem).Assembly.GetTypes().Single(type => type.Name == sample.GetProperty("type").GetString() && typeof(BaseItem).IsAssignableFrom(type));
    var item = (BaseItem)Activator.CreateInstance(type)!;
    item.Name = type.Name; item.Path = null!;
    string? exception = null; bool? changed = null;
    try { changed = sample.GetProperty("mode").GetString() == "requires" ? item.RequiresRefresh() : item.BeforeMetadataRefresh(false); }
    catch (Exception error) { exception = error.GetType().Name; }
    results.Add(new { name = sample.GetProperty("name").GetString(), exception, changed, itemName = item.Name, item.Path });
}
var assembly = typeof(BaseItem).Assembly;
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualFrozenNullPathHooks = true, candidateVerified = false, results,
    assembly = new { name = assembly.GetName().Name, path = assembly.Location, sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() },
    scope = "Actual RequiresRefresh/BeforeMetadataRefresh on six by-name classes with null Path and nonempty Name. Application paths are controls. No EF, filesystem, metadata service or HTTP." }, new JsonSerializerOptions { WriteIndented = true }));
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? args) => Handler(method!, args);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T : class { var value = Create<T,Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type.IsValueType ? Activator.CreateInstance(type) : null;
}
