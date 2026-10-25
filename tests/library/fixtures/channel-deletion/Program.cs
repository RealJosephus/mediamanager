using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Data;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Channels;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Channels;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

var nativeName = OperatingSystem.IsWindows() ? "e_sqlite3.dll" : OperatingSystem.IsMacOS() ? "libe_sqlite3.dylib" : "libe_sqlite3.so";
var nativeFile = Path.Combine(AppContext.BaseDirectory, nativeName); var nativeHandle = NativeLibrary.Load(nativeFile);
NativeLibrary.SetDllImportResolver(typeof(SQLitePCL.SQLite3Provider_e_sqlite3).Assembly, (name, _, _) => name == "e_sqlite3" ? nativeHandle : IntPtr.Zero);
SQLitePCL.Batteries_V2.Init();
var inputBytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(inputBytes).RootElement;
var root = Path.GetFullPath(args[2]); Directory.CreateDirectory(root);
Guid Id(string key) => Guid.Parse(input.GetProperty(key).GetString()!);
var status = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.Static | BindingFlags.NonPublic)!;
object Error(Exception error) {
    while (error is TargetInvocationException { InnerException: not null } target) error = target.InnerException;
    return new { type = error.GetType().Name, error.Message, status = (int)status.Invoke(null, [error])!, error.StackTrace };
}
object Observe(Func<object?> operation) { try { return new { value = operation() }; } catch (Exception error) { return new { failure = Error(error) }; } }
int ResponseStatus(ActionResult value) => value switch { StatusCodeResult result => result.StatusCode, ObjectResult result => result.StatusCode ?? 200, _ => 200 };
var results = new List<object>();
foreach (var lane in new[] { "permissions", "deletions" }) foreach (var sample in input.GetProperty(lane).EnumerateArray()) {
    var owned = Path.Combine(root, results.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)); Directory.CreateDirectory(owned);
    var calls = new List<object>(); var executing = false; LibraryManager? manager = null; BaseItem? target = null; User? user = null;
    var users = Stub.Make<IUserManager>((method, _) => method.Name == "GetUserById" ? user : Stub.Default(method.ReturnType));
    var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch {
        "get_ProgramDataPath" => owned, "get_RootFolderPath" => Path.Combine(owned, "root"), "get_DataPath" => Path.Combine(owned, "data"),
        "get_InternalMetadataPath" => Path.Combine(owned, "metadata"), "get_TrickplayPath" => Path.Combine(owned, "data", "trickplay"), _ => Stub.Default(method.ReturnType) });
    var configuration = new ServerConfiguration { CacheSize = 64, EnableCaseSensitiveItemIds = true };
    var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths, "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType) });
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name is "ExpandVirtualPath" or "ReverseVirtualPath" ? values![0] : Stub.Default(method.ReturnType));
    var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []); var directoryService = new DirectoryService(fileSystem);
    var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance); await localization.LoadAll();
    BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance; BaseItem.FileSystem = fileSystem; BaseItem.LocalizationManager = localization;
    Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo" ? null : throw new InvalidOperationException("Recording is forbidden."));
    BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name switch {
        "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => Array.Empty<MediaStream>(), "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(),
        "GetMediaAttachments" => Array.Empty<MediaAttachment>(), _ => Stub.Default(method.ReturnType) });
    var factory = new SqlFactory(Path.Combine(owned, "native.db")); using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance); BaseItem.ItemRepository = repository;
    var realPersistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);
    string source = Path.Combine(owned, "media", "target.bin"), internalMarker = "", externalMarker = Path.Combine(owned, "external", "marker");
    object State() {
        using var db = factory.CreateDbContext();
        return new { source = File.Exists(source), internalMetadata = File.Exists(internalMarker), externalMetadata = File.Exists(externalMarker),
            row = target is not null && db.BaseItems.Any(item => item.Id == target.Id), cached = target is not null && manager!.GetItemById(target.Id) is not null };
    }
    var persistence = Stub.Make<IItemPersistenceService>((method, values) => {
        if (executing && method.Name == "DeleteItem") calls.Add(new { kind = "persist", ids = ((IReadOnlyList<Guid>)values![0]!).Select(value => value.ToString("N")).ToArray(), state = State() });
        return Stub.Forward(realPersistence, method, values);
    });
    var externalData = Stub.Make<IExternalDataManager>((method, values) => {
        if (method.Name == "DeleteExternalItemFiles") {
            calls.Add(new { kind = "external", id = ((BaseItem)values![0]!).Id.ToString("N"), state = State() });
            if (File.Exists(externalMarker)) File.Delete(externalMarker);
        }
        return Stub.Default(method.ReturnType);
    });
    var providerManager = Stub.Make<IProviderManager>((method, _) => method.Name == "GetExternalUrls" ? Array.Empty<MediaBrowser.Model.Providers.ExternalUrl>() : Stub.Default(method.ReturnType));
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(), _ => Stub.Forward(manager!, method, values) });
    BaseItem.LibraryManager = library;
    manager = new LibraryManager(appHost, NullLoggerFactory.Instance, null!, users, config, null!, new(() => null!), fileSystem,
        new(() => providerManager), new(() => null!), repository, persistence, null!, null!, new LinkedChildrenService(factory, new ItemTypeLookup(), repository),
        Stub.Make<IImageProcessor>((method, _) => Stub.Default(method.ReturnType)), new Emby.Naming.Common.NamingOptions(), directoryService,
        null!, new PathManager(NullLogger<PathManager>.Instance, config, paths), new DotIgnoreIgnoreRule(), localization, null!, new(() => externalData));
    var userRoot = new UserRootFolder { Id = Id("userId"), Children = [] };
    typeof(LibraryManager).GetField("_userRootFolder", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(manager, userRoot);
    Guid ProviderId() => manager.GetNewItemId("Channel Supported", typeof(Channel));
    var referenceKind = Text(sample, "reference")!; BaseItem? reference = referenceKind == "missing" ? null
        : referenceKind == "wrong-type" ? new Audio { Id = ProviderId(), Name = "Supported" }
        : new Channel { Id = referenceKind == "wrong-identity" ? Id("missingId") : ProviderId(), Name = "Supported" };
    if (reference is not null) manager.CreateItem(reference, null);
    var parent = new Folder { Id = Id("parentId"), Path = Path.Combine(owned, "media"), Name = "Parent" }; Directory.CreateDirectory(parent.Path); manager.CreateItem(parent, null);
    target = Text(sample, "type") switch {
        "Video" => new Video(), "Folder" => new Folder { IsRoot = Flag(sample, "isRoot") }, "Channel" => new Channel(),
        "MusicArtist" => new MusicArtist(), "BoxSet" => new BoxSet(), "Playlist" => new Playlist { OwnerUserId = Id("userId"), OpenAccess = true }, _ => new Audio() };
    target.Id = Id("targetId"); target.Name = "Stored target"; target.Path = source; target.ParentId = parent.Id;
    target.ChannelId = referenceKind == "empty" ? Guid.Empty : reference?.Id ?? Id("missingId");
    target.ExternalId = sample.TryGetProperty("externalId", out var externalId) ? externalId.GetString() : "owned-external";
    if (target is Folder folder) folder.Children = [];
    File.WriteAllBytes(source, [1, 3, 5, 7]); manager.CreateItem(target, parent); parent.Children = [target]; parent.UserData = [];
    if (Flag(sample, "active")) Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo"
        ? new MediaBrowser.Controller.LiveTv.ActiveRecordingInfo() : throw new InvalidOperationException("Recording is forbidden."));
    using var cache = new MemoryCache(new MemoryCacheOptions());
    var providerKind = Text(sample, "provider");
    IChannel[] providers = providerKind switch {
        "empty" => [], "plain" => [new Provider(sample, calls)], "duplicate-plain-first" => [new Provider(sample, calls), new DeletionProvider(sample, calls)],
        _ => [new DeletionProvider(sample, calls)] };
    user = new User("channel-delete", "controlled", "controlled") { Id = Id("userId") };
    user.SetPermission(PermissionKind.EnableAllFolders, true); user.SetPermission(PermissionKind.EnableAllChannels, true);
    user.SetPermission(PermissionKind.EnableContentDeletion, Text(sample, "policy") == "content"); user.SetPermission(PermissionKind.IsAdministrator, Text(sample, "policy") == "admin");
    user.SetPermission(PermissionKind.EnableCollectionManagement, false);
    if (Text(sample, "policy") is "channel" or "wrong-folder") user.SetPreference(PreferenceKind.EnableContentDeletionFromFolders,
        [Text(sample, "policy") == "channel" ? target.ChannelId.ToString("N") : Id("missingId").ToString("N")]);
    var userData = Stub.Make<IUserDataManager>((method, values) => method.Name switch {
        "GetUserDataBatch" => ((IReadOnlyList<BaseItem>)values![0]!).ToDictionary(item => item.Id, item => new UserItemData { Key = item.GetUserDataKeys()[0] }),
        "GetResumeUserDataBatch" => new Dictionary<Guid, VersionResumeData>(), "GetUserData" => new UserItemData { Key = target.GetUserDataKeys()[0] }, _ => throw new InvalidOperationException("User-data writes are forbidden.") });
    using var channelManager = new ChannelManager(users, null!, library, NullLogger<ChannelManager>.Instance, config, fileSystem, userData, providerManager, cache, providers); BaseItem.ChannelManager = channelManager;
    var recordings = Video.RecordingsManager;
    var liveTv = Stub.Make<ILiveTvManager>((method, _) => method.Name == "AddInfoToRecordingDto" ? null : throw new InvalidOperationException("Live TV execution is forbidden."));
    var dto = new DtoService(NullLogger<DtoService>.Instance, library, userData, null!, providerManager, recordings, appHost, BaseItem.MediaSourceManager, new(() => liveTv), null!, null!);
    var selected = new DtoOptions { Fields = [ItemFields.CanDelete], EnableImages = false, EnableUserData = false };
    BaseItemEntity[] beforeRows;
    using (var beforeDatabase = factory.CreateDbContext()) beforeRows = beforeDatabase.BaseItems.AsNoTracking().ToArray();
    if (Text(sample, "warmName") is string warmName) target.Name = warmName;
    var targetWasCached = ReferenceEquals(manager.GetItemById(target.Id), target);
    internalMarker = Path.Combine(target.GetInternalMetadataPath(), "marker"); Directory.CreateDirectory(Path.GetDirectoryName(internalMarker)!); File.WriteAllText(internalMarker, "internal");
    Directory.CreateDirectory(Path.GetDirectoryName(externalMarker)!); File.WriteAllText(externalMarker, "external");
    manager.ItemRemoved += (_, change) => calls.Add(new { kind = "event", id = change.Item.Id.ToString("N"), parentId = change.Parent?.Id.ToString("N"), state = State() });
    calls.Clear();
    object? direct = null, precomputed = null, projected = null, projectedDetail = null, action = null; var before = State();
    if (lane == "permissions") {
        var withUser = Flag(sample, "user");
        direct = Observe(() => withUser ? target.CanDelete(user) : target.CanDelete());
        precomputed = Observe(() => withUser ? target.CanDelete(user, []) : target.CanDelete());
        projected = Observe(() => { var value = dto.GetBaseItemDtos([target], selected, withUser ? user : null, skipVisibilityCheck: true).Single(); return new { value.CanDelete, value.ChannelName }; });
        projectedDetail = Observe(() => { var value = dto.GetBaseItemDto(target, selected, withUser ? user : null); return new { value.CanDelete, value.ChannelName }; });
    } else {
        executing = true;
        action = Observe(() => {
            if (Flag(sample, "recordingController")) {
                var constructor = typeof(LiveTvController).GetConstructors().Single();
                var controller = (LiveTvController)constructor.Invoke(constructor.GetParameters().Select(parameter => parameter.ParameterType == typeof(ILibraryManager) ? (object)library
                    : parameter.ParameterType == typeof(IUserManager) ? users : null).ToArray());
                controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                    User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(InternalClaimTypes.UserId, user.Id.ToString("N")), new Claim(InternalClaimTypes.IsApiKey, "False")], "component")) } };
                var value = controller.DeleteRecording(target.Id); return new { status = ResponseStatus(value) };
            }
            if (Flag(sample, "controller")) {
                var controller = new LibraryController(providerManager, null!, library, users, null!, dto, null!, localization, null!, NullLogger<LibraryController>.Instance, config, null!);
                Claim[] actionClaims = Flag(sample, "userRequest")
                    ? [new Claim(InternalClaimTypes.UserId, user.Id.ToString("N")), new Claim(InternalClaimTypes.IsApiKey, "False")]
                    : [new Claim(InternalClaimTypes.IsApiKey, "True")];
                controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
                    User = new ClaimsPrincipal(new ClaimsIdentity(actionClaims, "component")) } };
                var value = Flag(sample, "batch") ? controller.DeleteItems([target.Id, Id("missingId")]) : controller.DeleteItem(target.Id);
                return new { status = ResponseStatus(value) };
            }
            var deletion = new DeleteOptions { DeleteFileLocation = true, DeleteFromExternalProvider = Flag(sample, "deleteFromExternalProvider") };
            manager.DeleteItem(target, deletion, parent, true); return new { deletion.DeleteFileLocation };
        });
    }
    using var final = factory.CreateDbContext();
    results.Add(new { name = Text(sample, "name"), lane, root = owned, providerId = ProviderId().ToString("N"), sourceType = target.SourceType.ToString(), beforeRows, targetWasCached, before, direct, precomputed, projected, projectedDetail, action,
        after = State(), calls, rows = final.BaseItems.AsNoTracking().Select(item => new { item.Id, item.Name, item.ParentId }).ToArray(),
        parentChildrenInvalidated = typeof(Folder).GetField("_children", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(parent) is null,
        parentUserDataInvalidated = parent.UserData is null });
}
var assemblies = new[] { typeof(ChannelManager).Assembly, typeof(LibraryManager).Assembly, typeof(BaseItem).Assembly, typeof(DtoService).Assembly,
    typeof(BaseItemRepository).Assembly, typeof(JellyfinDbContext).Assembly, typeof(ExceptionMiddleware).Assembly }.Distinct()
    .Select(value => new { filename = value.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(value.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualChannelManager = true,
    actualLibraryManagerDeletion = true, actualDtoService = true, actualEfPersistence = true, externalProviderControlled = true, mediaExecutionStarted = false,
    nativeLibraryControllerExecuted = true, activeRecordingAssociationControlled = true, assemblies,
    sqliteNative = new { filename = nativeFile, runtimeIdentifier = RuntimeInformation.RuntimeIdentifier, requiredPackagedImage = true, explicitResolver = true,
        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(nativeFile))) }, results }, new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never }));

static string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var field) ? field.GetString() : null;
static bool Flag(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.True;
public class Provider(JsonElement sample, List<object> calls) : IChannel {
    public string Name => "Supported"; public string Description => "Controlled deletion"; public string DataVersion => "component"; public string HomePageUrl => null!;
    public ChannelParentalRating ParentalRating => ChannelParentalRating.GeneralAudience;
    public InternalChannelFeatures GetChannelFeatures() => new(); public bool IsEnabledFor(string userId) => true;
    public Task<ChannelItemResult> GetChannelItems(InternalChannelItemQuery query, CancellationToken token) => throw new InvalidOperationException("Catalog execution is forbidden.");
    public Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken token) => Task.FromResult(new DynamicImageResponse { HasImage = false });
    public IEnumerable<ImageType> GetSupportedChannelImages() => [];
}
public class DeletionProvider(JsonElement sample, List<object> calls) : Provider(sample, calls), ISupportsDelete {
    public bool CanDelete(BaseItem item) {
        calls.Add(new Dictionary<string, object?> {
            ["kind"] = "canDelete", ["name"] = Name, ["id"] = item.Id.ToString("N"), ["Name"] = item.Name, ["ExternalId"] = item.ExternalId });
        var result = sample.GetProperty("result"); if (result.ValueKind == JsonValueKind.String) throw new InvalidOperationException("Controlled permission failure.");
        return result.GetBoolean();
    }
    public Task DeleteItem(string id, CancellationToken token) {
        calls.Add(new { kind = "delete", name = Name, externalId = id, canBeCanceled = token.CanBeCanceled });
        return sample.GetProperty("outcome").GetString() switch {
            "argument" => Task.FromException(new ArgumentException("Controlled provider argument.")),
            "argument-null" => Task.FromException(new ArgumentNullException("externalId")),
            "io" => Task.FromException(new IOException("Controlled provider I/O failure.")),
            "failure" => Task.FromException(new InvalidOperationException("Controlled provider failure.")), _ => Task.CompletedTask };
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) { try { return method.Invoke(target, values); } catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; } }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
