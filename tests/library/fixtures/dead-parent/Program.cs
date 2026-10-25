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
var placeholder = new BaseItemEntity {Id=BaseItemRepository.PlaceholderId,Type="PLACEHOLDER",Name="FK placeholder",IsFolder=true};
var anchor = new BaseItemEntity {Id=Id(900),Type=typeof(Folder).FullName!,Name="Living parent",IsFolder=true};
var emptyAnchor = new BaseItemEntity {Id=Guid.Empty,Type="PLACEHOLDER",Name="Empty anchor",IsFolder=true};
void Row(int number,string kind,Guid? parent=null,Guid? owner=null,Guid? primary=null) {
 rows.Add(new BaseItemEntity {Id=Id(number),Type=kind=="Movie"?typeof(Movie).FullName!:kind=="Genre"?typeof(Genre).FullName!:typeof(Folder).FullName!,
  Name="Item "+number,SortName=number.ToString("D4"),Data="{}",ParentId=parent,OwnerId=owner,PrimaryVersionId=primary,
  IsFolder=kind=="Folder",Path=Path.Combine(metadata,kind,number.ToString())});
}
Row(10,"Movie"); Row(11,"Movie",anchor.Id); Row(12,"Movie",placeholder.Id); Row(13,"Genre",placeholder.Id);
Row(14,"Folder",placeholder.Id); Row(15,"Movie",emptyAnchor.Id); Row(16,"Movie",Id(16));
Row(17,"Movie",Id(14)); Row(18,"Movie",placeholder.Id,anchor.Id); Row(19,"Movie",placeholder.Id,primary:Id(11));
Row(20,"Movie",placeholder.Id); Row(21,"Movie",anchor.Id,owner:placeholder.Id);
Row(22,"Movie",placeholder.Id,primary:Guid.Empty); Row(23,"Movie",placeholder.Id,owner:Guid.Empty);
using(var context=factory.CreateDbContext()) {
 context.BaseItems.AddRange(anchor,emptyAnchor); context.SaveChanges();
 context.BaseItems.Where(item=>item.Id==emptyAnchor.Id).ExecuteUpdate(update=>update.SetProperty(item=>item.Id,Guid.Empty));
 context.BaseItems.AddRange(rows);context.SaveChanges();
}
var input=File.ReadAllBytes(args[2]);var samples=JsonSerializer.Deserialize<QuerySample[]>(input)!;
var observations=new List<object>();
foreach(var sample in samples) {
 var query=new InternalItemsQuery {HasDeadParentId=sample.Flag,StartIndex=sample.Start,Limit=sample.Limit,
  IncludeItemTypes=sample.Kinds.Select(value=>Enum.Parse<Jellyfin.Data.Enums.BaseItemKind>(value)).ToArray(),
  OrderBy=[(Jellyfin.Data.Enums.ItemSortBy.SortName,Jellyfin.Database.Implementations.Enums.SortOrder.Ascending)]};
 var result=repository.GetItems(query);observations.Add(new {sample,result.TotalRecordCount,ids=result.Items.Select(item=>item.Id).ToArray()});
}
var assemblies = AppDomain.CurrentDomain.GetAssemblies().Where(assembly => !assembly.IsDynamic && !string.IsNullOrEmpty(assembly.Location)).OrderBy(assembly=>assembly.GetName().Name)
 .Select(assembly=>new {name=assembly.GetName().Name,sha256=Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray();
using var finalContext=factory.CreateDbContext();
var entity = finalContext.Model.FindEntityType(typeof(BaseItemEntity))!;
var table = StoreObjectIdentifier.Table(entity.GetTableName()!,entity.GetSchema());
File.WriteAllText(args[1], JsonSerializer.Serialize(new { actualRepository=true,actualSqlite=true, mediaOpened=false,portOpened=false,
 rows=finalContext.BaseItems.AsNoTracking().OrderBy(row=>row.Id).ToArray().Select(row=>entity.GetProperties().ToDictionary(property=>property.GetColumnName(table)!,property=>property.PropertyInfo!.GetValue(row))),
 inputSha256=Convert.ToHexString(SHA256.HashData(input)).ToLowerInvariant(),observations,assemblies,
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

public sealed class QuerySample {public bool? Flag {get;set;} public string[] Kinds {get;set;}=[];public int Start {get;set;}public int? Limit {get;set;}}
