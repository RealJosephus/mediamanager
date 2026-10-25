using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using System.Text.Json;
using Emby.Server.Implementations.IO;
using Emby.Server.Implementations.Data;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Database.Providers.Sqlite;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.LiveTv;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.Extensions.Logging.Abstractions;
using BaseItemEntity = Jellyfin.Database.Implementations.Entities.BaseItemEntity;

SQLitePCL.Batteries_V2.Init();
Video.RecordingsManager = Stub.Make<IRecordingsManager>((method, values) => Stub.Default(method.ReturnType));
BaseItem.MediaSourceManager = Stub.Make<IMediaSourceManager>((method, values) => method.Name switch {
    "GetPathProtocol" => MediaProtocol.File, "GetMediaStreams" => Array.Empty<MediaStream>(),
    "GetStaticMediaSources" => Array.Empty<MediaSourceInfo>(), _ => Stub.Default(method.ReturnType)
});
var root = Path.GetFullPath(Path.Combine(args[0], "instance")); Directory.CreateDirectory(root);
    var metadata = Path.Combine(root, "metadata");
    var configuration = new ServerConfiguration { CacheSize = 64,
        EnableCaseSensitiveItemIds = false, EnableNormalizedItemByNameIds = true };
    var paths = Stub.Make<IServerApplicationPaths>((method, values) => method.Name switch {
        "get_ProgramDataPath" => root, "get_InternalMetadataPath" => metadata,
        "get_DataPath" => Path.Combine(root, "data"), "get_MusicGenrePath" => Path.Combine(metadata, "MusicGenre"),
        "get_GenrePath" => Path.Combine(metadata, "Genre"), "get_StudioPath" => Path.Combine(metadata, "Studio"),
        _ => Stub.Default(method.ReturnType)
    });
    var config = Stub.Make<IServerConfigurationManager>((method, values) => method.Name switch {
        "get_Configuration" => configuration, "get_ApplicationPaths" => paths,
        "GetConfiguration" => new MetadataConfiguration(), _ => Stub.Default(method.ReturnType)
    });
    BaseItem.ConfigurationManager = config;
    BaseItem.Logger = NullLogger<BaseItem>.Instance;
    BaseItem.LocalizationManager = new LocalizationManager(config, NullLogger<LocalizationManager>.Instance);
    BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, paths, []);
    var appHost = Stub.Make<IServerApplicationHost>((method, values) => {
        if (method.Name == "ReverseVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith(metadata, StringComparison.Ordinal) == true ? "%MetadataPath%" + value[metadata.Length..] : value;
        }
        if (method.Name == "ExpandVirtualPath") {
            var value = (string?)values![0];
            return value?.StartsWith("%MetadataPath%", StringComparison.Ordinal) == true ? metadata + value[14..] : value;
        }
        return Stub.Default(method.ReturnType);
    });
    var factory = new SqlFactory(Path.Combine(root, "native.db"));
    using (var initial = factory.CreateDbContext()) initial.Database.EnsureCreated();
    var repository = new BaseItemRepository(factory, appHost, new ItemTypeLookup(), config, NullLogger<BaseItemRepository>.Instance);
    BaseItem.ItemRepository = repository;
    var persistence = new ItemPersistenceService(factory, appHost, NullLogger<ItemPersistenceService>.Instance);

var rows = new List<BaseItemEntity>();
void Row(int number, string kind, string? name, string? clean = null, bool locked = false, Guid? owner = null, Guid? primary = null) {
    rows.Add(new BaseItemEntity { Id = Id(number), Type = kind == "MusicGenre" ? typeof(MusicGenre).FullName! : kind == "Movie" ? typeof(Movie).FullName! : kind == "Studio" ? typeof(Studio).FullName! : typeof(Genre).FullName!,
        Name = name, CleanName = clean ?? name, SortName = number.ToString("D4"), Data = "{}", IsLocked = locked,
        OwnerId = owner, PrimaryVersionId = primary, Path = Path.Combine(metadata, kind, number.ToString()) });
}
Row(10,"Genre","Alive","unrelated"); Row(11,"Genre","alive"); Row(12,"Genre","Accent","accent");
Row(13,"Genre"," Spaced "); Row(14,"Genre","Shared"); Row(15,"Genre","Studio-only");
Row(16,"MusicGenre","Music-alive"); Row(17,"MusicGenre","Music-dead"); Row(18,"Genre","");
Row(19,"Genre",null); Row(20,"Genre","Locked",locked:true); Row(21,"Genre","Unlocked");
Row(22,"Genre","Owned",owner:Id(900)); Row(23,"Genre","Alternate",primary:Id(900));
Row(30,"Studio","Alive","unrelated"); Row(31,"Studio","alive"); Row(32,"Studio","Shared");
Row(33,"Studio","Studio-only"); Row(34,"Studio","Accent","accent"); Row(35,"Studio",""); Row(36,"Studio",null);
Row(37,"Studio","Locked",locked:true); Row(38,"Studio","Unlocked");
Row(39,"Studio","Owned",owner:Id(900)); Row(40,"Studio","Alternate",primary:Id(900));
Row(50,"Movie","Movie-dead"); Row(51,"Movie","Mapped source");
var values = new List<Jellyfin.Database.Implementations.Entities.ItemValue>();
void Value(int number,int type,string value,string clean) => values.Add(new() { ItemValueId=Id(number), Type=(Jellyfin.Database.Implementations.Entities.ItemValueType)type, Value=value,CleanValue=clean });
Value(100,2,"Alive","different-clean"); Value(101,2,"ÀCCÉNT","accent"); Value(102,2,"Spaced","spaced");
Value(103,2,"Shared","shared"); Value(104,3,"Studio-only","irrelevant"); Value(105,2,"Music-alive","irrelevant");
Value(106,2,"",""); Value(107,3,"Alive","different-clean"); Value(108,3,"ACCENT","accent"); Value(109,4,"Music-dead","irrelevant");
var maps = new[] { new Jellyfin.Database.Implementations.Entities.ItemValueMap { ItemId=Id(51),ItemValueId=Id(100),Item=null!,ItemValue=null! } };
using(var context=factory.CreateDbContext()) { context.BaseItems.Add(new BaseItemEntity { Id=Id(900), Type=typeof(Folder).FullName!,Name="FK anchor",IsFolder=true }); context.SaveChanges();
    context.BaseItems.AddRange(rows);context.ItemValues.AddRange(values);context.ItemValuesMap.AddRange(maps);context.SaveChanges(); }
var observations = new List<object>();
foreach(var kinds in new[] { new[] { Jellyfin.Data.Enums.BaseItemKind.Genre,Jellyfin.Data.Enums.BaseItemKind.MusicGenre }, new[] { Jellyfin.Data.Enums.BaseItemKind.Studio }, Array.Empty<Jellyfin.Data.Enums.BaseItemKind>() })
foreach(var flag in new bool?[] { null, false, true }) {
 var query=new InternalItemsQuery { IncludeItemTypes=kinds, IsDeadGenre=kinds.Contains(Jellyfin.Data.Enums.BaseItemKind.Studio)?null:flag,
 IsDeadStudio=kinds.Contains(Jellyfin.Data.Enums.BaseItemKind.Studio)?flag:null, IsLocked=false, OrderBy=[(Jellyfin.Data.Enums.ItemSortBy.SortName,Jellyfin.Database.Implementations.Enums.SortOrder.Ascending)] };
 var result=repository.GetItems(query); observations.Add(new { kinds,kindNames=kinds.Select(kind=>kind.ToString()).ToArray(),flag,deadGenre=query.IsDeadGenre,deadStudio=query.IsDeadStudio,
 locked=query.IsLocked,start=query.StartIndex,limit=query.Limit,result.TotalRecordCount, ids=result.Items.Select(item=>item.Id).ToArray() });
}
foreach(var index in Enumerable.Range(0,4)) {
 var query=new InternalItemsQuery { IncludeItemTypes=[Jellyfin.Data.Enums.BaseItemKind.Genre,Jellyfin.Data.Enums.BaseItemKind.MusicGenre], IsDeadGenre=true, IsLocked=false,
 StartIndex=index,Limit=index==0?0:2,OrderBy=[(Jellyfin.Data.Enums.ItemSortBy.SortName,Jellyfin.Database.Implementations.Enums.SortOrder.Ascending)] };
 var result=repository.GetItems(query);observations.Add(new { kinds=query.IncludeItemTypes,kindNames=query.IncludeItemTypes.Select(kind=>kind.ToString()).ToArray(), flag=(bool?)true,deadGenre=query.IsDeadGenre,deadStudio=query.IsDeadStudio,
 locked=query.IsLocked,start=query.StartIndex,limit=query.Limit,result.TotalRecordCount,ids=result.Items.Select(item=>item.Id).ToArray() });
}
foreach (var sample in new[] { (Genre: (bool?)null, Studio:(bool?)true, Locked:(bool?)false), (Genre:(bool?)true,Studio:(bool?)true,Locked:(bool?)false), (Genre:(bool?)true,Studio:(bool?)null,Locked:(bool?)null), (Genre:(bool?)null,Studio:(bool?)true,Locked:(bool?)null) }) {
 var query = new InternalItemsQuery { IsDeadGenre=sample.Genre,IsDeadStudio=sample.Studio,IsLocked=sample.Locked,
 OrderBy=[(Jellyfin.Data.Enums.ItemSortBy.SortName,Jellyfin.Database.Implementations.Enums.SortOrder.Ascending)] };
 var result=repository.GetItems(query); observations.Add(new { kinds=query.IncludeItemTypes,kindNames=query.IncludeItemTypes.Select(kind=>kind.ToString()).ToArray(),
 flag=(bool?)true, deadGenre=query.IsDeadGenre, deadStudio=query.IsDeadStudio,locked=query.IsLocked,start=query.StartIndex,limit=query.Limit,result.TotalRecordCount,ids=result.Items.Select(item=>item.Id).ToArray() });
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location)).OrderBy(assembly=>assembly.GetName().Name)
 .Select(assembly=>new {name=assembly.GetName().Name,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray();
using var finalContext=factory.CreateDbContext();
var entity = finalContext.Model.FindEntityType(typeof(BaseItemEntity))!;
var table = StoreObjectIdentifier.Table(entity.GetTableName()!,entity.GetSchema());
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualRepository=true,actualSqlite=true, mediaOpened=false,portOpened=false,
 rows=finalContext.BaseItems.AsNoTracking().OrderBy(row=>row.Id).ToArray().Select(row=>entity.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(row))),
 values=values.Select(value=>new {value.ItemValueId,type=(int)value.Type,value.Value,value.CleanValue}), maps=maps.Select(map=>new {map.ItemId,map.ItemValueId}),observations,assemblies,
 sqliteRuntime=new {name="e_sqlite3.dll",sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory,"e_sqlite3.dll")))).ToLowerInvariant()} },new JsonSerializerOptions {WriteIndented=true})+"\n");
Console.WriteLine(JsonSerializer.Serialize(new {cases=observations.Count,actualRepository=true}));
Guid Id(int number)=>Guid.Parse("ba340000-0000-0000-0000-"+number.ToString("D12"));
public class Stub : DispatchProxy {
    public Func<MethodInfo, object?[]?, object?> Handler = null!;
    protected override object? Invoke(MethodInfo? method, object?[]? values) => Handler(method!, values);
    public static T Make<T>(Func<MethodInfo, object?[]?, object?> handler) where T : class {
        var proxy = Create<T, Stub>(); ((Stub)(object)proxy).Handler = handler; return proxy;
    }
    public static object? Default(Type type) => type == typeof(void) ? null : type == typeof(Task) ? Task.CompletedTask : type.IsValueType ? Activator.CreateInstance(type) : null;
    public static object? Forward(object target, MethodInfo method, object?[]? values) {
        try { return method.Invoke(target, values); }
        catch (TargetInvocationException error) { ExceptionDispatchInfo.Capture(error.InnerException!).Throw(); throw; }
    }
}
public class SqlFactory(string filename) : IDbContextFactory<JellyfinDbContext> {
    public JellyfinDbContext CreateDbContext() => new(new DbContextOptionsBuilder<JellyfinDbContext>().UseSqlite($"Data Source={filename};Pooling=False").Options,
        NullLogger<JellyfinDbContext>.Instance, new SqliteDatabaseProvider(null!, NullLogger<SqliteDatabaseProvider>.Instance), new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
}
