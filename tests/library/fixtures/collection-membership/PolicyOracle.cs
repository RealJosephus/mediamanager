using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.IO;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Serialization;

var id = (int index) => Guid.Parse("83000000-0000-0000-0000-" + index.ToString("D12"));
var aggregate = new AggregateFolder { Id = id(1), Path = "Z:\\" };
var root = new UserRootFolder { Id = id(2), Path = "D:\\unused-instance\\root\\default" };
var physical = new Folder { Id = id(3), ParentId = aggregate.Id, Path = "Z:\\Movies" };
var collection = new CollectionFolder { Id = id(4), ParentId = root.Id,
    Path = "D:\\unused-instance\\root\\default\\Movies", PhysicalLocationsList = [physical.Path], PhysicalFolderIds = [] };
var movie = new Movie { Id = id(5), ParentId = physical.Id, Path = "Z:\\Movies\\feature.mkv" };
root.Children = [collection];
var items = new BaseItem[] { aggregate, root, physical, collection, movie }.ToDictionary(item => item.Id);
var realManager = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
var proxy = DispatchProxy.Create<ILibraryManager, LibraryProxy>();
var implementation = (LibraryProxy)(object)proxy;
implementation.Items = items;
implementation.Root = root;
implementation.Real = realManager;
BaseItem.LibraryManager = proxy;
CollectionFolder.XmlSerializer = DispatchProxy.Create<IXmlSerializer, XmlProxy>();
Video.RecordingsManager = DispatchProxy.Create<IRecordingsManager, RecordingsProxy>();
var sources = (MediaSourceManager)RuntimeHelpers.GetUninitializedObject(typeof(MediaSourceManager));
typeof(MediaSourceManager).GetField("_fileSystem", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(sources,
    RuntimeHelpers.GetUninitializedObject(typeof(ManagedFileSystem)));
BaseItem.MediaSourceManager = sources;
var results = new List<object>();
foreach (var pathMode in new[] { "matching-path", "unrelated-path" }) {
    collection.PhysicalLocationsList = [pathMode == "matching-path" ? physical.Path : "Z:\\OtherMovies"];
foreach (var storedMode in new[] { "path-only", "matching-physical-id", "unrelated-physical-id" }) {
    collection.PhysicalFolderIds = storedMode switch { "matching-physical-id" => [physical.Id], "unrelated-physical-id" => [id(98)], _ => [] };
    foreach (var policy in new[] { "all-folders", "enabled-library", "blocked-library", "blocked-unrelated", "blocked-library-tag" }) {
        var user = new User("Readonly", "OracleAuthentication", "OraclePasswordReset") { Id = id(6) };
        user.SetPermission(PermissionKind.EnableAllFolders, policy is "all-folders" or "blocked-library-tag");
        user.SetPermission(PermissionKind.EnableContentDeletion, false);
        user.SetPreference(PreferenceKind.EnableContentDeletionFromFolders, new[] { collection.Id });
        user.SetPreference(PreferenceKind.EnabledFolders, policy == "enabled-library" ? new[] { collection.Id } : Array.Empty<Guid>());
        user.SetPreference(PreferenceKind.BlockedMediaFolders, policy switch { "blocked-library" => [collection.Id], "blocked-unrelated" => [id(99)], _ => Array.Empty<Guid>() });
        collection.Tags = policy == "blocked-library-tag" ? ["blocked-library"] : Array.Empty<string>();
        user.SetPreference(PreferenceKind.BlockedTags, policy == "blocked-library-tag" ? ["blocked-library"] : Array.Empty<string>());
        user.SetPreference(PreferenceKind.AllowedTags, Array.Empty<string>());
        user.SetPreference(PreferenceKind.BlockUnratedItems, Array.Empty<string>());
        results.Add(new { pathMode, storedMode, policy, physicalLocations = collection.PhysicalLocationsList, physicalFolderIds = collection.PhysicalFolderIds,
            collectionFolders = realManager.GetCollectionFolders(movie, root.Children.OfType<Folder>()).Select(item => item.Id).ToArray(),
            inheritedTags = movie.GetInheritedTags(), parents = movie.GetParents().Select(item => item.Id).ToArray(),
            collectionVisible = collection.IsVisible(user), itemVisible = movie.IsVisible(user),
            itemVisibleStandalone = movie.IsVisibleStandalone(user), canDelete = movie.CanDelete(user, root.Children.OfType<Folder>().ToList()) });
    }
}
}
File.WriteAllText(args[0], JsonSerializer.Serialize(new { results, runtime = RuntimeInformation.FrameworkDescription,
    processId = Environment.ProcessId,
    assemblies = new[] { typeof(LibraryManager).Assembly, typeof(BaseItem).Assembly, typeof(LibraryOptions).Assembly,
        typeof(User).Assembly, typeof(object).Assembly, typeof(Enumerable).Assembly }.Distinct().Select(assembly => new {
        name = assembly.GetName().Name, version = assembly.GetName().Version?.ToString(), path = assembly.Location,
        sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant() }).ToArray(),
    sourceBoundary = "Actual frozen LibraryManager.GetCollectionFolders(item,allUserRootChildren) and its private GetCollectionFoldersInternal run unmodified. Actual MediaSourceManager.GetPathProtocol delegates to actual ManagedFileSystem.IsPathFile. DispatchProxy only provides entity lookup/user root and delegates membership to that actual method; XML serializer returns default enabled options; recordings manager returns no active recording. Uninitialized managers are used only for methods whose relevant fields are supplied or unused. No path-match, visibility, deletion or inherited-tag result is mocked.",
    libraryCalls = implementation.Calls, phaseAcceptance = false }, new JsonSerializerOptions { WriteIndented = true }));

public class LibraryProxy : DispatchProxy {
    public Dictionary<Guid, BaseItem> Items = null!;
    public UserRootFolder Root = null!;
    public LibraryManager Real = null!;
    public Dictionary<string,int> Calls = [];
    protected override object? Invoke(MethodInfo? method, object?[]? args) {
        var name = method!.Name;
        Calls[name] = Calls.GetValueOrDefault(name) + 1;
        return name switch {
            "GetItemById" => Items.GetValueOrDefault((Guid)args![0]!),
            "GetUserRootFolder" => Root,
            "GetCollectionFolders" => Real.GetCollectionFolders((BaseItem)args![0]!, args.Length > 1 ? (IEnumerable<Folder>)args[1]! : Root.Children.OfType<Folder>()),
            "GetLibraryOptions" => new LibraryOptions(),
            _ => throw new NotSupportedException("Unexpected library call: " + name)
        };
    }
}
public class XmlProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "DeserializeFromFile"
        ? new LibraryOptions() : throw new NotSupportedException(method.Name);
}
public class RecordingsProxy : DispatchProxy {
    protected override object? Invoke(MethodInfo? method, object?[]? args) => method!.Name == "GetActiveRecordingInfo"
        ? null : throw new NotSupportedException(method.Name);
}
