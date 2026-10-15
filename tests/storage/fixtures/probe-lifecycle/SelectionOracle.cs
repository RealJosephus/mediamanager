using System.Reflection;
using System.Runtime.CompilerServices;
using System.Reflection.Emit;
using System.Text.Json;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Providers.Manager;
using MediaBrowser.Providers.Movies;
using Microsoft.Extensions.Logging.Abstractions;

public static class SelectionOracle
{
    public static HashSet<string> Changed = [];
    public static List<string> Checks = [];
    public static IMetadataProvider<Movie>[] Providers = [new LocalChange(), new RemoteChange(), new ProbeChange()];
    public static void Run(string destination)
    {
        var service = (MovieMetadataService)RuntimeHelpers.GetUninitializedObject(typeof(MovieMetadataService));
        var type = typeof(MetadataService<Movie, MovieInfo>);
        type.GetField("<ProviderManager>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(service, CreateProviderManager());
        type.GetField("<Logger>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!.SetValue(service, NullLogger<MetadataService<Movie, MovieInfo>>.Instance);
        var method = type.GetMethod("GetProviders", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var output = new List<object>();
        foreach (var mode in new[] { MetadataRefreshMode.ValidationOnly, MetadataRefreshMode.Default, MetadataRefreshMode.FullRefresh })
        foreach (var flag in new[] { "none", "first", "requires", "replace", "force" })
        foreach (var change in new[] { "none", "local", "remote", "probe", "local,probe", "failure" })
        {
            Changed = change.Split(',').ToHashSet(); Checks = [];
            var options = new MetadataRefreshOptions(DispatchProxy.Create<IDirectoryService, FixtureProxy>()) { MetadataRefreshMode = mode, ReplaceAllMetadata = flag == "replace", ForceSave = flag == "force" };
            var selected = ((IEnumerable<IMetadataProvider>)method.Invoke(service, [new Movie(), new LibraryOptions(), options, flag == "first", flag == "requires"])!).Select(provider => provider.Name).ToArray();
            output.Add(new { mode = mode.ToString(), flag, change, selected, checks = Checks.ToArray() });
        }
        File.WriteAllText(destination, JsonSerializer.Serialize(output, new JsonSerializerOptions { WriteIndented = true }));
    }
    static object CreateProviderManager()
    {
        // DispatchProxy loses constraints on IProviderManager's generic methods.
        // Preserve them in the isolated dependency stub; all unexpected calls fail.
        var builder = AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("IsolatedProviders"), AssemblyBuilderAccess.Run).DefineDynamicModule("Main").DefineType("FixtureProviderManager", TypeAttributes.Public);
        builder.AddInterfaceImplementation(typeof(IProviderManager));
        foreach (var source in typeof(IProviderManager).GetMethods())
        {
            var method = builder.DefineMethod(source.Name, MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.Final | MethodAttributes.NewSlot);
            var sourceArgs = source.IsGenericMethod ? source.GetGenericArguments() : [];
            var targetArgs = sourceArgs.Length == 0 ? [] : method.DefineGenericParameters(sourceArgs.Select(arg => arg.Name).ToArray());
            Type Map(Type value) => value.IsGenericParameter ? targetArgs[Array.IndexOf(sourceArgs, value)] : value.IsArray ? Map(value.GetElementType()!).MakeArrayType() : value.IsGenericType ? value.GetGenericTypeDefinition().MakeGenericType(value.GetGenericArguments().Select(Map).ToArray()) : value;
            for (int i = 0; i < sourceArgs.Length; i++)
            {
                targetArgs[i].SetGenericParameterAttributes(sourceArgs[i].GenericParameterAttributes);
                foreach (var constraint in sourceArgs[i].GetGenericParameterConstraints())
                    if (constraint.IsInterface) targetArgs[i].SetInterfaceConstraints(Map(constraint)); else targetArgs[i].SetBaseTypeConstraint(Map(constraint));
            }
            method.SetReturnType(Map(source.ReturnType)); method.SetParameters(source.GetParameters().Select(parameter => Map(parameter.ParameterType)).ToArray());
            var il = method.GetILGenerator();
            if (source.Name == "GetMetadataProviders") { il.Emit(OpCodes.Ldsfld, typeof(SelectionOracle).GetField(nameof(Providers))!); il.Emit(OpCodes.Castclass, Map(source.ReturnType)); il.Emit(OpCodes.Ret); }
            else { il.Emit(OpCodes.Newobj, typeof(NotSupportedException).GetConstructor(Type.EmptyTypes)!); il.Emit(OpCodes.Throw); }
            builder.DefineMethodOverride(method, source);
        }
        return Activator.CreateInstance(builder.CreateType()!)!;
    }
}
public abstract class ChangeProvider : IMetadataProvider<Movie>, IHasItemChangeMonitor
{
    public abstract string Name { get; }
    public bool HasChanged(BaseItem item, IDirectoryService directory)
    {
        SelectionOracle.Checks.Add(Name);
        if (SelectionOracle.Changed.Contains("failure")) throw new IOException("Isolated change-monitor failure");
        return SelectionOracle.Changed.Contains(Name);
    }
}
public class LocalChange : ChangeProvider, ILocalMetadataProvider { public override string Name => "local"; }
public class RemoteChange : ChangeProvider, IRemoteMetadataProvider { public override string Name => "remote"; }
public class ProbeChange : ChangeProvider, ICustomMetadataProvider, IPreRefreshProvider, IForcedProvider { public override string Name => "probe"; }
