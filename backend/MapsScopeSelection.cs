using Duplo.Ai.Model;

namespace Duplo.Extension.IncidentLens;

/// <summary>Select from workspace-attached metadata only; credential resolution happens afterwards.</summary>
public static class MapsScopeSelection
{
    public const string Name = "google-maps-server";

    public static string Select(IEnumerable<Scope> attached, string? explicitId)
    {
        var scopes = attached.ToList();
        if (!string.IsNullOrWhiteSpace(explicitId))
        {
            var selected = scopes.SingleOrDefault(s => s.Id == explicitId);
            if (selected == null)
                throw new ArgumentException("The selected Maps scope is not attached to this workspace.");
            if (selected.Name != Name)
                throw new ArgumentException("The selected scope must be named google-maps-server.");
            return selected.Id;
        }
        var matches = scopes.Where(s => s.Name == Name).Select(s => s.Id).Distinct().ToList();
        if (matches.Count == 0)
            throw new ArgumentException("Maps is unavailable: attach a google-maps-server scope to this workspace.");
        if (matches.Count > 1)
            throw new ArgumentException("Multiple google-maps-server scopes are attached. Select one using MapsScopeId.");
        return matches[0];
    }

    public static string RequireKey(IReadOnlyDictionary<string, string> data)
    {
        if (!data.TryGetValue("apiKey", out var key) || string.IsNullOrWhiteSpace(key))
            throw new ArgumentException("The Maps scope has no apiKey credential. Check its provider configuration.");
        return key;
    }
}
