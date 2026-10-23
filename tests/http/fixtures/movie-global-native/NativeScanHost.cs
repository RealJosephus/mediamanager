using System.Collections.Concurrent;
using System.Data.Common;
using System.Diagnostics;
using System.Security.Cryptography;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Model.Entities;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using Emby.Naming.Common;
using Emby.Naming.Video;
using Emby.Server.Implementations;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Plugins;
using Emby.Server.Implementations.Serialization;
using Jellyfin.Data.Events;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.BaseItemManager;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.IO;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LibraryTaskScheduler;
using MediaBrowser.Controller.MediaSegments;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Providers;
using MediaBrowser.Model.Tasks;
using MediaBrowser.Providers.Folders;
using MediaBrowser.Providers.Manager;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

public sealed class Scenario
{
    public string Name { get; set; } = "";
    public LibrarySeed[] Libraries { get; set; } = [];
    public string[] Directories { get; set; } = [];
    public string[] InitialDirectories { get; set; } = [];
    public string[] RemoveDirectories { get; set; } = [];
    public bool Warmup { get; set; }
    public int Fanout { get; set; } = 1;
    public FaultPlan? Fault { get; set; }
    public CancellationPlan? Cancel { get; set; }
}
public sealed class LibrarySeed
{
    public string Name { get; set; } = "Library";
    public string[] Locations { get; set; } = [];
    public string? CollectionType { get; set; }
    public bool SaveLocalMetadata { get; set; }
    public bool EnablePhotos { get; set; } = true;
    public LibraryOptions? Options { get; set; }
}
public sealed class FaultPlan
{
    // enumeration | metadata-after | save-before; a real forwarding boundary.
    public string Kind { get; set; } = "enumeration";
    public string Path { get; set; } = "";
    public string? AfterCommitPath { get; set; }
    public int AtOccurrence { get; set; } = 1;
}
public sealed class CancellationPlan
{
    // provider | global. Provider progress uses unscaled actual Folder phases.
    public string Channel { get; set; } = "provider";
    public string Path { get; set; } = "@aggregate";
    public double Progress { get; set; }
}
public sealed record ScanObservation(string? Exception, string? ExceptionMessage, bool ScanRunning,
    object Roots, object Sql, object[] Trace, string[] ResolverTypes, string[] MetadataServiceTypes);

public sealed class NativeScanHost : IAsyncDisposable
{
    public static readonly string[] SourcePaths = [
        "Emby.Server.Implementations/Library/LibraryManager.cs",
        "MediaBrowser.Controller/Entities/Folder.cs",
        "MediaBrowser.Controller/Entities/AggregateFolder.cs",
        "MediaBrowser.Controller/Entities/UserRootFolder.cs",
        "MediaBrowser.Controller/Entities/CollectionFolder.cs",
        "MediaBrowser.Controller/Entities/BaseItem.cs",
        "MediaBrowser.Controller/IO/FileData.cs",
        "MediaBrowser.Controller/Library/ItemResolveArgs.cs",
        "MediaBrowser.Controller/Providers/DirectoryService.cs",
        "MediaBrowser.Controller/LibraryTaskScheduler/LimitedConcurrencyLibraryScheduler.cs",
        "Emby.Server.Implementations/ApplicationHost.cs",
        "Jellyfin.Server/CoreAppHost.cs",
        "Emby.Server.Implementations/IO/ManagedFileSystem.cs",
        "Emby.Server.Implementations/IO/MbLinkShortcutHandler.cs",
        "Jellyfin.Server.Implementations/Item/BaseItemRepository.cs",
        "Jellyfin.Server.Implementations/Item/ItemPersistenceService.cs",
        "MediaBrowser.Providers/Manager/ProviderManager.cs",
        "MediaBrowser.Providers/Manager/MetadataService.cs",
        "MediaBrowser.Providers/Folders/FolderMetadataService.cs",
        "MediaBrowser.Providers/Folders/CollectionFolderMetadataService.cs" ];
    private readonly ConcurrentQueue<object> _trace = new();
    private readonly object _traceLock = new();
    private readonly ConcurrentDictionary<string, byte> _committed = new(StringComparer.OrdinalIgnoreCase);
    private readonly CancellationTokenSource _cancel = new();
    private readonly ControlledLifetime _lifetime = new();
    private readonly MemoryCache _cache = new(new MemoryCacheOptions());
    private readonly List<double> _progress = new();
    private readonly object _progressLock = new();
    private PluginManager _plugins = null!;
    private LimitedConcurrencyLibraryScheduler _scheduler = null!;
    private IProviderManager _providerDispatch = null!;
    private IExternalDataManager? _actualExternalData;
    private int _nextExternalCleanup;
    private bool _observing = true;
    private string _phase = "initialization";
    private IItemResolver[] _resolvers = [];
    private IResolverIgnoreRule[] _ignoreRules = [];
    private readonly List<(string Name, IDisposable Resource)> _ownedResources = [];
    private readonly ConcurrentQueue<QueueRequest> _queueRequests = new();
    private int _nextQueueRequest;
    private int _sequence, _faultOccurrence;
    private bool _disposed;
    public string CaseRoot { get; }
    public string InitialCloneSha256 { get; private set; } = "";
    public string MediaRoot => Path.Combine(CaseRoot, "media");
    public Scenario Scenario { get; }
    public IServerApplicationPaths Paths { get; private set; } = null!;
    public IServerConfigurationManager Configuration { get; private set; } = null!;
    public IFileSystem FileSystem { get; private set; } = null!;
    public IImageProcessor ImageProcessor { get; private set; } = null!;
    public IExternalDataManager ExternalData { get; private set; } = null!;
    public IServiceProvider ServiceProvider { get; private set; } = null!;
    public LibraryManager Manager { get; private set; } = null!;
    public ProviderManager Provider { get; private set; } = null!;
    public BaseItemRepository Repository { get; private set; } = null!;
    public SqlFactory Factory { get; private set; } = null!;
    public IDirectoryService DirectoryService { get; private set; } = null!;
    public IServerApplicationHost AppHost { get; private set; } = null!;
    public IReadOnlyList<object> Trace => _trace.ToArray();
    public List<string> ReleasedResources { get; } = [];
    public ILoggerFactory LoggerFactory { get; private set; } = null!;
    public MediaBrowser.Model.Globalization.ILocalizationManager Localization { get; private set; } = null!;
    public ILibraryMonitor Monitor { get; private set; } = null!;
    public IPathManager PathManager { get; private set; } = null!;
    public LinkedChildrenService Links { get; private set; } = null!;
    public MediaStreamRepository Streams { get; private set; } = null!;
    public IProviderManager ObservedProvider => _providerDispatch;
    public void SetPhase(string value) => _phase = value;
    public void Own(string name, IDisposable resource) => _ownedResources.Add((name, resource));
    public void InstallExternalDataManager(IExternalDataManager actual)
    {
        if (_actualExternalData is not null) throw new InvalidOperationException("The actual external data manager is already installed.");
        _actualExternalData = actual ?? throw new ArgumentNullException(nameof(actual));
        Add("external-data-installed", new { type = actual.GetType().FullName });
    }
    public void SetPostScanTasks(params ILibraryPostScanTask[] tasks) => Manager.AddParts(_ignoreRules, _resolvers, [], [], tasks.Select(task => new ObservedPostScanTask(this, task)).ToArray());
    public List<IMetadataService> MetadataServices { get; } = [];
    public List<IMetadataProvider> MetadataProviders { get; } = [];
    public List<IImageProvider> ImageProviders { get; } = [];
    public List<IMetadataSaver> MetadataSavers { get; } = [];
    public List<IExternalId> ExternalIds { get; } = [];
    public List<IExternalUrlProvider> ExternalUrls { get; } = [];
    public string[] ResolverTypes { get; private set; } = [];
    public Type[] PostScanTaskTypes { get; private set; } = [];

    private NativeScanHost(string root, Scenario scenario) { CaseRoot = root; Scenario = scenario; }

    public static Task<NativeScanHost> CreateAsync(string root, Scenario scenario, string frozenDatabase,
        Func<IServerApplicationPaths, IServerConfigurationManager, IFileSystem, IImageProcessor>? imageProcessorFactory = null)
    {
        root = Path.GetFullPath(root);
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("Case root must be fresh: " + root);
        Directory.CreateDirectory(root);
        File.Copy(frozenDatabase, Path.Combine(root, "native.db"));
        File.SetAttributes(Path.Combine(root, "native.db"), FileAttributes.Normal);
        if (!File.ReadAllBytes(frozenDatabase).SequenceEqual(File.ReadAllBytes(Path.Combine(root, "native.db"))))
            throw new IOException("The native business clone must initially equal the frozen prepared input.");
        var host = new NativeScanHost(root, scenario);
        host.InitialCloneSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(root, "native.db"))));
        host.Initialize(imageProcessorFactory);
        return Task.FromResult(host);
    }

    public string MediaPath(string relative) => Within(MediaRoot, relative);
    private static string Within(string root, string relative)
    {
        if (Path.IsPathRooted(relative)) throw new ArgumentException("Expected a relative fixture path.");
        var value = Path.GetFullPath(Path.Combine(root, relative));
        if (!value.Equals(root, StringComparison.OrdinalIgnoreCase)
            && !value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Path escaped its fresh case root.");
        return value;
    }
    public void ApplyProviderParts() => Provider.AddParts(ImageProviders, MetadataServices.Select(service=>new ObservedMetadataService(this,service)), MetadataProviders,
        MetadataSavers, ExternalIds, ExternalUrls);

    private void Initialize(Func<IServerApplicationPaths, IServerConfigurationManager, IFileSystem, IImageProcessor>? imageProcessorFactory)
    {
        SQLitePCL.Batteries_V2.Init();
        var program = Path.Combine(CaseRoot, "program");
        var root = Path.Combine(program, "root");
        var views = Path.Combine(root, "default");
        var strings = new Dictionary<string, string> {
            ["ProgramDataPath"] = program, ["DataPath"] = Path.Combine(program,"data"),
            ["RootFolderPath"] = root, ["DefaultUserViewsPath"] = views,
            ["InternalMetadataPath"] = Path.Combine(program,"metadata"),
            ["CachePath"] = Path.Combine(program,"cache"), ["LogDirectoryPath"] = Path.Combine(program,"log"),
            ["TempDirectory"] = Path.Combine(program,"temp"),
            ["ImageCachePath"] = Path.Combine(program,"cache","images"),
            ["ConfigurationDirectoryPath"] = Path.Combine(program,"config"),
            ["TrickplayPath"] = Path.Combine(program,"data","trickplay"),
            ["PeoplePath"] = Path.Combine(program,"metadata","People"), ["ArtistsPath"] = Path.Combine(program,"metadata","artists"),
            ["GenrePath"] = Path.Combine(program,"metadata","Genre"), ["MusicGenrePath"] = Path.Combine(program,"metadata","MusicGenre"),
            ["StudioPath"] = Path.Combine(program,"metadata","Studio"), ["YearPath"] = Path.Combine(program,"metadata","Year") };
        foreach (var directory in strings.Values) Directory.CreateDirectory(directory);
        Directory.CreateDirectory(MediaRoot);
        Paths = ForwardProxy.Make<IServerApplicationPaths>((method, values) => method.Name switch {
            "get_VirtualDataPath" => "%AppDataPath%", "get_VirtualInternalMetadataPath" => "%MetadataPath%",
            _ when method.Name.StartsWith("get_",StringComparison.Ordinal) && strings.TryGetValue(method.Name[4..],out var value) => value,
            _ => ForwardProxy.Unused(method) });
        var server = new ServerConfiguration { CacheSize = 128, LibraryScanFanoutConcurrency = Scenario.Fanout,
            IsStartupWizardCompleted = true, UICulture = "en-US", MetadataCountryCode = "US", PreferredMetadataLanguage = "en", EnableCaseSensitiveItemIds = true };
        var encoding = new EncodingOptions { EncoderAppPath = Environment.GetEnvironmentVariable("MEDIAMANAGER_FFMPEG") };
        var nfo = new XbmcMetadataOptions();
        var liveTv = new MediaBrowser.Model.LiveTv.LiveTvOptions
        {
            TunerHosts = [], ListingProviders = [], MediaLocationsCreated = []
        };
        Configuration = ForwardProxy.Make<IServerConfigurationManager>((method, values) => method.Name switch {
            "get_Configuration" or "get_CommonConfiguration" => server, "get_ApplicationPaths" or "get_CommonApplicationPaths" => Paths,
            "GetConfiguration" when values?[0] as string == "encoding" => encoding,
            "GetConfiguration" when values?[0] as string == "xbmcmetadata" => nfo,
            "GetConfiguration" when values?[0] as string == "livetv" => liveTv,
            "SaveConfiguration" => null,
            "GetConfiguration" when values?[0] as string == "metadata" => new MetadataConfiguration { UseFileCreationTimeForDateAdded = true },
            _ when method.Name.StartsWith("add_",StringComparison.Ordinal) || method.Name.StartsWith("remove_",StringComparison.Ordinal) => null,
            _ => ForwardProxy.Unused(method) });
        var discovery=(CoreAppHost)RuntimeHelpers.GetUninitializedObject(typeof(CoreAppHost));
        typeof(ApplicationHost).GetField("<ApplicationPaths>k__BackingField",BindingFlags.Instance|BindingFlags.NonPublic)!
            .SetValue(discovery, Paths);
        AppHost = ForwardProxy.Make<IServerApplicationHost>((method, values) => method.Name switch {
            "ExpandVirtualPath" => discovery.ExpandVirtualPath((string)values![0]!),
            "ReverseVirtualPath" => discovery.ReverseVirtualPath((string)values![0]!),
            "get_SystemId" => "movie-global-scan-oracle",
            _ => ForwardProxy.Unused(method) });
        var loggerFactory = new ObservationLoggerFactory(this);
        LoggerFactory = loggerFactory;
        var actualFileSystem = new ManagedFileSystem(loggerFactory.CreateLogger<ManagedFileSystem>(), Paths, [new MbLinkShortcutHandler()]);
        FileSystem = ForwardProxy.Make<IFileSystem>((method, values) => {
            if (_observing && method.Name == "GetFileSystemEntries" && values?[0] is string name) {
                Add("enumerate",new { path=Relative(name) });
                MaybeFault("enumeration",name);
            }
            return ForwardProxy.Forward(actualFileSystem, method, values);
        });
        ImageProcessor = imageProcessorFactory?.Invoke(Paths, Configuration, FileSystem)
            ?? ForwardProxy.Make<IImageProcessor>((method, values) => method.Name == "get_SupportedInputFormats"
                ? Array.Empty<string>() : ForwardProxy.Unused(method));
        DirectoryService = new DirectoryService(FileSystem);
        Factory = new SqlFactory(Path.Combine(CaseRoot,"native.db"));
        // This is a full migrated input clone. Never call EnsureCreated/Migrate,
        // fabricate migration history, or clear domain rows in a business run.
        using (var initial = Factory.CreateDbContext())
        {
            initial.Database.OpenConnection();
            using var command = initial.Database.GetDbConnection().CreateCommand();
            command.CommandText = "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";
            if (Convert.ToInt32(command.ExecuteScalar()) != 33) throw new IOException("The supplied full native schema must have 33 tables.");
        }
        Repository = new BaseItemRepository(Factory, AppHost, new ItemTypeLookup(), Configuration, loggerFactory.CreateLogger<BaseItemRepository>());
        var actualPersistence = new ItemPersistenceService(Factory, AppHost, loggerFactory.CreateLogger<ItemPersistenceService>());
        var persistence = ForwardProxy.Make<IItemPersistenceService>((method, values) => {
            if (_observing && method.Name == "SaveItems") {
                var items = (IReadOnlyList<BaseItem>)values![0]!;
                foreach (var item in items) MaybeFault("save-before",item.Path);
                Add("save-begin",new { items=items.Select(Item).ToArray(), cancellable=((CancellationToken)values[1]!).CanBeCanceled });
                var result = ForwardProxy.Forward(actualPersistence,method,values);
                foreach (var item in items) if (item.Path is not null) _committed[item.Path]=0;
                Add("save-committed",new { items=items.Select(Item).ToArray(), sql=SnapshotSql() });
                return result;
            }
            if (_observing && method.Name == "UpdateInheritedValues") Add("inherited-cleanup-begin",null);
            var forwarded = ForwardProxy.Forward(actualPersistence,method,values);
            if (_observing && method.Name == "UpdateInheritedValues") Add("inherited-cleanup-committed",new { sql=SnapshotSql() });
            return forwarded;
        });
        // Root initialization cannot silently consume a placeholder cleanup.
        // MovieProviders installs the real service after its encoder/chapter
        // dependencies exist, before admitting any business scan.
        ExternalData = ForwardProxy.Make<IExternalDataManager>(ObserveExternalCleanup);
        var monitor = ForwardProxy.Make<ILibraryMonitor>((method, values) => {
            Add("monitor-"+method.Name,new { scanRunning=Manager?.IsScanRunning });
            return method.ReturnType == typeof(void) ? null : ForwardProxy.Unused(method);
        });
        Monitor = monitor;
        var localization = new LocalizationManager(Configuration,loggerFactory.CreateLogger<LocalizationManager>());
        Localization = localization;
        var naming = new NamingOptions();
        var pathManager = new PathManager(loggerFactory.CreateLogger<PathManager>(), Configuration, Paths);
        PathManager = pathManager;
        Links = new LinkedChildrenService(Factory, new ItemTypeLookup(), Repository);
        Streams = new MediaStreamRepository(Factory, AppHost, localization);
        var people = new PeopleRepository(Factory, new ItemTypeLookup(), Repository);
        var userData = ForwardProxy.Make<IUserDataManager>((method,values)=>ForwardProxy.Unused(method));
        Manager = new LibraryManager(AppHost,loggerFactory,
            ForwardProxy.Make<ITaskManager>((method,values)=>ForwardProxy.Unused(method)),null!,Configuration,userData,
            new(()=>monitor),FileSystem,new(()=>_providerDispatch),new(()=>null!),Repository,persistence,null!,null!,
            Links,ImageProcessor,naming,DirectoryService,people,
            pathManager,new DotIgnoreIgnoreRule(),localization,Streams,new(()=>ExternalData));
        Provider = new ProviderManager(null!,null!,Configuration,monitor,loggerFactory.CreateLogger<ProviderManager>(),
            FileSystem,Paths,Manager,new BaseItemManager(Configuration),null!,_cache,null!,null!);
        // IProviderManager returns IMetadataProvider<T>, whose T is constrained
        // to BaseItem. A generated DispatchProxy method loses that constraint;
        // use compile-time forwarding for this actual provider boundary.
        _providerDispatch = new ObservedProviderManager(this, Provider);
        Provider.RefreshStarted+=(_,e)=>Add("provider-OnRefreshStart",new { item=Item(e.Argument) });
        Provider.RefreshCompleted+=(_,e)=>Add("provider-OnRefreshComplete",new { item=Item(e.Argument) });
        Provider.RefreshProgress+=(_,e)=>{
            Add("provider-OnRefreshProgress",new { item=Item(e.Argument.Item1),progress=e.Argument.Item2 });
            if(_observing)MaybeCancel("provider",e.Argument.Item1,e.Argument.Item2);
        };
        _scheduler = new LimitedConcurrencyLibraryScheduler(_lifetime,loggerFactory.CreateLogger<LimitedConcurrencyLibraryScheduler>(),Configuration);
        BaseItem.ConfigurationManager=Configuration;BaseItem.FileSystem=FileSystem;BaseItem.ItemRepository=Repository;
        BaseItem.LibraryManager=Manager;BaseItem.ProviderManager=_providerDispatch;BaseItem.LocalizationManager=localization;
        BaseItem.Logger=loggerFactory.CreateLogger<BaseItem>();BaseItem.UserDataManager=userData;
        BaseItem.MediaSourceManager=ForwardProxy.Make<IMediaSourceManager>((method,values)=>method.Name=="GetPathProtocol"
            ? MediaProtocol.File : ForwardProxy.Unused(method));
        BaseItem.MediaSegmentManager=ForwardProxy.Make<IMediaSegmentManager>((method,values)=>ForwardProxy.Unused(method));
        CollectionFolder.ApplicationHost=AppHost;CollectionFolder.XmlSerializer=new MyXmlSerializer();
        Folder.LimitedConcurrencyLibraryScheduler=_scheduler;
        MetadataServices.Add(new CollectionFolderMetadataService(Configuration,loggerFactory.CreateLogger<CollectionFolderMetadataService>(),
            _providerDispatch,FileSystem,Manager,ExternalData,Repository));
        MetadataServices.Add(new FolderMetadataService(Configuration,loggerFactory.CreateLogger<FolderMetadataService>(),
            _providerDispatch,FileSystem,Manager,ExternalData,Repository));
        ApplyProviderParts();
        var services=new ServiceCollection();services.AddSingleton<ILoggerFactory>(loggerFactory);services.AddLogging();
        services.AddSingleton(Paths);services.AddSingleton(Configuration);services.AddSingleton(FileSystem);services.AddSingleton(ImageProcessor);
        services.AddSingleton<ILibraryManager>(Manager);services.AddSingleton<IItemRepository>(Repository);services.AddSingleton(ExternalData);
        services.AddSingleton<IProviderManager>(_providerDispatch);services.AddSingleton(DirectoryService);services.AddSingleton(localization);
        services.AddSingleton<MediaBrowser.Model.Globalization.ILocalizationManager>(localization);
        services.AddSingleton(naming);services.AddSingleton(new VideoListResolver(naming));services.AddSingleton(AppHost);
        ServiceProvider=services.BuildServiceProvider();
        typeof(ApplicationHost).GetField("<Logger>k__BackingField",BindingFlags.Instance|BindingFlags.NonPublic)!
            .SetValue(discovery,loggerFactory.CreateLogger<ApplicationHost>());
        _plugins=new PluginManager(loggerFactory.CreateLogger<PluginManager>(),discovery,server,Path.Combine(CaseRoot,"no-installed-plugins"),typeof(CoreAppHost).Assembly.GetName().Version!);
        typeof(ApplicationHost).GetField("_pluginManager",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(discovery,_plugins);
        typeof(ApplicationHost).GetMethod("DiscoverTypes",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(discovery,null);
        discovery.ServiceProvider=ServiceProvider;
        var resolvers=discovery.GetExports<IItemResolver>(false).ToArray();
        var ignoreRules=discovery.GetExports<IResolverIgnoreRule>(false).ToArray();
        PostScanTaskTypes=discovery.GetExportTypes<ILibraryPostScanTask>().ToArray();
        ResolverTypes=resolvers.Select(r=>r.GetType().FullName!).ToArray();
        _ignoreRules = ignoreRules; _resolvers = resolvers;
        Manager.AddParts(ignoreRules,resolvers,[],[],[]);
        Manager.ItemAdded+=(_,e)=>Add("added",new { item=Item(e.Item),parent=e.Parent?.Id, updateReason=(int)e.UpdateReason });
        Manager.ItemUpdated+=(_,e)=>Add("updated",new { item=Item(e.Item),parent=e.Parent?.Id, updateReason=(int)e.UpdateReason });
        Manager.ItemRemoved+=(_,e)=>Add("removed",new { item=Item(e.Item),parent=e.Parent?.Id, updateReason=(int)e.UpdateReason });
        SeedFilesystem();
        // No root object, Children array, private root field or cached topology
        // is injected. These production getters perform actual discovery.
        Add("created-real-roots",new { aggregate=Item(Manager.RootFolder),userRoot=Item(Manager.GetUserRootFolder()) });
    }

    private void SeedFilesystem()
    {
        foreach (var relative in Scenario.Warmup ? Scenario.InitialDirectories : Scenario.Directories)
            Directory.CreateDirectory(MediaPath(relative));
        foreach (var library in Scenario.Libraries)
        {
            var directory=Within(Paths.DefaultUserViewsPath,library.Name);
            Directory.CreateDirectory(directory);
            for (var i=0;i<library.Locations.Length;i++)
            {
                var target=MediaPath(library.Locations[i]);Directory.CreateDirectory(target);
                File.WriteAllText(Path.Combine(directory,$"location-{i:D2}.mblink"),target);
            }
            if (library.CollectionType is not null)
            {
                if (library.CollectionType.IndexOfAny(Path.GetInvalidFileNameChars())>=0)
                    throw new ArgumentException("Invalid collection marker name.");
                File.WriteAllText(Path.Combine(directory,library.CollectionType+".collection"),"");
            }
            CollectionFolder.SaveLibraryOptions(directory,library.Options ?? new LibraryOptions {
                SaveLocalMetadata=library.SaveLocalMetadata,EnablePhotos=library.EnablePhotos });
        }
    }

    public void ApplyChanges()
    {
        foreach(var relative in Scenario.RemoveDirectories)
        {
            var directory=MediaPath(relative);
            if(directory.Equals(MediaRoot,StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Cannot remove the media root.");
            if(Directory.Exists(directory))Directory.Delete(directory,true);
        }
        foreach(var relative in Scenario.Directories)Directory.CreateDirectory(MediaPath(relative));
        // A fresh global call builds native MetadataRefreshOptions/DirectoryService;
        // the instance used by resolver dependencies is explicitly invalidated too.
        DirectoryService.Invalidate(MediaRoot);
    }

    public async Task<ScanObservation> RunAsync(bool observe=true)
    {
        if(_disposed)throw new ObjectDisposedException(nameof(NativeScanHost));
        _observing=observe;
        // Retain every phase and asynchronous queue event in one monotonically numbered trace.
        lock(_progressLock)_progress.Clear();
        _faultOccurrence=0;
        if(observe&&Scenario.Cancel?.Channel=="initial")_cancel.Cancel();
        string? exception=null,message=null;
        Add("before-global",new { roots=RootSnapshot(),sql=SnapshotSql() });
        try
        {
            await Manager.ValidateMediaLibraryInternal(new InlineProgress(value=>{
                lock(_progressLock)_progress.Add(value);
                Add("global-progress",new { progress=value });
                if(_observing&&Scenario.Cancel is { Channel:"global" } cancel&&value==cancel.Progress)
                {
                    Add("cancel-request",new { channel="global",progress=value });_cancel.Cancel();
                }
            }),_cancel.Token);
        }
        catch(Exception error)
        {
            exception=error.GetType().FullName;message=error.ToString();
            Add("global-exception",new { type=exception,error.Message });
        }
        Add("after-global",new { scanRunning=Manager.IsScanRunning });
        return new ScanObservation(exception,message,Manager.IsScanRunning,RootSnapshot(),SnapshotSql(),
            _trace.ToArray(),ResolverTypes,MetadataServices.Select(s=>s.GetType().FullName!).ToArray());
    }

    private async Task<MediaBrowser.Controller.Library.ItemUpdateType> RefreshSingleItem(IMetadataService service,BaseItem item,
        MetadataRefreshOptions options,CancellationToken token)
    {
        Add("metadata-begin",new { item=Item(item),options.MetadataRefreshMode,options.ImageRefreshMode,
            options.IsAutomated,cancelled=token.IsCancellationRequested });
        var result=await service.RefreshMetadata(item,options,token);
        Add("metadata-completed",new { item=Item(item),updateType=result });
        if(_observing)MaybeFault("metadata-after",item.Path);
        return result;
    }

    private void MaybeFault(string kind,string? filename)
    {
        if(!_observing||filename is null||Scenario.Fault is not { } fault||fault.Kind!=kind
            || !StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(filename),MediaPath(fault.Path)))return;
        if(fault.AfterCommitPath is not null&&!_committed.ContainsKey(MediaPath(fault.AfterCommitPath)))return;
        if(Interlocked.Increment(ref _faultOccurrence)!=fault.AtOccurrence)return;
        Add("injected-fault",new { kind,path=Relative(filename),occurrence=fault.AtOccurrence,
            actualFrames=new System.Diagnostics.StackTrace().GetFrames().Select(frame=>frame.GetMethod())
                .Where(method=>method is not null).Select(method=>method!.DeclaringType?.FullName+"."+method.Name).ToArray() });
        throw new IOException("Controlled "+kind+" failure at "+Relative(filename));
    }

    private void MaybeCancel(string channel,BaseItem item,double value)
    {
        if(Scenario.Cancel is not { } cancel||cancel.Channel!=channel||cancel.Progress!=value)return;
        var matches=cancel.Path switch {
            "@aggregate"=>item.GetType()==typeof(AggregateFolder),
            "@user-root"=>item.GetType()==typeof(UserRootFolder),
            _=>item.Path is not null&&StringComparer.OrdinalIgnoreCase.Equals(Path.GetFullPath(item.Path),MediaPath(cancel.Path)) };
        if(!matches)return;
        Add("cancel-request",new { channel,progress=value,item=Item(item) });_cancel.Cancel();
    }

    public object RootSnapshot()
    {
        var aggregate=Manager.RootFolder;var userRoot=Manager.GetUserRootFolder();
        return new { aggregate=Item(aggregate),userRoot=Item(userRoot),
            aggregateChildren=aggregate.Children.Select(Item).ToArray(),
            virtualChildren=aggregate.VirtualChildren.Select(Item).ToArray(),
            userRootChildren=userRoot.Children.Select(Item).ToArray() };
    }

    public object SnapshotSql()
    {
        using var db=Factory.CreateDbContext();
        var connection=db.Database.GetDbConnection();connection.Open();
        var tables=new List<string>();
        using(var command=connection.CreateCommand())
        {
            command.CommandText="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
            using var reader=command.ExecuteReader();while(reader.Read())tables.Add(reader.GetString(0));
        }
        // Every actual relational table is retained, including empty tables.
        // The neutral input separately asserts all 33 designated model tables.
        var result=new Dictionary<string,object>();
        foreach(var table in tables)
        {
            using var command=connection.CreateCommand();command.CommandText="SELECT * FROM \""+table.Replace("\"","\"\"")+"\" ORDER BY rowid";
            using var reader=command.ExecuteReader();var rows=new List<Dictionary<string,object?>>();
            while(reader.Read())
            {
                var row=new Dictionary<string,object?>();
                for(var i=0;i<reader.FieldCount;i++)row[reader.GetName(i)]=reader.IsDBNull(i)?null:reader.GetValue(i);
                rows.Add(row);
            }
            result[table]=rows;
        }
        return new { tables,result };
    }

    internal object Item(BaseItem item)=>new { id=item.Id,type=item.GetType().FullName,item.Name,path=item.Path,relativePath=Relative(item.Path),
        item.ParentId,item.OwnerId,item.IsFolder,isRoot=(item as Folder)?.IsRoot,item.DateCreated,item.DateModified,item.DateLastSaved,item.DateLastRefreshed,
        physicalLocations=(item as Folder)?.PhysicalLocations.ToArray(),
        Genres=item.Genres.ToArray(), Studios=item.Studios.ToArray(), tmdbCollectionName=(item as Movie)?.TmdbCollectionName,
        item.Overview, item.RunTimeTicks, ProviderIds=item.ProviderIds.ToDictionary(pair=>pair.Key,pair=>pair.Value), item.IsLocked };
    private string? Relative(string? filename)=>filename is null?null:Path.GetRelativePath(CaseRoot,filename).Replace('\\','/');
    internal void Add(string action,object? detail)
    {
        lock (_traceLock) _trace.Enqueue(new { ordinal=++_sequence,phase=_phase,action,detail,
            scanRunning=Manager?.IsScanRunning??false });
    }

    private object? ObserveExternalCleanup(MethodInfo method, object?[]? values)
    {
        var actual = _actualExternalData ?? throw new InvalidOperationException("Actual external data cleanup is not installed.");
        if (method.Name is not ("DeleteExternalItemFiles" or "DeleteExternalItemDataAsync"))
            return ForwardProxy.Unused(method);
        var item = (BaseItem)values![0]!;
        var cleanupId = Interlocked.Increment(ref _nextExternalCleanup);
        Add("external-cleanup-begin", new { cleanupId, method = method.Name, item = Item(item), snapshot = ExternalCleanupSnapshot(item) });
        if (method.Name == "DeleteExternalItemDataAsync") return DeleteData();
        try
        {
            actual.DeleteExternalItemFiles(item);
            Add("external-cleanup-completed", new { cleanupId, method = method.Name, item = Item(item), snapshot = ExternalCleanupSnapshot(item) });
            return null;
        }
        catch (Exception error)
        {
            Add("external-cleanup-failed", new { cleanupId, method = method.Name, item = Item(item), error = error.ToString() });
            throw;
        }
        async Task DeleteData()
        {
            try
            {
                await actual.DeleteExternalItemDataAsync(item, (CancellationToken)values[1]!).ConfigureAwait(false);
                Add("external-cleanup-completed", new { cleanupId, method = method.Name, item = Item(item), snapshot = ExternalCleanupSnapshot(item) });
            }
            catch (Exception error)
            {
                Add("external-cleanup-failed", new { cleanupId, method = method.Name, item = Item(item), error = error.ToString() });
                throw;
            }
        }
    }

    private object ExternalCleanupSnapshot(BaseItem item)
    {
        var paths = PathManager.GetExtractedDataPaths(item).Select(directory =>
        {
            var absolute = Path.GetFullPath(directory);
            var relative = Path.GetRelativePath(CaseRoot, absolute);
            if (Path.IsPathRooted(relative) || relative == ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                throw new IOException("External data cleanup escaped the controlled case root: " + absolute);
            var exists = Directory.Exists(absolute);
            if ((exists || File.Exists(absolute)) && (File.GetAttributes(absolute) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("External data cleanup traversed a link: " + absolute);
            var files = new List<object>();
            void Visit(string current)
            {
                foreach (var filename in Directory.EnumerateFileSystemEntries(current).Order(StringComparer.Ordinal))
                {
                    var attributes = File.GetAttributes(filename);
                    if ((attributes & FileAttributes.ReparsePoint) != 0)
                        throw new IOException("External data observation traversed a link: " + filename);
                    if ((attributes & FileAttributes.Directory) != 0) Visit(filename);
                    else files.Add(new { path = Path.GetRelativePath(CaseRoot, filename).Replace('\\', '/'),
                        bytes = new FileInfo(filename).Length,
                        sha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(filename))) });
                }
            }
            if (exists) Visit(absolute);
            return new { path = absolute, relativePath = relative.Replace('\\', '/'),
                kind = exists ? "directory" : File.Exists(absolute) ? "file" : "absent", files };
        }).ToArray();
        using var context = Factory.CreateDbContext();
        var connection = context.Database.GetDbConnection(); connection.Open();
        var tables = new Dictionary<string, object>();
        foreach (var table in new[] { "KeyframeData", "MediaSegments", "TrickplayInfos", "Chapters" })
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT * FROM \"" + table + "\" ORDER BY rowid";
            using var reader = command.ExecuteReader();
            var rows = new List<Dictionary<string, object?>>();
            while (reader.Read())
            {
                var row = new Dictionary<string, object?>();
                for (var index = 0; index < reader.FieldCount; index++) row[reader.GetName(index)] = reader.IsDBNull(index) ? null : reader.GetValue(index);
                rows.Add(row);
            }
            tables[table] = rows;
        }
        return new { paths, tables };
    }

    public object QueueState()
    {
        var type = typeof(ProviderManager);
        var gate = (Lock)type.GetField("_refreshQueueLock", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Provider)!;
        lock (gate)
        {
            return new { queued = Provider.GetRefreshQueue().ToArray(),
                processing = (bool)type.GetField("_isProcessingRefreshQueue", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Provider)! };
        }
    }

    private sealed class QueueRequest(int id, Guid itemId, IDirectoryService directory, string phase)
    {
        public int Id = id;
        public Guid ItemId = itemId;
        public IDirectoryService Directory = directory;
        public string Phase = phase;
        public int Started, Completed, Failed;
        public bool Drained;
    }

    private void ObserveQueueRefresh(Guid itemId, MetadataRefreshOptions options, RefreshPriority priority)
    {
        var request = new QueueRequest(Interlocked.Increment(ref _nextQueueRequest), itemId, options.DirectoryService, _phase);
        _queueRequests.Enqueue(request);
        Add("queue-admission-begin", new { requestId = request.Id, itemId, options = new { options.MetadataRefreshMode,
            options.ImageRefreshMode, options.ForceSave, options.ReplaceAllMetadata, options.IsAutomated,
            options.RemoveOldMetadata, options.RefreshPaths }, priority, queue = QueueState() });
        Provider.QueueRefresh(itemId, options, priority);
        Add("queue-admission-returned", new { requestId = request.Id, itemId, queue = QueueState() });
    }

    // Every interface member delegates to the same actual ProviderManager.
    // Only admission and metadata completion add observations; provider
    // selection, returned values, events and generic constraints stay actual.
    private sealed class ObservedProviderManager(NativeScanHost host, IProviderManager actual) : IProviderManager
    {
        public event EventHandler<GenericEventArgs<BaseItem>> RefreshStarted
        { add => actual.RefreshStarted += value; remove => actual.RefreshStarted -= value; }
        public event EventHandler<GenericEventArgs<BaseItem>> RefreshCompleted
        { add => actual.RefreshCompleted += value; remove => actual.RefreshCompleted -= value; }
        public event EventHandler<GenericEventArgs<Tuple<BaseItem, double>>> RefreshProgress
        { add => actual.RefreshProgress += value; remove => actual.RefreshProgress -= value; }

        public void QueueRefresh(Guid itemId, MetadataRefreshOptions options, RefreshPriority priority)
            => host.ObserveQueueRefresh(itemId, options, priority);
        public Task RefreshFullItem(BaseItem item, MetadataRefreshOptions options, CancellationToken cancellationToken)
            => actual.RefreshFullItem(item, options, cancellationToken);
        public Task<ItemUpdateType> RefreshSingleItem(BaseItem item, MetadataRefreshOptions options, CancellationToken cancellationToken)
            => host.ObserveQueuedMetadata(item, options, cancellationToken);
        public Task SaveImage(BaseItem item, string url, ImageType type, int? imageIndex, CancellationToken cancellationToken)
            => actual.SaveImage(item, url, type, imageIndex, cancellationToken);
        public Task SaveImage(BaseItem item, Stream source, string mimeType, ImageType type, int? imageIndex, CancellationToken cancellationToken)
            => actual.SaveImage(item, source, mimeType, type, imageIndex, cancellationToken);
        public Task SaveImage(BaseItem item, string source, string mimeType, ImageType type, int? imageIndex,
            bool? saveLocallyWithMedia, CancellationToken cancellationToken)
            => actual.SaveImage(item, source, mimeType, type, imageIndex, saveLocallyWithMedia, cancellationToken);
        public Task SaveImage(Stream source, string mimeType, string path) => actual.SaveImage(source, mimeType, path);
        public void AddParts(IEnumerable<IImageProvider> imageProviders, IEnumerable<IMetadataService> metadataServices,
            IEnumerable<IMetadataProvider> metadataProviders, IEnumerable<IMetadataSaver> metadataSavers,
            IEnumerable<IExternalId> externalIds, IEnumerable<IExternalUrlProvider> externalUrlProviders)
            => actual.AddParts(imageProviders, metadataServices, metadataProviders, metadataSavers, externalIds, externalUrlProviders);
        public Task<IEnumerable<RemoteImageInfo>> GetAvailableRemoteImages(BaseItem item, RemoteImageQuery query,
            CancellationToken cancellationToken) => actual.GetAvailableRemoteImages(item, query, cancellationToken);
        public IEnumerable<ImageProviderInfo> GetRemoteImageProviderInfo(BaseItem item) => actual.GetRemoteImageProviderInfo(item);
        public IEnumerable<IImageProvider> GetImageProviders(BaseItem item, ImageRefreshOptions refreshOptions)
            => actual.GetImageProviders(item, refreshOptions);
        public IEnumerable<IMetadataProvider<T>> GetMetadataProviders<T>(BaseItem item, LibraryOptions libraryOptions)
            where T : BaseItem => actual.GetMetadataProviders<T>(item, libraryOptions);
        public IEnumerable<IMetadataProvider<T>> GetMetadataProviders<T>(BaseItem item, LibraryOptions libraryOptions, bool includeDisabled)
            where T : BaseItem => actual.GetMetadataProviders<T>(item, libraryOptions, includeDisabled);
        public IEnumerable<IMetadataSaver> GetMetadataSavers(BaseItem item, LibraryOptions libraryOptions)
            => actual.GetMetadataSavers(item, libraryOptions);
        public MetadataPluginSummary[] GetAllMetadataPlugins() => actual.GetAllMetadataPlugins();
        public IEnumerable<ExternalUrl> GetExternalUrls(BaseItem item) => actual.GetExternalUrls(item);
        public IEnumerable<ExternalIdInfo> GetExternalIdInfos(IHasProviderIds item) => actual.GetExternalIdInfos(item);
        public Task SaveMetadataAsync(BaseItem item, ItemUpdateType updateType) => actual.SaveMetadataAsync(item, updateType);
        public Task SaveMetadataAsync(BaseItem item, ItemUpdateType updateType, IEnumerable<string> savers)
            => actual.SaveMetadataAsync(item, updateType, savers);
        public MetadataOptions GetMetadataOptions(BaseItem item) => actual.GetMetadataOptions(item);
        public Task<IEnumerable<RemoteSearchResult>> GetRemoteSearchResults<TItemType, TLookupType>(
            RemoteSearchQuery<TLookupType> searchInfo, CancellationToken cancellationToken)
            where TItemType : BaseItem, new()
            where TLookupType : ItemLookupInfo
            => actual.GetRemoteSearchResults<TItemType, TLookupType>(searchInfo, cancellationToken);
        public HashSet<Guid> GetRefreshQueue() => actual.GetRefreshQueue();
        public void OnRefreshStart(BaseItem item) => actual.OnRefreshStart(item);
        public void OnRefreshProgress(BaseItem item, double progress) => actual.OnRefreshProgress(item, progress);
        public void OnRefreshComplete(BaseItem item) => actual.OnRefreshComplete(item);
        public double? GetRefreshProgress(Guid id) => actual.GetRefreshProgress(id);
    }

    private async Task<ItemUpdateType> ObserveQueuedMetadata(BaseItem item, MetadataRefreshOptions options, CancellationToken token)
    {
        // BaseItem may copy options to add ForceSave. Its real copy constructor
        // retains DirectoryService, so correlation never mutates the request.
        var request = _queueRequests.FirstOrDefault(value => value.ItemId == item.Id
            && ReferenceEquals(value.Directory, options.DirectoryService) && value.Started == 0);
        if (request is null) return await Provider.RefreshSingleItem(item, options, token);
        request.Started++;
        Add("queue-metadata-start", new { requestId = request.Id, itemId = item.Id, item = Item(item) });
        try
        {
            var result = await Provider.RefreshSingleItem(item, options, token);
            request.Completed++;
            Add("queue-metadata-completed", new { requestId = request.Id, itemId = item.Id, updateType = (int)result, item = Item(item) });
            return result;
        }
        catch (Exception error)
        {
            request.Failed++;
            Add("queue-metadata-failed", new { requestId = request.Id, itemId = item.Id, error = error.ToString() });
            throw;
        }
    }

    // Reflection observes the real queue under its own lock; it does not replace
    // its worker, dequeue work, alter flags, or force a metadata refresh.
    public async Task DrainMetadataQueueAsync()
    {
        Add("queue-drain-begin", QueueState());
        var timer = Stopwatch.StartNew();
        var type = typeof(ProviderManager);
        var gate = (Lock)type.GetField("_refreshQueueLock", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Provider)!;
        while (true)
        {
            bool running;
            lock (gate) running = (bool)type.GetField("_isProcessingRefreshQueue", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Provider)!;
            if (!running) break;
            if (timer.Elapsed > TimeSpan.FromSeconds(30)) throw new TimeoutException("The actual native metadata queue did not drain.");
            await Task.Delay(10);
        }
        var state = QueueState();
        // This acknowledgement is observed only after the actual worker has
        // stood down. It includes its real post-metadata Folder validation;
        // it is not a fabricated per-entry completion timestamp.
        foreach (var request in _queueRequests.Where(value => !value.Drained))
        {
            request.Drained = true;
            Add("queue-request-drained", new { requestId = request.Id, itemId = request.ItemId,
                request.Started, request.Completed, request.Failed, queue = state });
        }
        Add("queue-drain-completed", state);
    }

    private sealed class ObservedPostScanTask(NativeScanHost host, ILibraryPostScanTask actual) : ILibraryPostScanTask
    {
        public async Task Run(IProgress<double> progress, CancellationToken token)
        {
            host.Add("post-task-begin", new { type = actual.GetType().FullName, queue = host.QueueState() });
            await actual.Run(progress, token);
            host.Add("post-task-completed", new { type = actual.GetType().FullName, queue = host.QueueState() });
        }
    }

    public async ValueTask DisposeAsync()
    {
        if(_disposed)return;_disposed=true;
        var failures = new List<Exception>();
        try { await DrainMetadataQueueAsync(); } catch (Exception error) { failures.Add(error); }
        async Task Release(string name, Func<Task> action)
        {
            try { await action(); ReleasedResources.Add(name); }
            catch (Exception error) { failures.Add(error); }
        }
        _lifetime.StopApplication();
        await Release("scheduler", () => _scheduler.DisposeAsync().AsTask());
        await Release("provider", () => { Provider.Dispose(); return Task.CompletedTask; });
        foreach (var owned in _ownedResources)
            await Release(owned.Name, () => { owned.Resource.Dispose(); return Task.CompletedTask; });
        await Release("plugins", () => { _plugins.Dispose(); return Task.CompletedTask; });
        await Release("services", async () => {
            if(ServiceProvider is IAsyncDisposable asyncDisposable)await asyncDisposable.DisposeAsync();
            else if(ServiceProvider is IDisposable disposable)disposable.Dispose();
        });
        await Release("cache-and-tokens", () => { _cache.Dispose();_cancel.Dispose();_lifetime.Dispose();return Task.CompletedTask; });
        if (failures.Count > 0) throw new AggregateException("Native Movie fixture owners failed to close.", failures);
    }

    private sealed class SentinelTask(NativeScanHost host,string name):ILibraryPostScanTask
    {
        public Task Run(IProgress<double> progress,CancellationToken token)
        {
            host.Add("post-task-begin",new { name,cancelled=token.IsCancellationRequested,sql=host.SnapshotSql() });
            token.ThrowIfCancellationRequested();progress.Report(25);progress.Report(100);
            host.Add("post-task-end",new { name });return Task.CompletedTask;
        }
    }
    private sealed class ObservedMetadataService(NativeScanHost host,IMetadataService actual):IMetadataService
    {
        public int Order=>actual.Order;
        public bool CanRefresh(BaseItem item)=>actual.CanRefresh(item);
        public bool CanRefreshPrimary(Type type)=>actual.CanRefreshPrimary(type);
        public Task<ItemUpdateType> RefreshMetadata(BaseItem item,MetadataRefreshOptions options,CancellationToken token)
            =>host.RefreshSingleItem(actual,item,options,token);
    }
    private sealed class InlineProgress(Action<double> report):IProgress<double>
    { public void Report(double value)=>report(value); }
    private sealed class ControlledLifetime:IHostApplicationLifetime,IDisposable
    {
        private readonly CancellationTokenSource _stopping=new();
        public CancellationToken ApplicationStarted=>CancellationToken.None;
        public CancellationToken ApplicationStopping=>_stopping.Token;
        public CancellationToken ApplicationStopped=>CancellationToken.None;
        public void StopApplication()=>_stopping.Cancel();
        public void Dispose()=>_stopping.Dispose();
    }
    private sealed class ObservationLoggerFactory(NativeScanHost host):ILoggerFactory
    {
        public ILogger CreateLogger(string categoryName)=>new ObservationLogger(host,categoryName);
        public void AddProvider(ILoggerProvider provider) { }
        public void Dispose() { }
    }
    private sealed class ObservationLogger(NativeScanHost host,string category):ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState:notnull=>null;
        public bool IsEnabled(LogLevel level)=>true;
        public void Log<TState>(LogLevel level,EventId eventId,TState state,Exception? exception,Func<TState,Exception?,string> formatter)
        {
            if(level>=LogLevel.Debug||exception is not null)host.Add("log",new { category,level=level.ToString(),
                message=formatter(state,exception),exception=exception?.GetType().FullName,
                exceptionDetails=exception?.ToString() });
        }
    }
}

public sealed class SqlFactory(string filename):IDbContextFactory<JellyfinDbContext>
{
    public string Filename=>filename;
    public JellyfinDbContext CreateDbContext()=>new(new DbContextOptionsBuilder<JellyfinDbContext>()
        .UseSqlite($"Data Source={filename};Pooling=False").Options,NullLogger<JellyfinDbContext>.Instance,
        new SqliteDatabaseProvider(null!,NullLogger<SqliteDatabaseProvider>.Instance),new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}

public class ForwardProxy:DispatchProxy
{
    public Func<MethodInfo,object?[]?,object?> Handler=null!;
    protected override object? Invoke(MethodInfo? targetMethod,object?[]? args)=>Handler(targetMethod!,args);
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class
    {
        var proxy=Create<T,ForwardProxy>();((ForwardProxy)(object)proxy).Handler=handler;return proxy;
    }
    public static object? Forward(object target,MethodInfo method,object?[]? values)
    {
        try{return method.Invoke(target,values);}
        catch(TargetInvocationException e) when(e.InnerException is not null){ExceptionDispatchInfo.Capture(e.InnerException).Throw();throw;}
    }
    public static object? Unused(MethodInfo method)=>throw new NotSupportedException("Unconfigured explicit harness dependency: "+method.DeclaringType?.FullName+"."+method.Name);
}
