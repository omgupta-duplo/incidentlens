using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Duplo.Extension.IncidentLens;

/// <summary>A retrieved place candidate; listing types and route estimates do not verify response capability.</summary>
public record NearbyFacility(string PlaceId, string Name, string? Address, string? Phone, double Lat, double Lng,
    string Service, double StraightLineKm, int? DriveMinutes, double? DriveKm, string? MapsUri, string Provider,
    string[]? Types = null, string? PrimaryType = null, string? BusinessStatus = null,
    string Suitability = "needs_review", string[]? SuitabilityReasons = null,
    string? WorkspaceId = null, string? IncidentId = null, DateTime? ScreenedAt = null, string? ScreeningPolicy = null,
    string ScreeningOrigin = "backend_screened_listing", string? AgentReason = null);

/// <summary>
/// Server-side Google Maps Platform client: Places API (New) searchNearby → Routes API computeRouteMatrix (drive time to the
/// incident). The API key comes from the "google-maps-server" scope and is only ever sent to Google — never to browsers,
/// tickets or logs. Missing credentials fail explicitly; fixtures are available only through the separate Fixture helper.
/// </summary>
public static class GooglePlaces
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };

    public static readonly Dictionary<string, string[]> PlaceTypes = new()
    {
        ["police"] = new[] { "police" },
        ["ambulance"] = new[] { "hospital" },
        ["fire_rescue"] = new[] { "fire_station" },
        ["municipal_roads"] = new[] { "city_hall", "local_government_office" },
        ["municipal_water"] = new[] { "city_hall", "local_government_office" },
    };

    public static async Task<List<NearbyFacility>> NearbyAsync(string? apiKey, string service, double lat, double lng, int max, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(apiKey)) throw new ArgumentException("Maps is unavailable: no server API key was resolved.");
        var types = PlaceTypes.TryGetValue(service, out var t) ? t : new[] { "police" };
        var collected = new List<NearbyFacility>();
        foreach (var radius in new[] { 5000.0, 15000.0, 40000.0 })
        {
            var body = new JsonObject
            {
                ["includedTypes"] = new JsonArray(types.Select(x => (JsonNode)x).ToArray()),
                ["maxResultCount"] = 12,
                ["rankPreference"] = "DISTANCE",
                ["locationRestriction"] = new JsonObject { ["circle"] = new JsonObject {
                    ["center"] = new JsonObject { ["latitude"] = lat, ["longitude"] = lng }, ["radius"] = radius } },
            };
            using var req = new HttpRequestMessage(HttpMethod.Post, "https://places.googleapis.com/v1/places:searchNearby") { Content = JsonContent.Create(body) };
            req.Headers.Add("X-Goog-Api-Key", apiKey);
            req.Headers.Add("X-Goog-FieldMask", "places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber,places.businessStatus,places.googleMapsUri,places.types,places.primaryType");
            using var res = await Http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (!res.IsSuccessStatusCode) throw new GoogleMapsException(await GoogleMapsError.ReadAsync(res, apiKey, ct));
            var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct));
            var places = json?["places"] as JsonArray ?? new JsonArray();
            collected.AddRange(places.Select(p => new NearbyFacility(
                (string?)p?["id"] ?? "", (string?)p?["displayName"]?["text"] ?? "Unnamed", (string?)p?["formattedAddress"],
                (string?)p?["nationalPhoneNumber"] ?? (string?)p?["internationalPhoneNumber"],
                (double?)p?["location"]?["latitude"] ?? 0, (double?)p?["location"]?["longitude"] ?? 0, service,
                0, null, null, (string?)p?["googleMapsUri"], "google_places",
                (p?["types"] as JsonArray)?.Select(t => (string?)t ?? "").ToArray(), (string?)p?["primaryType"], (string?)p?["businessStatus"]))
                .Where(f => Geo.ValidLatLng(f.Lat, f.Lng))
                .Select(f => f with { StraightLineKm = Math.Round(Geo.DistanceM(f.Lat, f.Lng, lat, lng) / 1000, 2) }));
            var suitable = FacilityPolicy.Shortlist(collected, 12);
            if (suitable.Count(f => f.Suitability == "candidate") >= max || suitable.Count >= 12) break;
        }
        // Keep uncertain listings reviewable; only route the shortlisted non-closed candidates.
        var list = FacilityPolicy.Shortlist(collected, 12);
        var routed = FacilityPolicy.ScreenedShortlist(list, max);
        var routeResults = await WithDriveTimesAsync(apiKey, routed, lat, lng, ct);
        return routeResults.Concat(list.Where(f => !routed.Any(r => r.PlaceId == f.PlaceId)))
            .OrderBy(FacilityPolicy.Rank).ThenBy(f => f.DriveMinutes ?? int.MaxValue).ThenBy(f => f.StraightLineKm).ToList();
    }

    /// <summary>Routes API route matrix: every facility → the incident, DRIVE, traffic-aware. Failure keeps straight-line only.</summary>
    private static async Task<List<NearbyFacility>> WithDriveTimesAsync(string apiKey, List<NearbyFacility> list, double lat, double lng, CancellationToken ct)
    {
        if (list.Count == 0) return list;
        var excluded = list.Where(f => f.Suitability == "not_suitable").ToList();
        list = list.Where(f => f.Suitability != "not_suitable").ToList();
        if (list.Count == 0) return excluded;
        JsonNode Wp(double a, double b) => new JsonObject { ["waypoint"] = new JsonObject { ["location"] = new JsonObject {
            ["latLng"] = new JsonObject { ["latitude"] = a, ["longitude"] = b } } } };
        var body = new JsonObject
        {
            ["origins"] = new JsonArray(list.Select(f => Wp(f.Lat, f.Lng)).ToArray()),
            ["destinations"] = new JsonArray(Wp(lat, lng)),
            ["travelMode"] = "DRIVE", ["routingPreference"] = "TRAFFIC_AWARE",
        };
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Post, "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix") { Content = JsonContent.Create(body) };
            req.Headers.Add("X-Goog-Api-Key", apiKey);
            req.Headers.Add("X-Goog-FieldMask", "originIndex,destinationIndex,duration,distanceMeters,condition");
            using var res = await Http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return list.Concat(excluded).ToList();
            var arr = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct)) as JsonArray ?? new JsonArray();
            foreach (var e in arr)
            {
                var i = (int?)e?["originIndex"] ?? -1;
                if (i < 0 || i >= list.Count || (string?)e!["condition"] != "ROUTE_EXISTS") continue;
                var secs = int.TryParse(((string?)e["duration"] ?? "").TrimEnd('s'), out var s) ? s : (int?)null;
                var meters = (double?)e["distanceMeters"];
                list[i] = list[i] with { DriveMinutes = secs.HasValue ? (int)Math.Ceiling(secs.Value / 60.0) : null,
                                         DriveKm = meters.HasValue ? Math.Round(meters.Value / 1000, 1) : null };
            }
        }
        catch (Exception) when (!ct.IsCancellationRequested) { /* keep straight-line distances */ }
        return list.Concat(excluded).OrderBy(FacilityPolicy.Rank).ThenBy(f => f.DriveMinutes ?? int.MaxValue).ThenBy(f => f.StraightLineKm).ToList();
    }

    /// <summary>LOCAL FIXTURE — clearly labelled; used only when no Maps server key is configured.</summary>
    private static List<NearbyFacility> Fixture(string service, double lat, double lng, int max)
    {
        var label = service switch { "police" => "Police Station", "ambulance" => "Hospital", "fire_rescue" => "Fire Station", _ => "Municipal Office" };
        return Enumerable.Range(1, Math.Clamp(max, 1, 5)).Select(i =>
        {
            double dLat = 0.006 * i * (i % 2 == 0 ? 1 : -1), dLng = 0.008 * i;
            var km = Math.Round(Geo.DistanceM(lat + dLat, lng + dLng, lat, lng) / 1000, 2);
            return new NearbyFacility($"fixture-{service}-{i}", $"FIXTURE {label} {i}", "Fixture address — not a real place", null,
                lat + dLat, lng + dLng, service, km, (int)Math.Ceiling(km / 0.4) + 2, Math.Round(km * 1.3, 1), null, "fixture");
        }).ToList();
    }
}
