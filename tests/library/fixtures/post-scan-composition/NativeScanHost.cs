// Derived from the actual eight-task composition host; new recordings are built
// and executed against the current CI native reference, never historical binaries.
using System.Collections.Concurrent;
using System.Data.Common;
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
using MediaBrowser.Model.Tasks;
using MediaBrowser.Providers.Folders;
using MediaBrowser.Providers.Genres;
using MediaBrowser.Providers.Music;
using MediaBrowser.Providers.MusicGenres;
using MediaBrowser.Providers.Studios;
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
    public CompositionSeed Seed { get; set; } = new();
}
public sealed class CompositionSeed
{
    public string SourceName { get; set; } = "";
    public string Genre { get; set; } = "";
    public string Studio { get; set; } = "";
    public string DeadGenre { get; set; } = "";
    public string DeadStudio { get; set; } = "";
    public string OrphanValue { get; set; } = "";
    public MusicCompositionSeed? Music { get; set; }
}
public sealed class MusicCompositionSeed
{
    public string DeadArtist { get; set; } = "";
    public AudioCompositionSeed[] Tracks { get; set; } = [];
}
public sealed class AudioCompositionSeed
{
    public string Name { get; set; } = "";
    public string[] Artists { get; set; } = [];
    public string[] AlbumArtists { get; set; } = [];
    public string[] Genres { get; set; } = [];
    public long RunTimeTicks { get; set; }
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
    // provider | global | metadata-before. Cancellation only changes the real token.
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
    private readonly ConcurrentDictionary<string, byte> _committed = new(StringComparer.OrdinalIgnoreCase);
    private readonly CancellationTokenSource _cancel = new();
    private readonly ControlledLifetime _lifetime = new();
    private readonly MemoryCache _cache = new(new MemoryCacheOptions());
    private readonly List<double> _progress = new();
    private readonly object _progressLock = new();
    private PluginManager _plugins = null!;
    private LimitedConcurrencyLibraryScheduler _scheduler = null!;
    private IProviderManager _providerDispatch = null!;
    private bool _observing;
    private int _sequence, _faultOccurrence;
    private bool _disposed;
    public bool DisposalCompleted { get; private set; }
    public List<string> ReleasedResources { get; } = [];
    public string CaseRoot { get; }
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
    public IItemPersistenceService Persistence { get; private set; } = null!;
    public IPathManager PathManager { get; private set; } = null!;
    public SqlFactory Factory { get; private set; } = null!;
    public IDirectoryService DirectoryService { get; private set; } = null!;
    public IServerApplicationHost AppHost { get; private set; } = null!;
    public IReadOnlyList<object> Trace => _trace.ToArray();
    public List<IMetadataService> MetadataServices { get; } = [];
    public List<IMetadataProvider> MetadataProviders { get; } = [];
    public List<IImageProvider> ImageProviders { get; } = [];
    public List<IMetadataSaver> MetadataSavers { get; } = [];
    public List<IExternalId> ExternalIds { get; } = [];
    public List<IExternalUrlProvider> ExternalUrls { get; } = [];
    public string[] ResolverTypes { get; private set; } = [];
    public string[] PostScanTaskTypes { get; private set; } = [];
    public string[] DiscoveredPostScanTaskTypes { get; private set; } = [];

    private NativeScanHost(string root, Scenario scenario) { CaseRoot = root; Scenario = scenario; }

    public static Task<NativeScanHost> CreateAsync(string root, Scenario scenario,
        Func<IServerApplicationPaths, IServerConfigurationManager, IFileSystem, IImageProcessor>? imageProcessorFactory = null)
    {
        root = Path.GetFullPath(root);
        if (Directory.Exists(root) || File.Exists(root)) throw new IOException("Case root must be fresh: " + root);
        Directory.CreateDirectory(root);
        var host = new NativeScanHost(root, scenario);
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
            ["StudioPath"] = Path.Combine(program,"metadata","Studio"), ["YearPath"] = Path.Combine(program,"metadata","years") };
        foreach (var directory in strings.Values) Directory.CreateDirectory(directory);
        Directory.CreateDirectory(MediaRoot);
        Paths = ForwardProxy.Make<IServerApplicationPaths>((method, values) => method.Name.StartsWith("get_",StringComparison.Ordinal)
            && strings.TryGetValue(method.Name[4..],out var value) ? value : ForwardProxy.Unused(method));
        var server = new ServerConfiguration { CacheSize = 128, LibraryScanFanoutConcurrency = Scenario.Fanout,
            IsStartupWizardCompleted = true, EnableCaseSensitiveItemIds = true, EnableNormalizedItemByNameIds = true };
        Configuration = ForwardProxy.Make<IServerConfigurationManager>((method, values) => method.Name switch {
            "get_Configuration" => server, "get_ApplicationPaths" => Paths,
            "GetConfiguration" when values?[0] as string == "metadata" => new MetadataConfiguration { UseFileCreationTimeForDateAdded = true },
            _ when method.Name.StartsWith("add_",StringComparison.Ordinal) || method.Name.StartsWith("remove_",StringComparison.Ordinal) => null,
            _ => ForwardProxy.Unused(method) });
        AppHost = ForwardProxy.Make<IServerApplicationHost>((method, values) => method.Name is "ExpandVirtualPath" or "ReverseVirtualPath"
            ? values![0] : ForwardProxy.Unused(method));
        var loggerFactory = new ObservationLoggerFactory(this);
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
        using (var initial = Factory.CreateDbContext()) initial.Database.EnsureCreated();
        Repository = new BaseItemRepository(Factory, AppHost, new ItemTypeLookup(), Configuration, loggerFactory.CreateLogger<BaseItemRepository>());
        var actualPersistence = new ItemPersistenceService(Factory, AppHost, loggerFactory.CreateLogger<ItemPersistenceService>());
        Persistence = actualPersistence;
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
        var monitor = ForwardProxy.Make<ILibraryMonitor>((method, values) => {
            Add("monitor-"+method.Name,new { scanRunning=Manager?.IsScanRunning });
            return method.ReturnType == typeof(void) ? null : ForwardProxy.Unused(method);
        });
        var localization = new LocalizationManager(Configuration,loggerFactory.CreateLogger<LocalizationManager>());
        var naming = new NamingOptions();
        var pathManager = new PathManager(loggerFactory.CreateLogger<PathManager>(), Configuration, Paths);
        PathManager = pathManager;
        // These by-name operations call the real file cleanup method. Unused
        // video managers are not substituted with successful no-op operations.
        ExternalData = new ExternalDataManager(null!, null!, pathManager, null!, null!, loggerFactory.CreateLogger<ExternalDataManager>());
        var linkedChildren = new LinkedChildrenService(Factory,new ItemTypeLookup(),Repository);
        var userData = ForwardProxy.Make<IUserDataManager>((method,values)=>ForwardProxy.Unused(method));
        Manager = new LibraryManager(AppHost,loggerFactory,
            ForwardProxy.Make<ITaskManager>((method,values)=>ForwardProxy.Unused(method)),null!,Configuration,userData,
            new(()=>monitor),FileSystem,new(()=>_providerDispatch),new(()=>null!),Repository,persistence,null!,null!,
            linkedChildren,ImageProcessor,naming,DirectoryService,null!,
            pathManager,new DotIgnoreIgnoreRule(),localization,null!,new(()=>ExternalData));
        Provider = new ProviderManager(null!,null!,Configuration,monitor,loggerFactory.CreateLogger<ProviderManager>(),
            FileSystem,Paths,Manager,new BaseItemManager(Configuration),null!,_cache,null!,null!);
        _providerDispatch=Provider;
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
        MetadataServices.Add(new GenreMetadataService(Configuration,loggerFactory.CreateLogger<GenreMetadataService>(),
            _providerDispatch,FileSystem,Manager,ExternalData,Repository));
        MetadataServices.Add(new StudioMetadataService(Configuration,loggerFactory.CreateLogger<StudioMetadataService>(),
            _providerDispatch,FileSystem,Manager,ExternalData,Repository));
        if (Scenario.Seed.Music is not null)
        {
            MetadataServices.Add(new ArtistMetadataService(Configuration,loggerFactory.CreateLogger<ArtistMetadataService>(),
                _providerDispatch,FileSystem,Manager,ExternalData,Repository));
            MetadataServices.Add(new MusicGenreMetadataService(Configuration,loggerFactory.CreateLogger<MusicGenreMetadataService>(),
                _providerDispatch,FileSystem,Manager,ExternalData,Repository));
        }
        ApplyProviderParts();
        var services=new ServiceCollection();services.AddSingleton<ILoggerFactory>(loggerFactory);services.AddLogging();
        services.AddSingleton(Paths);services.AddSingleton(Configuration);services.AddSingleton(FileSystem);services.AddSingleton(ImageProcessor);
        services.AddSingleton<ILibraryManager>(Manager);services.AddSingleton<IItemRepository>(Repository);services.AddSingleton(ExternalData);
        services.AddSingleton<IProviderManager>(_providerDispatch);services.AddSingleton(DirectoryService);services.AddSingleton(localization);
        services.AddSingleton<MediaBrowser.Model.Globalization.ILocalizationManager>(localization);
        services.AddSingleton(naming);services.AddSingleton(new VideoListResolver(naming));services.AddSingleton(AppHost);
        services.AddSingleton<IDbContextFactory<JellyfinDbContext>>(Factory);
        services.AddSingleton<IPathManager>(pathManager);
        services.AddSingleton<MediaBrowser.Common.Configuration.IApplicationPaths>(Paths);
        services.AddSingleton<IImageEncoder>(new Jellyfin.Drawing.Skia.SkiaEncoder(loggerFactory.CreateLogger<Jellyfin.Drawing.Skia.SkiaEncoder>(),Paths));
        services.AddSingleton<MediaBrowser.Controller.Collections.ICollectionManager>(new Emby.Server.Implementations.Collections.CollectionManager(
            Manager,Paths,localization,FileSystem,monitor,loggerFactory,_providerDispatch,linkedChildren));
        ServiceProvider=services.BuildServiceProvider();
        var discovery=(CoreAppHost)RuntimeHelpers.GetUninitializedObject(typeof(CoreAppHost));
        typeof(ApplicationHost).GetField("<Logger>k__BackingField",BindingFlags.Instance|BindingFlags.NonPublic)!
            .SetValue(discovery,loggerFactory.CreateLogger<ApplicationHost>());
        _plugins=new PluginManager(loggerFactory.CreateLogger<PluginManager>(),discovery,server,Path.Combine(CaseRoot,"no-installed-plugins"),typeof(CoreAppHost).Assembly.GetName().Version!);
        typeof(ApplicationHost).GetField("_pluginManager",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(discovery,_plugins);
        typeof(ApplicationHost).GetMethod("DiscoverTypes",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(discovery,null);
        discovery.ServiceProvider=ServiceProvider;
        var resolvers=discovery.GetExports<IItemResolver>(false).ToArray();
        var ignoreRules=discovery.GetExports<IResolverIgnoreRule>(false).ToArray();
        ResolverTypes=resolvers.Select(r=>r.GetType().FullName!).ToArray();
        DiscoveredPostScanTaskTypes=discovery.GetExportTypes<ILibraryPostScanTask>().Select(type=>type.FullName!).ToArray();
        var postScanTasks=discovery.GetExports<ILibraryPostScanTask>(false).ToArray();
        PostScanTaskTypes=postScanTasks.Select(task=>task.GetType().FullName!).ToArray();
        if(!DiscoveredPostScanTaskTypes.SequenceEqual(PostScanTaskTypes))throw new InvalidOperationException("Not every discovered actual post-scan task could be constructed.");
        Manager.AddParts(ignoreRules,resolvers,[],[],postScanTasks);
        Manager.ItemAdded+=(_,e)=>Add("added",new { item=Item(e.Item),parent=e.Parent?.Id });
        Manager.ItemUpdated+=(_,e)=>Add("updated",new { item=Item(e.Item),parent=e.Parent?.Id });
        Manager.ItemRemoved+=(_,e)=>Add("removed",new { item=Item(e.Item),parent=e.Parent?.Id });
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
        while(_trace.TryDequeue(out _)) { }
        lock(_progressLock)_progress.Clear();
        _sequence=0;_faultOccurrence=0;
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
        _observing=false;
        return new ScanObservation(exception,message,Manager.IsScanRunning,RootSnapshot(),SnapshotSql(),
            _trace.ToArray(),ResolverTypes,MetadataServices.Select(s=>s.GetType().FullName!).ToArray());
    }

    private async Task<MediaBrowser.Controller.Library.ItemUpdateType> RefreshSingleItem(IMetadataService service,BaseItem item,
        MetadataRefreshOptions options,CancellationToken token)
    {
        Add("metadata-begin",new { item=Item(item),options.MetadataRefreshMode,options.ImageRefreshMode,
            options.IsAutomated,cancelled=token.IsCancellationRequested });
        if(_observing)MaybeCancel("metadata-before",item,0);
        ItemUpdateType result;
        try { result=await service.RefreshMetadata(item,options,token); }
        catch(OperationCanceledException error)
        {
            Add("metadata-cancelled",new { item=Item(item),cancelled=token.IsCancellationRequested,
                exception=error.GetType().FullName });
            throw;
        }
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
            "@studio"=>item.GetType()==typeof(Studio),
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
        var wanted=new HashSet<string>(["BaseItems","AncestorIds","ItemValues","ItemValuesMap","LinkedChildren","UserData","BaseItemImageInfos","Images"],StringComparer.Ordinal);
        var result=new Dictionary<string,object>();
        foreach(var table in tables.Where(wanted.Contains))
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

    private object Item(BaseItem item)=>new { id=item.Id,type=item.GetType().FullName,item.Name,path=Relative(item.Path),
        item.ParentId,item.OwnerId,item.IsFolder,isRoot=(item as Folder)?.IsRoot,item.DateCreated,item.DateModified,item.DateLastSaved,item.DateLastRefreshed,
        physicalLocations=(item as Folder)?.PhysicalLocations.Select(Relative).ToArray() };
    private string? Relative(string? filename)=>filename is null?null:Path.GetRelativePath(CaseRoot,filename).Replace('\\','/');
    internal void Add(string action,object? detail)=>_trace.Enqueue(new { ordinal=Interlocked.Increment(ref _sequence),action,detail,
        scanRunning=Manager?.IsScanRunning??false });

    public async ValueTask DisposeAsync()
    {
        if(_disposed)return;_disposed=true;
        _lifetime.StopApplication();await _scheduler.DisposeAsync();ReleasedResources.Add("scheduler");
        Provider.Dispose();ReleasedResources.Add("provider");
        _plugins.Dispose();ReleasedResources.Add("plugins");
        if(ServiceProvider is IAsyncDisposable asyncDisposable)await asyncDisposable.DisposeAsync();
        else if(ServiceProvider is IDisposable disposable)disposable.Dispose();
        ReleasedResources.Add("services");
        _cache.Dispose();_cancel.Dispose();_lifetime.Dispose();ReleasedResources.Add("cache-and-tokens");
        DisposalCompleted=true;
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
            if(level>=LogLevel.Information||exception is not null)host.Add("log",new { category,level=level.ToString(),
                message=formatter(state,exception),exception=exception?.GetType().FullName });
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
