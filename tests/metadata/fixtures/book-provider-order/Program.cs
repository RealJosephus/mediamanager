using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Plugins;
using Jellyfin.Server;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Providers.Manager;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

var output = Path.GetFullPath(args[0]); Directory.CreateDirectory(output);
var host = (CoreAppHost)RuntimeHelpers.GetUninitializedObject(typeof(CoreAppHost));
var hostType = typeof(ApplicationHost);
hostType.GetField("<Logger>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(host, NullLogger<ApplicationHost>.Instance);
// There are deliberately no separately installed plugins. Native built-in
// assembly discovery and exported-type order remain unchanged.
using var plugins = new PluginManager(NullLogger<PluginManager>.Instance, host, new ServerConfiguration(), Path.Combine(output, "absent-plugins"), typeof(CoreAppHost).Assembly.GetName().Version!);
hostType.GetField("_pluginManager", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(host, plugins);
hostType.GetMethod("DiscoverTypes", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(host, null);
var assemblies = ((IEnumerable<Assembly>)hostType.GetMethod("GetComposablePartAssemblies", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(host, null)!).ToArray();
var fs = Stub.Make<IFileSystem>((method, values) => Stub.Default(method.ReturnType));
var services = new ServiceCollection(); services.AddLogging(); services.AddSingleton(fs);
using var serviceProvider = services.BuildServiceProvider(); host.ServiceProvider = serviceProvider;
var exports = host.GetExports<ILocalMetadataProvider<Book>>(false).ToArray();
if (exports.Length != 3) throw new InvalidOperationException("Unexpected built-in Book local provider inventory: " + exports.Length);
var observed = new List<object>();
foreach (var name in new[] { "default", "global-order", "library-order" }) {
    var metadataOptions = new MetadataOptions { ItemType = "Book", LocalMetadataReaderOrder = name == "global-order" ? ["Open Packaging Format"] : [] };
    var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name == "get_Configuration" ? new ServerConfiguration { MetadataOptions = [metadataOptions] } : Stub.Default(method.ReturnType));
    BaseItem.ConfigurationManager = config; BaseItem.FileSystem = fs;
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
    var libraryOptions = new LibraryOptions { LocalMetadataReaderOrder = name == "library-order" ? ["EPUB Metadata"] : null };
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name == "GetCollectionFolders" ? new List<Folder>() : method.Name == "GetLibraryOptions" ? libraryOptions : Stub.Default(method.ReturnType));
    BaseItem.LibraryManager = library;
    var manager = (ProviderManager)RuntimeHelpers.GetUninitializedObject(typeof(ProviderManager));
    foreach (var (field, value) in new (string, object)[] { ("_configurationManager", config), ("_libraryManager", library), ("_baseItemManager", new BaseItemManager(config)), ("_logger", NullLogger<ProviderManager>.Instance) })
        typeof(ProviderManager).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, value);
    var cache = typeof(ProviderManager).GetField("_metadataProviderCache", BindingFlags.Instance | BindingFlags.NonPublic)!;
    cache.SetValue(manager, Activator.CreateInstance(cache.FieldType));
    manager.AddParts([], [], exports, [], [], []);
    var book = new Book { Path = Path.Combine(output, "book.epub"), Name = "Book" };
    var providers = manager.GetMetadataProviders<Book>(book, libraryOptions).ToArray();
    observed.Add(new { name, providers = providers.Select(value => new { value.Name, type = value.GetType().FullName, defaultOrder = 50 }).ToArray() });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new { exports = exports.Select(value => new { value.Name, type = value.GetType().FullName }).ToArray(), observed,
    assemblies = assemblies.Select(assembly => new { name = assembly.GetName().Name, sha256 = Hash(File.ReadAllBytes(assembly.Location)) }).ToArray(),
    scope = "Actual CoreAppHost.GetComposablePartAssemblies/DiscoverTypes/GetExports<ILocalMetadataProvider<Book>> and ProviderManager.AddParts/GetMetadataProviders. Native built-in assembly/export order is retained, with no installed plugins. CoreAppHost is uninitialized except the native empty PluginManager/logger/DI needed by discovery; provider filesystem/logger dependencies are controlled and no readers run. This is not full server startup or externally installed plugin ordering." }, new JsonSerializerOptions { WriteIndented = true }) + "\n");
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
