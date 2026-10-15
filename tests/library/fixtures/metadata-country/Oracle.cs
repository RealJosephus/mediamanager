using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using Emby.Server.Implementations.Library;
using Emby.Server.Implementations.Localization;
using Emby.Server.Implementations.Sorting;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.Logging.Abstractions;

var json=new JsonSerializerOptions{PropertyNameCaseInsensitive=true,WriteIndented=true};
var input=JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var configData=new ServerConfiguration();
var config=DispatchProxy.Create<IServerConfigurationManager,ConfigProxy>();((ConfigProxy)(object)config).Data=configData;
BaseItem.ConfigurationManager=config;BaseItem.Logger=NullLogger<BaseItem>.Instance;
var localization=new LocalizationManager(config,NullLogger<LocalizationManager>.Instance);await localization.LoadAll();
var comparer=new OfficialRatingComparer(localization);
var nativeLibrary=(LibraryManager)RuntimeHelpers.GetUninitializedObject(typeof(LibraryManager));
var library=DispatchProxy.Create<ILibraryManager,LibraryProxy>();var lookup=(LibraryProxy)(object)library;lookup.Real=nativeLibrary;BaseItem.LibraryManager=library;
var xml=DispatchProxy.Create<IXmlSerializer,XmlProxy>();var xmlLookup=(XmlProxy)(object)xml;CollectionFolder.XmlSerializer=xml;
var results=new List<object>();int index=0;
string? Text(JsonElement value,string name)=>value.GetProperty(name).GetString();
foreach(var spec in input.GetProperty("cases").EnumerateArray()){
 Guid Id(int suffix)=>Guid.Parse("85000000-0000-0000-0000-"+(index*100+suffix).ToString("D12"));
 string PathFor(int suffix)=>@"Z:\CountryOracle\"+index+@"\"+suffix;
 var root=new UserRootFolder{Id=Id(1),Path=PathFor(1)};
 var aggregate=new AggregateFolder{Id=Id(2),Path=PathFor(2)};
 var outer=new Folder{Id=Id(3),ParentId=aggregate.Id,Path=PathFor(3),PreferredMetadataCountryCode=Text(spec,"outerCountry")};
 var parent=new Folder{Id=Id(4),ParentId=outer.Id,Path=PathFor(4),PreferredMetadataCountryCode=Text(spec,"parentCountry")};
 var display=new Season{Id=Id(9),Path=PathFor(9),PreferredMetadataCountryCode=Text(spec,"displayCountry")};
 var displaySeries=new Series{Id=Id(10),Path=PathFor(10),PreferredMetadataCountryCode=Text(spec,"displayCountry")};
 var libA=new CollectionFolder{Id=Id(6),ParentId=root.Id,Path=PathFor(6),SortName=spec.GetProperty("reverse").GetBoolean()?"z":"a"};
 var libB=new CollectionFolder{Id=Id(7),ParentId=root.Id,Path=PathFor(7),SortName=spec.GetProperty("reverse").GetBoolean()?"a":"z"};
 var decoy=new CollectionFolder{Id=Id(8),ParentId=root.Id,Path=PathFor(8),SortName="zz",PreferredMetadataCountryCode="US",PhysicalLocationsList=[PathFor(98)]};
 libA.PreferredMetadataCountryCode=spec.GetProperty("libraryCountries")[0].GetString();libB.PreferredMetadataCountryCode=spec.GetProperty("libraryCountries")[1].GetString();
 var shape=Text(spec,"shape");libA.PhysicalLocationsList=shape=="different-path"?[PathFor(99)]:[outer.Path];
 libB.PhysicalLocationsList=shape=="two-path-libraries"?[outer.Path]:[];
 if(shape=="nested-path-library")libA.ParentId=aggregate.Id;
 var cache=Text(spec,"cache");libA.PhysicalFolderIds=cache=="correct"?[outer.Id]:cache=="stale"?[display.Id]:[];
 if(cache=="stale")decoy.PhysicalFolderIds=[outer.Id];
 BaseItem item=Text(spec,"type") switch{"Episode"=>new Episode{SeasonId=display.Id,SeriesId=displaySeries.Id},"Season"=>new Season{SeriesId=displaySeries.Id},"CollectionFolder"=>libA,_=>new Movie()};
 if(item!=libA){item.Id=Id(5);item.Path=PathFor(5);item.ParentId=Text(spec,"parent")=="actual"?parent.Id:Text(spec,"parent")=="dangling"?Id(97):Guid.Empty;}
 item.PreferredMetadataCountryCode=Text(spec,"itemCountry");item.OfficialRating=spec.TryGetProperty("officialRating",out var officialRating)?officialRating.GetString():"PG";
 if(spec.GetProperty("owner").GetBoolean())item.OwnerId=outer.Id;
 var anchor=new Movie{Id=Id(11),Path=PathFor(11),OfficialRating="13",PreferredMetadataCountryCode="US"};
 root.Children=new[]{libA,libB,decoy}.Where(folder=>folder.ParentId==root.Id).OrderBy(folder=>folder.SortName,StringComparer.Ordinal).ToArray();
 typeof(LibraryManager).GetField("_userRootFolder",BindingFlags.Instance|BindingFlags.NonPublic)!.SetValue(nativeLibrary,root);
 lookup.Items=new BaseItem[]{root,aggregate,outer,parent,display,displaySeries,libA,libB,decoy,anchor}.Append(item).DistinctBy(entity=>entity.Id).ToDictionary(entity=>entity.Id);
 configData.MetadataCountryCode=Text(spec,"globalCountry");
 CollectionFolder.OnCollectionFolderChange();xmlLookup.Options=new(){[System.IO.Path.Combine(libA.Path,"options.xml")]=new LibraryOptions{MetadataCountryCode=spec.GetProperty("optionCountries")[0].GetString()},[System.IO.Path.Combine(libB.Path,"options.xml")]=new LibraryOptions{MetadataCountryCode=spec.GetProperty("optionCountries")[1].GetString()},[System.IO.Path.Combine(decoy.Path,"options.xml")]=new LibraryOptions{MetadataCountryCode="US"}};
 lookup.Calls.Clear();xmlLookup.Reads.Clear();
 var country=item.GetPreferredMetadataCountryCode();var countryCalls=lookup.Calls.ToDictionary();var countryXmlReads=xmlLookup.Reads.ToArray();
 object? score=null;object? scoreException=null;int? compare=null;object? compareException=null;try{score=localization.GetRatingScore(item.OfficialRating,country);}catch(Exception ex){scoreException=new{type=ex.GetType().FullName,message=ex.Message};}try{compare=comparer.Compare(item,anchor);}catch(Exception ex){compareException=new{type=ex.GetType().FullName,message=ex.Message};}
 var members=nativeLibrary.GetCollectionFolders(item).Select(folder=>folder.Id).ToArray();var optionsCountry=nativeLibrary.GetLibraryOptions(item).MetadataCountryCode;
 object Snapshot(BaseItem entity)=>new{entity.Id,Type=entity.GetType().Name,entity.IsFolder,entity.ParentId,entity.DisplayParentId,entity.OwnerId,entity.Path,entity.SortName,entity.PreferredMetadataCountryCode,entity.OfficialRating,
   PhysicalFolderIds=entity is CollectionFolder cf?cf.PhysicalFolderIds:Array.Empty<Guid>(),PhysicalLocationsList=entity is CollectionFolder cf2?cf2.PhysicalLocationsList:Array.Empty<string>(),SeasonId=entity is Episode ep?ep.SeasonId:Guid.Empty,SeriesId=entity is Episode ep2?ep2.SeriesId:entity is Season season?season.SeriesId:Guid.Empty};
 results.Add(new{index,spec,itemId=item.Id,anchorId=anchor.Id,country,score,scoreException,compare,compareException,collectionFolders=members,selectedOptionsCountry=optionsCountry,
  actualParents=item.GetParents().Select(entity=>entity.Id).ToArray(),rootChildren=root.Children.Select(entity=>entity.Id).ToArray(),
  countryCalls,countryXmlReads,allCalls=lookup.Calls.ToDictionary(),allXmlReads=xmlLookup.Reads.ToArray(),
  configurationReadback=configData.MetadataCountryCode,items=lookup.Items.Values.Select(Snapshot).ToArray(),
  optionsReadback=xmlLookup.Options.Select(entry=>new{path=entry.Key,entry.Value.MetadataCountryCode}).ToArray()});index++;
}
var resolverCases=new List<object>();
foreach(var global in new string?[]{null,"","US"})foreach(var country in new string?[]{null,"","US","AU"})foreach(var rating in new[]{"13","-1","2147483648","NR"," n/a ","NR / R","13 / NR","US:PG-13","Rated 13","PG"}){
 configData.MetadataCountryCode=global;object? score=null;object? exception=null;
 try{score=localization.GetRatingScore(rating,country);}catch(Exception ex){exception=new{type=ex.GetType().FullName,message=ex.Message};}
 resolverCases.Add(new{rating,country,global,globalReadback=configData.MetadataCountryCode,score,exception});
}
foreach(var global in new string?[]{null,"","US","AU","GB"})foreach(var country in new[]{"XX","US","AU","GB"})foreach(var rating in new[]{"Atlantis:PG","ZZ-PG","XX:13","US:PG-13","Germany:FSK-18","English:PG","AU:MA15+","Rated PG"}){
 configData.MetadataCountryCode=global;object? score=null;object? exception=null;
 try{score=localization.GetRatingScore(rating,country);}catch(Exception ex){exception=new{type=ex.GetType().FullName,message=ex.Message};}
 resolverCases.Add(new{rating,country,global,globalReadback=configData.MetadataCountryCode,score,exception});
}
File.WriteAllText(args[1],JsonSerializer.Serialize(new{phaseAcceptance=false,results=results.Take(52).ToArray(),contextResults=results.Skip(52).ToArray(),resolverCases,processId=Environment.ProcessId,runtime=RuntimeInformation.FrameworkDescription,
 assemblies=new[]{typeof(LibraryManager).Assembly,typeof(BaseItem).Assembly,typeof(User).Assembly,typeof(Jellyfin.Extensions.EnumerableExtensions).Assembly,typeof(object).Assembly,typeof(Enumerable).Assembly}.Distinct().Select(assembly=>new{name=assembly.GetName().Name,path=assembly.Location,sha256=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant()}).ToArray(),
 boundary="Real BaseItem country getter/GetParents/GetCollectionFolders; real LibraryManager.GetLibraryOptions and CollectionFolder options selection/loading; XML/config/lookup reads supplied. Real LocalizationManager embedded resources and OfficialRatingComparer. Root cached Children inputs supplied in recorded order; no repository loading or native HTTP. All country/membership/rating/comparison results computed by frozen code."
},json));
public class LibraryProxy:DispatchProxy{
 public LibraryManager Real=null!;public Dictionary<Guid,BaseItem> Items=[];public Dictionary<string,int> Calls=[];
 protected override object? Invoke(MethodInfo? method,object?[]? args){var name=method!.Name;Calls[name]=Calls.GetValueOrDefault(name)+1;return name switch{
  "GetItemById"=>Items.GetValueOrDefault((Guid)args![0]!),"GetCollectionFolders"=>Real.GetCollectionFolders((BaseItem)args![0]!),
  "GetLibraryOptions"=>Real.GetLibraryOptions((BaseItem)args![0]!),_=>throw new NotSupportedException(name)};}
}
public class ConfigProxy:DispatchProxy{public ServerConfiguration Data=null!;protected override object? Invoke(MethodInfo? method,object?[]? args)=>method!.Name switch{"get_Configuration"=>Data,"add_ConfigurationUpdated"=>null,"remove_ConfigurationUpdated"=>null,_=>throw new NotSupportedException(method.Name)};}
public class XmlProxy:DispatchProxy{public Dictionary<string,LibraryOptions> Options=[];public List<string> Reads=[];protected override object? Invoke(MethodInfo? method,object?[]? args){if(method!.Name!="DeserializeFromFile")throw new NotSupportedException(method.Name);var path=(string)args![1]!;Reads.Add(path);return Options.GetValueOrDefault(path)??new LibraryOptions();}}
