// Records the pinned services' file-change BeforeSave and None refresh branches.
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.IO;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Movies;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true, WriteIndented = true };
json.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results = new List<object>();
foreach (var scenario in input.EnumerateArray()) {
    var calls = new List<object>();
    var config = DispatchProxy.Create<IServerConfigurationManager, ConfigurationProxy>();
    var configuration = (ConfigurationProxy)(object)config;
    configuration.Calls = calls;
    if (scenario.TryGetProperty("creationEnabled", out var creationEnabled)) configuration.Metadata.UseFileCreationTimeForDateAdded = creationEnabled.GetBoolean();
    BaseItem.ConfigurationManager = config;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.MediaSourceManager = DispatchProxy.Create<IMediaSourceManager, MediaSourceProxy>();
    Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
    var library = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
    ((LibraryProxy)(object)library).Calls = calls;
    BaseItem.LibraryManager = library;
    var fileSystem = DispatchProxy.Create<IFileSystem, FileSystemProxy>();
    var fs = (FileSystemProxy)(object)fileSystem;
    fs.Calls = calls;
    fs.File = JsonSerializer.Deserialize<FileSystemMetadata>(scenario.GetProperty("file").GetRawText(), json)!;
    fs.Throw = scenario.TryGetProperty("fileError", out var fileError) && fileError.GetBoolean();
    BaseItem.FileSystem = fileSystem;
    var external = DispatchProxy.Create<IExternalDataManager, ExternalProxy>();
    var externalProxy = (ExternalProxy)(object)external;
    externalProxy.Calls = calls;
    externalProxy.Throw = scenario.TryGetProperty("cleanupError", out var cleanupError) && cleanupError.GetBoolean();
    var repository = DispatchProxy.Create<IItemRepository, RepositoryProxy>();
    var definition = scenario.GetProperty("item");
    var itemType = BaseItemMapper.GetType(definition.GetProperty("Type").GetString()!)!;
    var item = (BaseItem)Activator.CreateInstance(itemType)!;
    foreach (var field in definition.EnumerateObject()) if (field.Name != "Type") {
        var property = itemType.GetProperty(field.Name)!;
        property.SetValue(item, JsonSerializer.Deserialize(field.Value.GetRawText(), property.PropertyType, json));
    }
    if (item is Folder folder) folder.Children = [];
    using var providers = new ProviderManager(null!, null!, config, null!, NullLogger<ProviderManager>.Instance,
        fileSystem, null!, library, null!, null!, null!, null!, null!);
    providers.AddParts([], [], [], [], [], []);
    var serviceName = itemType.Name switch { "MusicAlbum" => "Album", "MusicArtist" => "Artist", _ => itemType.Name } + "MetadataService";
    var serviceType = typeof(MovieMetadataService).Assembly.GetTypes().Single(type => type.Name == serviceName);
    var parameters = serviceType.GetConstructors().Single().GetParameters().Select(parameter => {
        if (parameter.ParameterType == typeof(IServerConfigurationManager)) return (object)config;
        if (parameter.ParameterType == typeof(IProviderManager)) return providers;
        if (parameter.ParameterType == typeof(IFileSystem)) return fileSystem;
        if (parameter.ParameterType == typeof(ILibraryManager)) return library;
        if (parameter.ParameterType == typeof(IExternalDataManager)) return external;
        if (parameter.ParameterType == typeof(IItemRepository)) return repository;
        if (parameter.ParameterType.IsGenericType && parameter.ParameterType.GetGenericTypeDefinition() == typeof(ILogger<>))
            return typeof(NullLogger<>).MakeGenericType(parameter.ParameterType.GenericTypeArguments).GetField("Instance")!.GetValue(null);
        return null;
    }).ToArray();
    var service = (IMetadataService)Activator.CreateInstance(serviceType, parameters)!;
    int? updateType = null;
    string? exception = null;
    try {
        if (scenario.GetProperty("mode").GetString() == "beforeSave") {
            updateType = (int)(ItemUpdateType)serviceType.GetMethod("BeforeSaveInternal", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(service,
                [item, scenario.GetProperty("full").GetBoolean(), (ItemUpdateType)scenario.GetProperty("currentUpdateType").GetInt32()])!;
        } else {
            var directory = DispatchProxy.Create<IDirectoryService, DirectoryProxy>();
            ((DirectoryProxy)(object)directory).FileSystem = fs;
            ((DirectoryProxy)(object)directory).Throw = scenario.TryGetProperty("directoryError", out var directoryError) && directoryError.GetBoolean();
            var options = new MetadataRefreshOptions(directory) { MetadataRefreshMode = MetadataRefreshMode.None,
                ImageRefreshMode = MetadataRefreshMode.None, ForceSave = scenario.TryGetProperty("force", out var force) && force.GetBoolean() };
            updateType = (int)await service.RefreshMetadata(item, options, CancellationToken.None);
        }
    } catch (Exception error) {
        exception = (error is TargetInvocationException ? error.InnerException! : error).GetType().Name;
        if (!scenario.TryGetProperty("expectException", out var expected) || exception != expected.GetString()) throw;
    }
    if (scenario.TryGetProperty("expectException", out _) && exception is null) throw new InvalidOperationException("Expected native exception was not raised.");
    results.Add(new { name = scenario.GetProperty("name").GetString(), updateType, exception, calls, item = Projection.Capture(item) });
}
var managed = (ManagedFileSystem)RuntimeHelpers.GetUninitializedObject(typeof(ManagedFileSystem));
var managedDirectory = managed.GetFileSystemInfo(Path.GetDirectoryName(Path.GetFullPath(args[1]))!);
var managedMissing = new[] { ".hidden", "file.mkv", "file.", "folder" }.Select(name => {
    var info = managed.GetFileSystemInfo(Path.Join(Path.GetDirectoryName(Path.GetFullPath(args[1]))!, "missing-file-controls", name));
    return new { name, info.Exists, info.IsDirectory, info.LastWriteTimeUtc, info.CreationTimeUtc, info.Length };
}).ToArray();
var nullDates = BaseItemMapper.Map(new BaseItemEntity { Id = Guid.Parse("D9777777-7777-7777-7777-777777777777"),
    Type = typeof(Movie).FullName!, Name = "Nullable date control" }, new Movie(), null);
var nullDateRow = BaseItemMapper.Map(nullDates, null!);
File.WriteAllText(args[1], JsonSerializer.Serialize(new { results, candidateVerified = false,
    managedDirectory = new { managedDirectory.Exists, managedDirectory.IsDirectory, managedDirectory.LastWriteTimeUtc, managedDirectory.CreationTimeUtc },
    managedMissing,
    mappedNullDates = new { nullDates.DateCreated, nullDates.DateModified, nullDates.DateLastRefreshed, nullDates.DateLastSaved },
    savedNullDates = new { nullDateRow.DateCreated, nullDateRow.DateModified, nullDateRow.DateLastRefreshed, nullDateRow.DateLastSaved },
    inputSha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(args[0]))).ToLowerInvariant(),
    boundary = "Actual typed MetadataService.BeforeSaveInternal and Movie/Audio/Folder/Album None RefreshMetadata with actual ProviderManager; actual ManagedFileSystem.GetFileSystemInfo reads the isolated output directory, and actual BaseItemMapper records nullable date hydration and saving. FileSystemMetadata, metadata configuration, empty child/repository results, File protocol callback, external-data callback and repository saves are controlled. Records one-second thresholds, creation gate, reason flags, mutation/cleanup/save order and failures. Album After sees empty artist arrays. ExternalDataManager internals, actual native SQL/NFO writes and media file operations are excluded." }, json));

public static class Projection {
    public static object Capture(BaseItem item) => new { item.Name, item.Path, item.DateModified, item.DateCreated, item.Size, item.PresentationUniqueKey };
}
public class ConfigurationProxy : DispatchProxy {
    public List<object> Calls = []; public MetadataConfiguration Metadata = new();
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "get_Configuration") return new ServerConfiguration { MetadataCountryCode = "US" };
        if (method.Name == "GetConfiguration" && (string)args![0]! == "metadata") { Calls.Add(new { phase = "configuration", enabled = Metadata.UseFileCreationTimeForDateAdded }); return Metadata; }
        if (method.Name is "add_ConfigurationUpdated" or "remove_ConfigurationUpdated") return null;
        throw new NotSupportedException(method.Name);
    }
}
public class FileSystemProxy : DispatchProxy {
    public List<object> Calls = []; public FileSystemMetadata File = new(); public bool Throw;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetFileSystemInfo") { Calls.Add(new { phase = "file" }); if (Throw) throw new IOException("Injected file metadata failure"); return File; }
        if (method.Name == "IsPathFile") return !((string)args![0]!).Contains("://", StringComparison.Ordinal);
        throw new NotSupportedException(method.Name);
    }
}
public class DirectoryProxy : DispatchProxy {
    public FileSystemProxy FileSystem = null!; public bool Throw;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "GetFileSystemEntry") { FileSystem.Calls.Add(new { phase = "directory" }); if (Throw) throw new IOException("Injected directory lookup failure"); return FileSystem.File; }
        throw new NotSupportedException(method.Name);
    }
}
public class ExternalProxy : DispatchProxy {
    public List<object> Calls = []; public bool Throw;
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        if (method!.Name == "DeleteExternalItemDataAsync") {
            Calls.Add(new { phase = "external", cancellable = ((CancellationToken)args![1]!).CanBeCanceled, item = Projection.Capture((BaseItem)args[0]!) });
            if (Throw) return Task.FromException(new IOException("Injected external-data failure"));
            return Task.CompletedTask;
        }
        throw new NotSupportedException(method.Name);
    }
}
public class LibraryProxy : DispatchProxy {
    public List<object> Calls = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name switch {
        "GetLibraryOptions" => new LibraryOptions { EnableAutomaticSeriesGrouping = false },
        "GetCollectionFolders" => new List<Folder>(), "GetItemById" => null, "GetItemList" => new List<BaseItem>(),
        "GetLocalAlternateVersionIds" => Array.Empty<Guid>(),
        "UpdateItemAsync" => Save((BaseItem)args![0]!, (ItemUpdateType)args[2]!), "ReattachUserDataAsync" => Task.CompletedTask,
        _ => throw new NotSupportedException(method.Name)
    };
    private Task Save(BaseItem item, ItemUpdateType reason) { Calls.Add(new { phase = "save", updateType = (int)reason, item = Projection.Capture(item) }); return Task.CompletedTask; }
}
public class RepositoryProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "ItemExistsAsync" ? Task.FromResult(true) : throw new NotSupportedException(method.Name);
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo" ? null : throw new NotSupportedException(method.Name);
}
public class MediaSourceProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetPathProtocol" ? MediaProtocol.File : throw new NotSupportedException(method.Name);
}
