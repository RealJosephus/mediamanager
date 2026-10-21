using System.Globalization;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Encodings.Web;
using Jellyfin.Api.Auth.DefaultAuthorizationPolicy;
using Jellyfin.Server.Extensions;
using MediaBrowser.Common.Net;
using Emby.Server.Implementations.Chapters;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Sorting;
using Jellyfin.Api.Constants;
using Jellyfin.Api.Controllers;
using Jellyfin.Api.Middleware;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Extensions.Json;
using Jellyfin.LiveTv.Channels;
using Jellyfin.Drawing;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Channels;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Channels;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Library;
using MediaBrowser.Model.Querying;
using MediaBrowser.Model.Providers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.ApplicationParts;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
var inputBytes = File.ReadAllBytes(args[0]); var input = JsonDocument.Parse(inputBytes).RootElement;
var root = Path.GetFullPath(args[2]); Directory.CreateDirectory(root);
var options = new JsonSerializerOptions(JsonDefaults.Options) { DefaultIgnoreCondition = JsonIgnoreCondition.Never };
var status = typeof(ExceptionMiddleware).GetMethod("GetStatusCode", BindingFlags.Static | BindingFlags.NonPublic)!;
object Error(Exception error) {
    while (error is TargetInvocationException { InnerException: not null } target) error = target.InnerException;
    return new { type = error.GetType().Name, error.Message, status = (int)status.Invoke(null, [error])!, error.StackTrace };
}
async Task<object> Observe(Func<Task<object?>> operation) { try { return new { value = await operation() }; } catch (Exception error) { return new { failure = Error(error) }; } }
object Sync(Func<object?> operation) { try { return new { value = operation() }; } catch (Exception error) { return new { failure = Error(error) }; } }
void Set(object value, string name, object member) => value.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(value, member);
string? Text(JsonElement value, string name) => value.TryGetProperty(name, out var field) ? field.GetString() : null;
Guid userId = Guid.Parse(input.GetProperty("userId").GetString()!);
string metadataPath = root;
var paths = Stub.Make<IServerApplicationPaths>((method, _) => method.Name switch { "get_ProgramDataPath" => root,
    "get_InternalMetadataPath" => metadataPath, "get_DataPath" => Path.Combine(root, "data"), _ => Stub.Default(method.ReturnType) });
var configuration = new ServerConfiguration { EnableFolderView = false, MetadataCountryCode = "US", EnableCaseSensitiveItemIds = true };
var config = Stub.Make<IServerConfigurationManager>((method, _) => method.Name switch {
    "get_Configuration" => configuration, "get_ApplicationPaths" or "get_CommonApplicationPaths" => paths, _ => Stub.Default(method.ReturnType) });
var appHost = Stub.Make<IServerApplicationHost>((method, values) => method.Name switch {
    "get_SystemId" => "metadata-children", "ExpandVirtualPath" or "ReverseVirtualPath" => values![0], _ => Stub.Default(method.ReturnType) });
var identity = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager)); Set(identity, "_configurationManager", config);
identity.AddParts([], [], [], [new SortNameComparer()], []);
Guid Identity(string name) => identity.GetNewItemId("Channel " + name, typeof(Channel));
var localization = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance); await localization.LoadAll();
var fileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
using var imageProcessor = new ImageProcessor(NullLogger<ImageProcessor>.Instance, paths, fileSystem,
    Stub.Make<IImageEncoder>((method, _) => throw new InvalidOperationException("Image encoding is outside this catalog component.")), config);
BaseItem.ConfigurationManager = config; BaseItem.Logger = NullLogger<BaseItem>.Instance; BaseItem.FileSystem = fileSystem; BaseItem.LocalizationManager = localization;
var results = new List<object>(); var displayResults = new List<object>(); var imageResults = new List<object>(); object? httpResults = null;
foreach (var sample in input.GetProperty("cases").EnumerateArray()) {
    var name = Text(sample, "name"); metadataPath = Path.Combine(root, results.Count.ToString(CultureInfo.InvariantCulture), "metadata");
    var calls = new List<object>(); var creates = new List<object>(); var refreshes = new List<object>();
    var entities = new Dictionary<Guid, BaseItem>(); var stored = new Dictionary<Guid, BaseItemEntity>();
    IChannel[] providers = sample.GetProperty("providers").EnumerateArray().Select(value => Provider.Make(value, calls)).ToArray();
    foreach (var seed in sample.GetProperty("seeds").EnumerateArray()) {
        var id = seed.TryGetProperty("Id", out var supplied) ? Guid.Parse(supplied.GetString()!) : Identity(Text(seed, "providerName")!);
        var item = new Channel { Id = id, ChannelId = seed.TryGetProperty("ChannelId", out var channelId) ? Guid.Parse(channelId.GetString()!) : id,
            Name = Text(seed, "Name"), ForcedSortName = Text(seed, "ForcedSortName"), Overview = Text(seed, "Overview"),
            Tags = seed.TryGetProperty("Tags", out var tags) ? tags.EnumerateArray().Select(value => value.GetString()!).ToArray() : [],
            DateCreated = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc) };
        stored[id] = BaseItemMapper.Map(item, appHost); entities[id] = BaseItemMapper.DeserializeBaseItem(stored[id], NullLogger.Instance, appHost)!;
        if (seed.TryGetProperty("WarmName", out var warmName)) entities[id].Name = warmName.GetString();
        if (seed.TryGetProperty("WarmImage", out var warmImage) && warmImage.GetBoolean()) entities[id].ImageInfos = [new ItemImageInfo { Type = ImageType.Primary,
            Path = Path.Combine(metadataPath, "warm.png"), DateModified = new DateTime(2026, 10, 21, 1, 2, 3, DateTimeKind.Utc), Width = 64, Height = 32 }];
    }
    var beforeRows = stored.Values.ToArray();
    var user = new User("channel-catalog", "controlled", "controlled") { Id = userId };
    user.Permissions.Add(new Permission(PermissionKind.EnableAllChannels, true)); user.Permissions.Add(new Permission(PermissionKind.EnableAllFolders, true));
    if (sample.TryGetProperty("policy", out var policy)) foreach (var property in policy.EnumerateObject()) {
        if (property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False) {
            var kind = Enum.Parse<PermissionKind>(property.Name); foreach (var old in user.Permissions.Where(value => value.Kind == kind).ToArray()) user.Permissions.Remove(old);
            user.Permissions.Add(new Permission(kind, property.Value.GetBoolean()));
        } else {
            var key = property.Name.Replace("ProviderNames", "Channels");
            user.SetPreference(Enum.Parse<PreferenceKind>(key), property.Value.EnumerateArray().Select(value => property.Name.EndsWith("ProviderNames", StringComparison.Ordinal)
                ? Identity(value.GetString()!).ToString("D") : value.GetString()!).ToArray());
        }
    }
    bool hasUser = sample.GetProperty("user").GetBoolean();
    var userManager = Stub.Make<IUserManager>((method, values) => method.Name == "GetUserById" ? (Guid)values![0]! == userId ? user : null : Stub.Default(method.ReturnType));
    var rootFolder = new UserRootFolder { Id = Guid.Parse("cf100000000000000000000000000099"), Name = "User root", Children = [] };
    var aggregateRoot = new AggregateFolder { Id = Guid.Parse("cf100000000000000000000000000098"), Name = "Root", Children = [] };
    var data = new Dictionary<Guid, UserItemData>();
    UserItemData Data(BaseItem item) => data.TryGetValue(item.Id, out var value) ? value : data[item.Id] = new UserItemData { Key = item.GetUserDataKeys()[0], IsFavorite = item.Id == (Text(sample, "favoriteProvider") is string favorite ? Identity(favorite) : Guid.Empty) };
    var userData = Stub.Make<IUserDataManager>((method, values) => method.Name switch {
        "GetUserData" => values![0] is null ? throw new ArgumentNullException("user") : Data((BaseItem)values[1]!),
        "GetUserDataBatch" => ((IReadOnlyList<BaseItem>)values![0]!).ToDictionary(item => item.Id, Data),
        "GetResumeUserDataBatch" => new Dictionary<Guid, VersionResumeData>(), _ => throw new InvalidOperationException("User data writes are forbidden: " + method.Name) });
    var providerManager = Stub.Make<IProviderManager>((method, values) => {
        if (method.Name == "RefreshSingleItem") { var item = (BaseItem)values![0]!; var refresh = (MetadataRefreshOptions)values[1]!;
            refreshes.Add(new { id = item.Id.ToString("N"), refresh.ForceSave }); return Task.FromResult(ItemUpdateType.None); }
        if (method.Name == "GetExternalUrls") return Array.Empty<ExternalUrl>();
        return Stub.Default(method.ReturnType);
    });
    ILibraryManager? library = null;
    library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "GetItemById") {
            Guid id = values![0] is Guid value ? value : Guid.Parse((string)values[0]!);
            if (id == Guid.Empty) throw new ArgumentException("Guid can't be empty", "id");
            return entities.GetValueOrDefault(id);
        }
        if (method.Name == "CreateItem") { var item = (BaseItem)values![0]!; creates.Add(new { id = item.Id.ToString("N"), item.Name, item.Path, channelId = item.ChannelId.ToString("N"), parentId = item.ParentId.ToString("N"), item.Overview, item.OfficialRating });
            stored[item.Id] = BaseItemMapper.Map(item, appHost); entities[item.Id] = item; return null; }
        if (method.Name == "GetItemIds") {
            var query = (InternalItemsQuery)values![0]!;
            if (!query.IncludeItemTypes.SequenceEqual(new[] { BaseItemKind.Channel }) || !query.OrderBy.SequenceEqual(new[] { (ItemSortBy.SortName, SortOrder.Ascending) })) throw new InvalidOperationException("Unexpected Features repository query.");
            return stored.Values.Where(item => item.Type == typeof(Channel).FullName).OrderBy(item => item.SortName, StringComparer.OrdinalIgnoreCase).ThenBy(item => item.Name, StringComparer.Ordinal).Select(item => item.Id).ToArray();
        }
        if (method.Name == "Sort") return method.Invoke(identity, values);
        return method.Name switch {
            "GetNewItemId" => identity.GetNewItemId((string)values![0]!, (Type)values[1]!), "GetUserRootFolder" => rootFolder, "get_RootFolder" => aggregateRoot,
            "GetCollectionFolders" => new List<Folder>(), "GetLibraryOptions" => new LibraryOptions(), "GetPathAfterNetworkSubstitution" => values![0],
            "GetPeopleByItems" => new Dictionary<Guid, IReadOnlyList<PersonInfo>>(), "GetPeople" => new List<PersonInfo>(),
            "GetChildCountBatch" => ((IReadOnlyList<Guid>)values![0]!).ToDictionary(id => id, _ => 0),
            "GetPlayedAndTotalCountBatch" => new Dictionary<Guid, (int Played, int Total)>(),
            "GetCount" => 0, "GetItemList" => Array.Empty<BaseItem>(), "GetItemIdsWithAlternateVersions" => new HashSet<Guid>(),
            _ => throw new InvalidOperationException("Unexpected readonly library dependency: " + method.Name)
        };
    });
    BaseItem.LibraryManager = library; BaseItem.ProviderManager = providerManager;
    var recordings = Stub.Make<IRecordingsManager>((method, _) => method.Name == "GetActiveRecordingInfo" ? null : throw new InvalidOperationException("Recording is forbidden.")); Video.RecordingsManager = recordings;
    using var mediaSourceManager = new MediaSourceManager(appHost, null!, paths, localization, userManager, library,
        NullLogger<MediaSourceManager>.Instance, fileSystem, userData, null!, new DirectoryService(fileSystem), null!, null!);
    BaseItem.MediaSourceManager = mediaSourceManager;
    var chapterRepository = Stub.Make<IChapterRepository>((method, _) => method.Name == "GetChapters" ? Array.Empty<ChapterInfo>()
        : throw new InvalidOperationException("Chapter writes and image generation are forbidden: " + method.Name));
    var chapterManager = new ChapterManager(NullLogger<ChapterManager>.Instance, fileSystem, null!, chapterRepository, library, null!);
    var dtoService = new DtoService(NullLogger<DtoService>.Instance, library, userData, imageProcessor, providerManager, recordings, appHost, mediaSourceManager, null!, null!, chapterManager);
    using var cache = new MemoryCache(new MemoryCacheOptions());
    using var manager = new ChannelManager(userManager, dtoService, library, NullLogger<ChannelManager>.Instance, config, fileSystem, userData, providerManager, cache, providers); BaseItem.ChannelManager = manager;
    var controller = new ChannelsController(manager, userManager) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
        User = new ClaimsPrincipal(new ClaimsIdentity([new Claim(InternalClaimTypes.UserId, userId.ToString("N")), new Claim(ClaimTypes.Role, UserRoles.Administrator)], "component")) } } };
    var query = sample.GetProperty("query").Deserialize<ChannelQuery>(JsonDefaults.Options)!; query.UserId = hasUser ? userId : Guid.Empty;
    var internalResult = await Observe(async () => { var value = await manager.GetChannelsInternalAsync(query); return new { Items = value.Items.Select(item => new { Id = item.Id.ToString("N"), item.Name, item.SortName }).ToArray(), value.TotalRecordCount, value.StartIndex }; });
    var catalog = await Observe(async () => { var value = await manager.GetChannelsAsync(query); return new { Items = value.Items.Select(item => Project(item, input.GetProperty("dtoFields"))).ToArray(), value.TotalRecordCount, value.StartIndex }; });
    var allFeatures = Sync(() => controller.GetAllChannelFeatures().Value);
    var scalarId = sample.TryGetProperty("featureId", out var scalar) ? Guid.Parse(scalar.GetString()!) : providers.Length == 0 ? (Guid?)null : Identity(providers[0].Name);
    var feature = scalarId.HasValue ? Sync(() => controller.GetChannelFeatures(scalarId.Value).Value) : null;
    var liveTv = Stub.Make<ILiveTvManager>((method, _) => method.Name == "IsEnabledForUser" ? false : throw new InvalidOperationException("Live TV cannot execute."));
    var viewManager = new UserViewManager(library, localization, manager, liveTv, config);
    var views = Sync(() => dtoService.GetBaseItemDtos(viewManager.GetUserViews(new UserViewQuery { User = user, IncludeExternalContent = true }), new DtoOptions(), user, skipVisibilityCheck: true)
        .Select(item => new { Id = item.Id.ToString("N"), item.Name }).ToArray());
    if (results.Count == 0) httpResults = await HttpObservation(manager, userManager, config, input.GetProperty("httpCases"));
    results.Add(new { name, metadataPath, beforeRows, afterRows = entities.Values.Select(item => BaseItemMapper.Map(item, appHost)).ToArray(),
        internalResult, catalog, allFeatures, feature, views, creates, refreshes, calls, userData = data.Select(pair => new { id = pair.Key.ToString("N"), pair.Value.Key, pair.Value.IsFavorite }),
        identities = providers.Select(provider => new { name = provider.Name, id = Identity(provider.Name).ToString("N") }) });
}
foreach (var sample in input.GetProperty("displayCases").EnumerateArray()) {
    var providers = sample.GetProperty("providers").EnumerateArray().Select(value => Provider.Make(value, [])).ToArray(); var reference = Text(sample, "reference");
    var channel = reference == "missing" ? null : new Channel { Id = reference == "provider" ? Identity("Only") : Guid.Parse(input.GetProperty("orphanId").GetString()!), Name = "Only" };
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name == "GetItemById"
        ? (Guid)values![0]! == Guid.Empty ? throw new ArgumentException("Guid can't be empty", "id") : channel
        : method.Name == "GetNewItemId" ? identity.GetNewItemId((string)values![0]!, (Type)values[1]!) : Stub.Default(method.ReturnType));
    using var cache = new MemoryCache(new MemoryCacheOptions());
    using var manager = new ChannelManager(null!, null!, library, NullLogger<ChannelManager>.Instance, config, fileSystem, null!, null!, cache, providers);
    BaseItem item = reference == "empty" ? new Channel() : new Video(); item.Id = Guid.Parse(input.GetProperty("missingId").GetString()!);
    item.ChannelId = reference == "empty" ? Guid.Empty : channel?.Id ?? Guid.Parse(input.GetProperty("missingId").GetString()!);
    BaseItem.ChannelManager = manager; displayResults.Add(new { name = Text(sample, "name"), channelId = item.ChannelId.ToString("N"), channel = channel is null ? null : new { Id = channel.Id.ToString("N"), channel.Name }, result = Sync(() => item.EnableMediaSourceDisplay) });
}
metadataPath = Path.Combine(root, "images", "metadata");
foreach (var sample in input.GetProperty("imageCases").EnumerateArray()) {
    var calls = new List<object>(); var disposed = 0; var imageBytes = Convert.FromBase64String(input.GetProperty("imageBase64").GetString()!);
    var declaration = JsonSerializer.SerializeToElement(new { name = "Images", kind = "plain", features = new { } });
    var provider = new OwnedImageProvider(declaration, calls, sample.GetProperty("supportedImages").EnumerateArray().Select(value => Enum.Parse<ImageType>(value.GetString()!)).ToArray(), imageBytes, () => disposed++);
    var channel = new Channel { Id = Identity("Images"), ChannelId = Identity("Images"), Name = "Images", ImageInfos = sample.GetProperty("existing").EnumerateArray().Select(value => new ItemImageInfo { Type = Enum.Parse<ImageType>(value.GetString()!), Path = "controlled", Width = 64, Height = 32 }).ToArray() };
    var library = Stub.Make<ILibraryManager>((method, values) => method.Name == "GetItemById" ? channel
        : method.Name == "GetNewItemId" ? identity.GetNewItemId((string)values![0]!, (Type)values[1]!) : Stub.Default(method.ReturnType));
    using var cache = new MemoryCache(new MemoryCacheOptions());
    using var manager = new ChannelManager(null!, null!, library, NullLogger<ChannelManager>.Instance, config, fileSystem, null!, null!, cache, [provider]);
    var images = new ChannelImageProvider(manager); var types = images.GetSupportedImages(channel).ToArray();
    var changed = images.HasChanged(channel, new DirectoryService(fileSystem)); var sources = new List<object>();
    foreach (var type in types) {
        var response = await images.GetImage(channel, type, CancellationToken.None);
        using (response.Stream) { using var copy = new MemoryStream(); await response.Stream.CopyToAsync(copy); sources.Add(new { type = type.ToString(), sha256 = Convert.ToHexStringLower(SHA256.HashData(copy.ToArray())), mimeType = "image/png", response.HasImage }); }
    }
    imageResults.Add(new { name = sample.GetProperty("name").GetString(), id = channel.Id.ToString("N"), metadataPath, internalPath = channel.GetInternalMetadataPath(), supported = types, changed, sources, disposed, calls });
}
var assemblies = new[] { typeof(ChannelManager).Assembly, typeof(Channel).Assembly, typeof(ChannelsController).Assembly, typeof(DtoService).Assembly, typeof(BaseItemMapper).Assembly, typeof(ImageProcessor).Assembly, typeof(User).Assembly, typeof(BaseItemEntity).Assembly, typeof(JsonDefaults).Assembly }.Distinct().Select(assembly => new { filename = assembly.Location, sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(assembly.Location))) });
File.WriteAllText(args[1], JsonSerializer.Serialize(new { inputSha256 = Convert.ToHexStringLower(SHA256.HashData(inputBytes)), actualChannelManager = true, actualChannelsController = true,
    actualDtoService = true, actualUserViewManager = true, actualLibraryIdentityAndViewSorter = true, nativeLibraryLookupAndPersistenceControlled = true,
    actualChapterManager = true, actualMediaSourcePathProtocol = true, configuration.EnableCaseSensitiveItemIds,
    nativeDatabaseOpened = false, nativeMvcBindingExecuted = true, actualChannelImageProvider = true, mediaExecutionStarted = false, results, displayResults, imageResults, httpResults, assemblies }, options));

static object Project(BaseItemDto item, JsonElement fields) => fields.EnumerateArray().ToDictionary(field => field.GetString()!, field => {
    var name = field.GetString()!; object? value = typeof(BaseItemDto).GetProperty(name)!.GetValue(item);
    return value is Guid id ? (object)id.ToString("N") : value;
});

static async Task<object> HttpObservation(IChannelManager manager, IUserManager users, IServerConfigurationManager config, JsonElement input) {
    var diagnostics = new List<object>();
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
    builder.Logging.ClearProviders(); builder.Logging.AddProvider(new DiagnosticProvider(diagnostics)); builder.WebHost.UseUrls("http://127.0.0.1:0");
    builder.Services.AddSingleton(manager); builder.Services.AddSingleton(users); builder.Services.AddSingleton(config); builder.Services.AddHttpContextAccessor();
    builder.Services.AddSingleton(Stub.Make<INetworkManager>((method, _) => method.Name == "IsInLocalNetwork" ? true : Stub.Default(method.ReturnType)));
    builder.Services.AddSingleton<IAuthorizationHandler, DefaultAuthorizationHandler>();
    builder.Services.AddAuthentication("fixture").AddScheme<AuthenticationSchemeOptions, ChannelAuthentication>("fixture", _ => { });
    builder.Services.AddAuthorization(value => value.DefaultPolicy = new AuthorizationPolicyBuilder("fixture").AddRequirements(new DefaultAuthorizationRequirement()).Build());
    builder.Services.AddJellyfinApi([], new NetworkConfiguration()).ConfigureApplicationPartManager(value => value.FeatureProviders.Add(new OnlyChannelController()));
    var app = builder.Build(); var observations = new List<object>(); using var client = new HttpClient();
    try {
        app.UseMiddleware<ExceptionMiddleware>(); app.UseAuthentication(); app.UseAuthorization(); app.MapControllers(); await app.StartAsync();
        var address = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.Single();
        foreach (var sample in input.EnumerateArray()) {
            diagnostics.Clear(); using var request = new HttpRequestMessage(HttpMethod.Get, address + sample.GetProperty("path").GetString());
            request.Headers.TryAddWithoutValidation("Accept", "application/json"); request.Headers.TryAddWithoutValidation("X-Identity", sample.TryGetProperty("identity", out var identity) ? identity.GetString() : "admin");
            using var response = await client.SendAsync(request); var body = await response.Content.ReadAsStringAsync(); JsonElement? json = null;
            try { json = JsonSerializer.Deserialize<JsonElement>(body); } catch (JsonException) { }
            observations.Add(new { name = sample.GetProperty("name").GetString(), path = sample.GetProperty("path").GetString(), status = (int)response.StatusCode,
                body, json, contentType = response.Content.Headers.ContentType?.ToString(), diagnostics = diagnostics.ToArray() });
        }
    } finally { try { await app.StopAsync(); } finally { await app.DisposeAsync(); } }
    return new { observations, actualMvc = true, hostStopped = true, hostDisposed = true };
}

public class Provider(JsonElement input, List<object> calls) : IChannel {
    public string Name => input.GetProperty("name").GetString()!; public string Description => input.TryGetProperty("description", out var value) ? value.GetString()! : null!;
    public string DataVersion => "component"; public string HomePageUrl => null!; public ChannelParentalRating ParentalRating => input.TryGetProperty("parentalRating", out var value) ? Enum.Parse<ChannelParentalRating>(value.GetString()!) : ChannelParentalRating.GeneralAudience;
    public InternalChannelFeatures GetChannelFeatures() { calls.Add(new { kind = "features", name = Name }); return input.GetProperty("features").Deserialize<InternalChannelFeatures>(JsonDefaults.Options)!; }
    public bool IsEnabledFor(string userId) { calls.Add(new { kind = "enabled", name = Name, userId }); if (input.TryGetProperty("failEnabled", out var fail) && fail.GetBoolean()) throw new InvalidOperationException("Controlled enablement failure."); return !input.TryGetProperty("enabled", out var value) || value.GetBoolean(); }
    public Task<ChannelItemResult> GetChannelItems(InternalChannelItemQuery query, CancellationToken token) => throw new InvalidOperationException("Item refresh is outside this catalog component.");
    public virtual Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken token) => Task.FromResult(new DynamicImageResponse { HasImage = false });
    public virtual IEnumerable<ImageType> GetSupportedChannelImages() => [];
    public static IChannel Make(JsonElement input, List<object> calls) => input.GetProperty("kind").GetString() switch { "latest" => new Latest(input, calls), "all" => new All(input, calls), "display" => new Display(input, calls), _ => new Provider(input, calls) };
    public class Latest(JsonElement input, List<object> calls) : Provider(input, calls), ISupportsLatestMedia {
        public Task<IEnumerable<ChannelItemInfo>> GetLatestMedia(ChannelLatestMediaSearch query, CancellationToken token) => throw new InvalidOperationException("Latest execution is outside this component.");
    }
    public class Display(JsonElement input, List<object> calls) : Provider(input, calls), IDisableMediaSourceDisplay { }
    public class All(JsonElement input, List<object> calls) : Latest(input, calls), ISupportsDelete, IHasFolderAttributes, IDisableMediaSourceDisplay {
        public string[] Attributes => input.TryGetProperty("attributes", out var value) ? value.EnumerateArray().Select(item => item.GetString()!).ToArray() : [];
        public bool CanDelete(BaseItem item) => throw new InvalidOperationException("Deletion execution is outside this component.");
        public Task DeleteItem(string id, CancellationToken token) => throw new InvalidOperationException("Deletion execution is outside this component.");
    }
}
public class OwnedImageProvider(JsonElement input, List<object> calls, ImageType[] types, byte[] bytes, Action disposed) : Provider(input, calls) {
    public override IEnumerable<ImageType> GetSupportedChannelImages() { calls.Add(new { kind = "supported", name = Name }); return types; }
    public override Task<DynamicImageResponse> GetChannelImage(ImageType type, CancellationToken token) {
        calls.Add(new { kind = "image", name = Name, type });
        return Task.FromResult(new DynamicImageResponse { HasImage = true, Format = MediaBrowser.Model.Drawing.ImageFormat.Png, Stream = new TrackedImageStream(bytes, disposed) });
    }
    public class TrackedImageStream(byte[] bytes, Action disposed) : MemoryStream(bytes, writable: false) {
        private bool closed;
        protected override void Dispose(bool disposing) { if (!closed) { closed = true; disposed(); } base.Dispose(disposing); }
    }
}
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class { var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value; }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public class OnlyChannelController : IApplicationFeatureProvider<ControllerFeature> {
    public void PopulateFeature(IEnumerable<ApplicationPart> parts, ControllerFeature feature) { foreach (var item in feature.Controllers.Where(value => value.AsType() != typeof(ChannelsController)).ToArray()) feature.Controllers.Remove(item); }
}
public class ChannelAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder) {
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() {
        var identity = Request.Headers["X-Identity"].ToString(); if (identity == "anonymous") return Task.FromResult(AuthenticateResult.NoResult());
        var claims = new List<Claim> { new(InternalClaimTypes.IsApiKey, (identity == "apiKey").ToString()) };
        if (identity != "apiKey") claims.Add(new Claim(InternalClaimTypes.UserId, "cf100000000000000000000000000001"));
        if (identity != "regular") claims.Add(new Claim(ClaimTypes.Role, UserRoles.Administrator));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name)), Scheme.Name)));
    }
}
public class DiagnosticProvider(List<object> entries) : ILoggerProvider {
    public ILogger CreateLogger(string category) => new DiagnosticLogger(entries, category); public void Dispose() { }
    public class DiagnosticLogger(List<object> entries, string category) : ILogger {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> formatter) {
            if (error is not null) entries.Add(new { category, type = error.GetType().Name, error.Message, error.StackTrace });
        }
    }
}
