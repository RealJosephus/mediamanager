using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using Emby.Server.Implementations.Dto;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.IO;
using Microsoft.Extensions.Logging.Abstractions;

var json = new JsonSerializerOptions(JsonDefaults.Options) { PropertyNameCaseInsensitive = true };
var input = JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var root = input.GetProperty("programDataPath").GetString()!;
var metadata = Path.Combine(root, "metadata");
var configuration = new ServerConfiguration();
var paths = Stub.Make<MediaBrowser.Controller.IServerApplicationPaths>((m,a) => m.Name switch {
    "get_ProgramDataPath" => root, "get_InternalMetadataPath" => metadata, "get_PeoplePath" => Path.Combine(metadata,"People"),
    "get_GenrePath" => Path.Combine(metadata,"Genre"), "get_MusicGenrePath" => Path.Combine(metadata,"MusicGenre"),
    "get_StudioPath" => Path.Combine(metadata,"Studio"), "get_ArtistsPath" => Path.Combine(metadata,"artists"), _ => null
});
var config = Stub.Make<IServerConfigurationManager>((m,a) => m.Name switch { "get_Configuration" => configuration, "get_ApplicationPaths" => paths, _ => null });
BaseItem.ConfigurationManager = config;
BaseItem.FileSystem = new ManagedFileSystem(NullLogger<ManagedFileSystem>.Instance, Stub.Make<IApplicationPaths>((m,a) => m.Name == "get_TempDirectory" ? Path.GetTempPath() : null), []);
BaseItem.Logger = NullLogger<BaseItem>.Instance;
Video.RecordingsManager = Stub.Make<MediaBrowser.Controller.LiveTv.IRecordingsManager>((m,a) => null);
var items = new Dictionary<Guid,BaseItem>();
var nativeLibrary = (LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
void Field(object owner,string name,object value) => owner.GetType().GetField(name,BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(owner,value);
Field(nativeLibrary,"_configurationManager",config);
var cacheField = typeof(LibraryManager).GetField("_cache",BindingFlags.Instance|BindingFlags.NonPublic)!;
cacheField.SetValue(nativeLibrary,Activator.CreateInstance(cacheField.FieldType,[100]));
Field(nativeLibrary,"_itemRepository",Stub.Make<IItemRepository>((m,a) => m.Name == "RetrieveItem" ? items.GetValueOrDefault((Guid)a![0]!) : null));
var library = Stub.Make<ILibraryManager>((m,a) => m.Name switch {
    "GetItemById" => items.GetValueOrDefault((Guid)a![0]!),
    "GetPerson" => nativeLibrary.GetPerson((string)a![0]!),
    "GetPersonId" => nativeLibrary.GetPersonId((string)a![0]!),
    "GetGenreId" => nativeLibrary.GetGenreId((string)a![0]!),
    "GetMusicGenreId" => nativeLibrary.GetMusicGenreId((string)a![0]!),
    "GetStudioId" => nativeLibrary.GetStudioId((string)a![0]!),
    "GetCollectionFolders" => new List<Folder>(),
    "GetArtists" => new Dictionary<string,MusicArtist[]>(),
    _ => null
});
BaseItem.LibraryManager = library;
var processorType=typeof(IImageProcessor).Assembly.GetType("Jellyfin.Drawing.ImageProcessor") ?? Assembly.Load("Jellyfin.Drawing").GetType("Jellyfin.Drawing.ImageProcessor")!;
var processor=(IImageProcessor)RuntimeHelpers.GetUninitializedObject(processorType);
var dtoService=(DtoService)RuntimeHelpers.GetUninitializedObject(typeof(DtoService));
Field(dtoService,"_libraryManager",library); Field(dtoService,"_logger",NullLogger<DtoService>.Instance); Field(dtoService,"_imageProcessor",processor);
void Invoke(string name,params object?[] values) => typeof(DtoService).GetMethod(name,BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(dtoService,values);
BaseItem Item(JsonElement row) {
    var type=typeof(BaseItem).Assembly.GetTypes().First(type=>type.Name==row.GetProperty("Type").GetString() && typeof(BaseItem).IsAssignableFrom(type));
    var item=(BaseItem)Activator.CreateInstance(type)!;
    foreach(var field in row.EnumerateObject()) {
        if(field.Name is "Type" or "Canonical" or "Image")continue;
        var property=type.GetProperty(field.Name);
        if(property?.CanWrite==true)property.SetValue(item,JsonSerializer.Deserialize(field.Value.GetRawText(),property.PropertyType,json));
    }
    return item;
}
var result=new List<object>();
foreach(var entry in input.GetProperty("cases").EnumerateArray()) {
    items.Clear();
    var name=entry.GetProperty("name").GetString();
    var kind=entry.GetProperty("kind").GetString();
    if(kind=="people") {
        var entities=new List<object>();
        foreach(var row in entry.GetProperty("entities").EnumerateArray()) {
            var person=(Person)Item(row);
            if(!row.TryGetProperty("Canonical",out var canonical)||canonical.GetBoolean())person.Id=nativeLibrary.GetPersonId(person.Name);
            person.Path=Person.GetPath(person.Name);
            if(row.TryGetProperty("Image",out var image))person.ImageInfos=[JsonSerializer.Deserialize<ItemImageInfo>(image.GetRawText(),json)!];
            items[person.Id]=person;
            entities.Add(new { person.Id,person.Name,person.Path,person.Tags,Images=person.ImageInfos });
        }
        User? user=null;
        if(entry.TryGetProperty("user",out var userRow)) {
            user=new User("Reader","synthetic","synthetic");
            foreach(var preference in userRow.EnumerateObject())user.Preferences.Add(new Preference(Enum.Parse<PreferenceKind>(preference.Name),string.Join('|',preference.Value.EnumerateArray().Select(v=>v.GetString()))));
        }
        var people=JsonSerializer.Deserialize<List<PersonInfo>>(entry.GetProperty("people").GetRawText(),json)!;
        var dto=new BaseItemDto();
        var owner=new Movie { Name="Synthetic" };
        Invoke("AttachPeople",dto,owner,user,people);
        Invoke("AttachBasicFields",dto,owner,null,new DtoOptions(false) { EnableImages=false,EnableUserData=false,ImageTypeLimit=0 },null,null,null);
        result.Add(new {name,entities,lookups=people.Select(p=>new { p.Name,Id=nativeLibrary.GetPerson(p.Name)?.Id }).ToArray(),dto.People,dto.ImageBlurHashes});
    } else if(kind=="names") {
        var item=Item(entry.GetProperty("item"));var dto=new BaseItemDto();
        Invoke("AttachGenreItems",dto,item);Invoke("AttachStudios",dto,item);
        result.Add(new {name,MusicGenres=item is IHasMusicGenres,dto.GenreItems,dto.Studios});
    } else if(kind=="float") {
        foreach(var row in entry.GetProperty("items").EnumerateArray()) {var item=Item(row);items[item.Id]=item;}
        var queried=items[Guid.Parse(entry.GetProperty("query").GetString()!)];
        var dto=new BaseItemDto();var options=new DtoOptions(false) { EnableImages=false,EnableUserData=false,ImageTypeLimit=0 };
        Invoke("AttachBasicFields",dto,queried,null,options,null,null,null);
        result.Add(new {name,dto.CriticRating,dto.CommunityRating,dto.NormalizationGain,dto.AlbumNormalizationGain,dto.AlbumId,
            bits=new { CriticRating=Bits(dto.CriticRating),CommunityRating=Bits(dto.CommunityRating),NormalizationGain=Bits(dto.NormalizationGain),AlbumNormalizationGain=Bits(dto.AlbumNormalizationGain) }});
    }
}
File.WriteAllText(args[1],JsonSerializer.Serialize(new {results=result},json));
int? Bits(float? value)=>value.HasValue?BitConverter.SingleToInt32Bits(value.Value):null;
public class Stub : DispatchProxy {
    public Func<MethodInfo,object?[]?,object?> Handler=null!;
    public static T Make<T>(Func<MethodInfo,object?[]?,object?> handler) where T:class {var proxy=Create<T,Stub>();((Stub)(object)proxy).Handler=handler;return proxy;}
    protected override object? Invoke(MethodInfo? method,object?[]? args) {var value=Handler(method!,args);return value??(method!.ReturnType.IsValueType?Activator.CreateInstance(method.ReturnType):null);}
}
