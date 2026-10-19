using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Configuration;
if(args.Length!=3)throw new ArgumentException("Oracle <input.json> <new-output.json> <new-case-root>");
var input=File.ReadAllBytes(args[0]);
var scenarios=JsonSerializer.Deserialize<Scenario[]>(input,new JsonSerializerOptions{PropertyNameCaseInsensitive=true})!;
var results=new List<object>();
foreach(var scenario in scenarios)
{
 await using var host=await NativeScanHost.CreateAsync(Path.Combine(args[2],scenario.Name),scenario);
 Folder parent=scenario.UseAggregateParent ? host.Manager.RootFolder : new Folder {Id=host.Manager.GetNewItemId(host.MediaPath("parent"),typeof(Folder)),Name="Parent",Path=host.MediaPath("parent")};
 if(!scenario.UseAggregateParent)host.Manager.CreateItem(parent,null);
 File.WriteAllText(host.MediaPath("parent/Broken/VIDEO_TS/VTS_01_1.VOB"),"controlled unread media bytes");
 var files=new[]{"Before","Broken","After"}.Select(name=>host.FileSystem.GetDirectoryInfo(host.MediaPath("parent/"+name))).ToArray();
 host.BeginObservation();
 object[] items=[];string? exception=null;
 try{items=host.Manager.ResolvePaths(files,host.DirectoryService,parent,new LibraryOptions(),CollectionType.movies).Select(item=>(object)new {
  item.Id,type=item.GetType().FullName,item.Name,item.Path,item.IsFolder,videoType=(item as Video)?.VideoType.ToString()}).ToArray();}
 catch(Exception error){exception=error.ToString();}
 finally{host.EndObservation();}
 results.Add(new{scenario.Name,parentId=parent.Id,parentType=parent.GetType().FullName,parentPath=parent.Path,parentIsPhysicalRoot=parent.IsPhysicalRoot,parentIsRoot=parent.IsRoot,host.ResolverTypes,items,exception,trace=host.Trace});
}
var assemblies=AppDomain.CurrentDomain.GetAssemblies().Where(a=>!a.IsDynamic&&!string.IsNullOrEmpty(a.Location)).OrderBy(a=>a.FullName,StringComparer.Ordinal)
 .Select(a=>new{name=a.GetName().Name,path=a.Location,sha256=Hash(File.ReadAllBytes(a.Location))}).ToArray();
await using var output=new FileStream(args[1],FileMode.CreateNew,FileAccess.Write,FileShare.Read);
await JsonSerializer.SerializeAsync(output,new{scope="Actual native CoreAppHost resolver discovery and LibraryManager.ResolvePaths over ordinary Folder and actual manager AggregateFolder parents, real outer directory entries and real VIDEO_TS structure. A forwarding IFileSystem seam throws IOException exactly at either outer GetFileSystemEntries or nested GetFilePaths. Actual return items/errors/stacks are observed, without expected resolver or fallback results supplied to the native host. No item save, recursive scan, metadata or release acceptance.",inputSha256=Hash(input),results,assemblies},new JsonSerializerOptions{WriteIndented=true});
static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
