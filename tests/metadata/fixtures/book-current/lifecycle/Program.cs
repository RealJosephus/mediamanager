using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Entities;
using MediaBrowser.Providers.Books;
using MediaBrowser.Providers.Manager;
using Microsoft.Extensions.Logging.Abstractions;

var inputBytes = File.ReadAllBytes(args[0]);
var input = JsonDocument.Parse(inputBytes).RootElement;
BaseItem.ConfigurationManager = Stub.Make<IServerConfigurationManager>((method, _) => method.Name == "get_Configuration"
    ? new ServerConfiguration { PreferredMetadataLanguage = "en", MetadataCountryCode = "US" } : Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, _) => method.Name == "GetPathProtocol" ? MediaProtocol.File : Stub.Default(method.ReturnType));
var results = new List<object>();
foreach (var sample in input.GetProperty("lookups").EnumerateArray())
{
    var parents = new Dictionary<Guid, BaseItem>();
    var book = new Book { Id = Id(1), Name = "Stored title", ProductionYear = 2025,
        Path = "Z:\\Books\\book.epub", SeriesName = Text(sample, "seriesName") };
    var previous = (BaseItem)book;
    var index = 2;
    foreach (var name in sample.GetProperty("parents").EnumerateArray())
    {
        var parent = new Folder { Id = Id(index++), Name = name.ValueKind == JsonValueKind.Null ? null : name.GetString() };
        previous.ParentId = parent.Id;
        parents.Add(parent.Id, parent);
        previous = parent;
    }
    if (sample.TryGetProperty("ownerOnly", out var ownerOnly) && ownerOnly.GetBoolean())
    {
        var owner = new Folder { Id = Id(99), Name = "Owner name" };
        parents.Add(owner.Id, owner);
        book.OwnerId = owner.Id;
    }
    BaseItem.LibraryManager = Stub.Make<ILibraryManager>((method, values) => method.Name switch {
        "GetItemById" => parents.GetValueOrDefault((Guid)values![0]!),
        "GetCollectionFolders" => new List<Folder>(),
        "GetLibraryOptions" => new LibraryOptions(),
        _ => Stub.Default(method.ReturnType)
    });
    var lookup = book.GetLookupInfo();
    results.Add(new { name = sample.GetProperty("name").GetString(), kind = "lookup", lookup = new { lookup.Name, lookup.Year,
        lookup.SeriesName, lookup.MetadataLanguage, lookup.MetadataCountryCode } });
}
var service = new MergeService();
foreach (var sample in input.GetProperty("merges").EnumerateArray())
{
    var source = new MetadataResult<Book> { Item = new Book { Name = "Incoming title", SeriesName = Text(sample, "source") } };
    var target = new MetadataResult<Book> { Item = new Book { Name = "Stored title", SeriesName = Text(sample, "target") } };
    service.Merge(source, target, sample.GetProperty("replace").GetBoolean(), sample.GetProperty("nameLocked").GetBoolean());
    results.Add(new { name = sample.GetProperty("name").GetString(), kind = "merge", item = new { target.Item.Name, target.Item.SeriesName } });
}
foreach (var sample in input.GetProperty("refresh").EnumerateArray())
{
    var saves = new List<object>();
    var attempts = new List<object>();
    var lookups = new List<object>();
    var providerCalls = 0;
    var failure = sample.TryGetProperty("failure", out var failed) ? failed.GetString() : null;
    var book = new Book { Id = Id(1), Name = "Stored title", ProductionYear = 2025,
        SeriesName = Text(sample, "seriesName"), DateLastRefreshed = Bool(sample, "first") ? DateTime.MinValue : new DateTime(2026, 10, 1),
        IsLocked = Bool(sample, "locked"), LockedFields = Bool(sample, "nameLocked") ? [MetadataField.Name] : [] };
    if (sample.TryGetProperty("provider", out var providerKind) && providerKind.GetString() == "local") book.Path = "Z:\\ChildrenMetadata\\book.epub";
    var initialStamp = book.DateLastRefreshed;
    var library = Stub.Make<ILibraryManager>((method, values) => {
        if (method.Name == "UpdateItemAsync") {
            var item = (Book)values![0]!;
            var value = new { reason = (int)(ItemUpdateType)values[2]!, item.Name, item.SeriesName, item.Overview };
            attempts.Add(value);
            if (failure == "repository" && attempts.Count == 2) throw new IOException("Controlled repository failure.");
            saves.Add(value);
            return Task.CompletedTask;
        }
        return method.Name switch {
            "GetItemById" => null,
            "GetCollectionFolders" => new List<Folder>(),
            "GetLibraryOptions" => new LibraryOptions(),
            _ => Stub.Default(method.ReturnType)
        };
    });
    BaseItem.LibraryManager = library;
    var filesystem = Stub.Make<IFileSystem>((method, _) => method.Name == "GetFileSystemInfo" ? new FileSystemMetadata() : Stub.Default(method.ReturnType));
    BaseItem.FileSystem = filesystem;
    var baseItemManager = Stub.Make<IBaseItemManager>((method, _) => method.Name == "IsMetadataFetcherEnabled" ? true : Stub.Default(method.ReturnType));
    MetadataResult<Book> Fetch(BookInfo? lookup) {
        providerCalls++;
        if (lookup is not null) lookups.Add(new { lookup.Name, lookup.Year, lookup.SeriesName, lookup.IsAutomated });
        if (failure == "provider") throw new IOException("Controlled provider failure.");
        if (failure == "cancel") throw new OperationCanceledException("Controlled provider cancellation.");
        return new MetadataResult<Book> { HasMetadata = true,
            Item = new Book { Name = "Provider title", SeriesName = Text(sample, "sourceSeries"), Overview = "Provider overview" } };
    }
    IMetadataProvider provider = sample.TryGetProperty("provider", out var selected) && selected.GetString() == "local"
        ? new LocalProvider { Fetch = () => Fetch(null) } : new RemoteProvider { Fetch = Fetch };
    using var providers = new ProviderManager(null!, null!, BaseItem.ConfigurationManager, null!, NullLogger<ProviderManager>.Instance,
        filesystem, null!, library, baseItemManager, null!, null!, null!, null!);
    providers.AddParts([], [], [provider], [], [], []);
    var repository = Stub.Make<IItemRepository>((method, _) => method.Name == "ItemExistsAsync" ? Task.FromResult(true) : Stub.Default(method.ReturnType));
    var metadata = new BookMetadataService(BaseItem.ConfigurationManager, NullLogger<BookMetadataService>.Instance,
        providers, filesystem, library, null!, repository);
    var refresh = new MetadataRefreshOptions((IDirectoryService)null!) { MetadataRefreshMode = Enum.Parse<MetadataRefreshMode>(sample.GetProperty("mode").GetString()!),
        ImageRefreshMode = MetadataRefreshMode.None, ReplaceAllMetadata = Bool(sample, "replace"), RemoveOldMetadata = Bool(sample, "removeOld"),
        ForceSave = Bool(sample, "force"), IsAutomated = true };
    string? exception = null;
    int? updateType = null;
    try { updateType = (int)await metadata.RefreshMetadata(book, refresh, CancellationToken.None); }
    catch (Exception error) { exception = error.GetType().Name; }
    var expectedFailure = failure is "cancel" or "repository";
    if ((exception is not null) != expectedFailure) throw new InvalidOperationException(sample.GetProperty("name").GetString() + ": unexpected exception " + exception);
    results.Add(new { name = sample.GetProperty("name").GetString(), kind = "refresh", saves, attempts, lookups, providerCalls,
        exception, updateType, stampChanged = book.DateLastRefreshed != initialStamp,
        item = new { book.Name, book.SeriesName, book.Overview } });
}
File.WriteAllText(args[1], JsonSerializer.Serialize(new {
    actualExecution = true, inputSha256 = Convert.ToHexString(SHA256.HashData(inputBytes)).ToLowerInvariant(), results,
    boundary = "Actual Book.GetLookupInfo with explicit physical parent lookup and no owner fallback. Actual BookMetadataService.MergeData with null/empty/whitespace/curated series names, replacement and Name lock. Actual BookMetadataService.RefreshMetadata and ProviderManager selection/merge execute with controlled local/remote providers, first-save and repository callbacks, cancellation and failures. Configuration, ILibraryManager, repository and filesystem seams are controlled; no native SQL, production book parsers, image generation or complete scanner runs.",
    assemblies = new[] { typeof(Book).Assembly, typeof(BookMetadataService).Assembly }.Select(assembly => new {
        name = assembly.GetName().Name, sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()
    })
}, new JsonSerializerOptions { WriteIndented = true }) + "\n");

static Guid Id(int value) => Guid.Parse($"cb700000-0000-0000-0000-{value:000000000000}");
static string? Text(JsonElement value, string name) => value.GetProperty(name).ValueKind == JsonValueKind.Null ? null : value.GetProperty(name).GetString();
static bool Bool(JsonElement value, string name) => value.TryGetProperty(name, out var property) && property.GetBoolean();
public sealed class MergeService : BookMetadataService
{
    public MergeService() : base(null!, NullLogger<BookMetadataService>.Instance, null!, null!, null!, null!, null!) { }
    public void Merge(MetadataResult<Book> source, MetadataResult<Book> target, bool replace, bool nameLocked)
        => MergeData(source, target, nameLocked ? [MetadataField.Name] : [], replace, false);
}
public class Stub : DispatchProxy
{
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var value = Create<T, Stub>(); ((Stub)(object)value).Handler = handler; return value;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task)
        ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
}
public sealed class RemoteProvider : IRemoteMetadataProvider<Book, BookInfo>, IHasItemChangeMonitor
{
    public Func<BookInfo, MetadataResult<Book>> Fetch = null!;
    public string Name => "Controlled Book provider";
    public bool HasChanged(BaseItem item, IDirectoryService service) => true;
    public Task<MetadataResult<Book>> GetMetadata(BookInfo info, CancellationToken token) => Task.FromResult(Fetch(info));
    public Task<IEnumerable<MediaBrowser.Model.Providers.RemoteSearchResult>> GetSearchResults(BookInfo info, CancellationToken token) => throw new NotSupportedException();
    public Task<HttpResponseMessage> GetImageResponse(string url, CancellationToken token) => throw new NotSupportedException();
}
public sealed class LocalProvider : ILocalMetadataProvider<Book>, IHasItemChangeMonitor
{
    public Func<MetadataResult<Book>> Fetch = null!;
    public string Name => "Controlled Book provider";
    public bool HasChanged(BaseItem item, IDirectoryService service) => true;
    public Task<MetadataResult<Book>> GetMetadata(ItemInfo info, IDirectoryService service, CancellationToken token) => Task.FromResult(Fetch());
}
