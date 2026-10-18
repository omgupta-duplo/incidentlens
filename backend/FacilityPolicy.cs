using System.Text.RegularExpressions;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.IncidentLens;

public record FacilityVerificationRequest(string? PlaceId, string? Service, string? EvidenceType, string? Reference,
    string? Notes, bool CapabilityConfirmed, bool HumanConfirmed);

[BsonIgnoreExtraElements]
public class FacilityVerification
{
    [BsonId] public string Id { get; set; } = "";
    public string WorkspaceId { get; set; } = "";
    public string PlaceId { get; set; } = "";
    public string Service { get; set; } = "";
    public string PolicyVersion { get; set; } = "";
    public string EvidenceType { get; set; } = "";
    public string Reference { get; set; } = "";
    public string Notes { get; set; } = "";
    public string ReviewedBy { get; set; } = "";
    public DateTime ReviewedAt { get; set; }
    public DateTime ExpiresAt { get; set; }
    public string Basis { get; set; } = "human_attestation";
}

public static class FacilityPolicy
{
    public const string Version = "facility-screen-v3";
    public static readonly TimeSpan CacheLifetime = TimeSpan.FromMinutes(30);
    public static bool FreshCache(string? workspace, string? incident, string? service, string? policy, DateTime at,
        string ws, string inc, string svc, DateTime now)
        => workspace == ws && incident == inc && service == svc && policy == Version && at <= now && at > now - CacheLifetime;

    public static NearbyFacility Classify(NearbyFacility f)
    {
        var reasons = new List<string>(); var kind = "candidate";
        if (f.BusinessStatus is "CLOSED_PERMANENTLY" or "CLOSED_TEMPORARILY")
            return f with { Suitability = "not_suitable", SuitabilityReasons = new[] { "Listing is marked closed; do not use for response." } };
        var expected = GooglePlaces.PlaceTypes.TryGetValue(f.Service, out var ts) ? ts : Array.Empty<string>();
        var types = f.Types ?? Array.Empty<string>();
        if (!types.Any(expected.Contains) && !expected.Contains(f.PrimaryType ?? ""))
        { kind = "needs_review"; reasons.Add("No matching service type recorded; capability is unknown."); }
        else if (!expected.Contains(f.PrimaryType ?? ""))
        { kind = "needs_review"; reasons.Add("Primary place type is missing or differs from the requested service."); }
        else reasons.Add("Place type matches the search category; this is not capability verification.");
        // Broad civic place types identify neither the responsible department nor its service area.
        // Retain these results for review; never promote a Google category into municipal-response relevance.
        if (f.Service is "municipal_roads" or "municipal_water")
        {
            kind = "needs_review";
            reasons.Add("Generic civic listing: responsible department, requested municipal service and jurisdiction are not established. Use an approved service directory or confirm with the authority.");
        }
        var signal = f.Service switch
        {
            "fire_rescue" => @"\b(college|academy|training|institute|contractor|solutions|equipment|extinguisher|supplier)\b",
            "police" => @"\b(quarters|housing|residential|traffic\s+office)\b",
            "ambulance" => @"\b(ayurvaid|ayurved\w*|wellness|clinic|complex|dental|pharmacy)\b",
            _ => @"\b(quarters|residential|contractor)\b",
        };
        if (Regex.IsMatch(f.Name ?? "", signal, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
        { kind = "needs_review"; reasons.Add("Name suggests a different or limited function; verify against an official source. Names alone are not decisive."); }
        if (string.IsNullOrWhiteSpace(f.Name) || f.Name == "Unnamed" || Regex.IsMatch(f.Name, @"^\W*(police|hospital|fire\s*station)\W*$", RegexOptions.IgnoreCase))
        { kind = "needs_review"; reasons.Add("Generic listing identity needs confirmation."); }
        if (f.Service == "ambulance")
        { reasons.Add("Medical facility only: emergency care, ambulance service and current availability are unconfirmed."); }
        if (f.BusinessStatus != "OPERATIONAL") { kind = "needs_review"; reasons.Add("Operating status was not confirmed in the listing."); }
        return f with { Suitability = kind, SuitabilityReasons = reasons.ToArray() };
    }
    public static int Rank(NearbyFacility f) => f.Suitability switch { "candidate" => 0, "needs_review" => 1, _ => 2 };
    public static List<NearbyFacility> Shortlist(IEnumerable<NearbyFacility> rows, int max)
        => rows.Where(f => !string.IsNullOrWhiteSpace(f.PlaceId)).Select(Classify)
            .GroupBy(f => f.PlaceId).Select(g => g.OrderByDescending(Rank)
                .ThenByDescending(f => f.Types?.Length ?? 0).First())
            .OrderBy(Rank).ThenBy(f => f.StraightLineKm).ThenBy(f => f.PlaceId).Take(max).ToList();
    // Relevance screening only, never a claim of operational capability or current availability.
    public static List<NearbyFacility> ScreenedShortlist(IEnumerable<NearbyFacility> rows, int max = 3)
        => Shortlist(rows, int.MaxValue).Where(f => f.Suitability == "candidate")
            .OrderBy(f => f.DriveMinutes ?? int.MaxValue).ThenBy(f => f.StraightLineKm).ThenBy(f => f.PlaceId).Take(Math.Clamp(max, 0, 3)).ToList();

    public static bool Current(FacilityVerification? v, string ws, string placeId, string service, DateTime now)
        => v != null && v.WorkspaceId == ws && v.PlaceId == placeId && v.Service == service && v.PolicyVersion == Version
           && v.Basis == "human_attestation" && v.EvidenceType is "official_source" or "approved_directory"
           && v.Reference.Length >= 8 && v.Notes.Length >= 20 && !string.IsNullOrWhiteSpace(v.ReviewedBy)
           && v.ReviewedAt <= now && v.ExpiresAt > now && v.ExpiresAt <= v.ReviewedAt.AddDays(30);
    public static FacilityVerification Review(NearbyFacility candidate, FacilityVerificationRequest req, string ws, string reviewer, DateTime now)
    {
        if (candidate.PlaceId != req.PlaceId || candidate.Service != req.Service || candidate.Provider != "google_places")
            throw new ArgumentException("Review requires a current Places candidate for this workspace and service.");
        if (Classify(candidate).Suitability == "not_suitable") throw new ArgumentException("This listing is marked closed; use another candidate.");
        if (!req.CapabilityConfirmed || !req.HumanConfirmed) throw new ArgumentException("Confirm that you checked this specific response capability against the evidence.");
        if (req.EvidenceType is not ("official_source" or "approved_directory")) throw new ArgumentException("Choose official source or approved directory evidence.");
        var reference = req.Reference?.Trim() ?? ""; var notes = req.Notes?.Trim() ?? "";
        if (reference.Length is < 8 or > 500 || notes.Length is < 20 or > 1000 || string.IsNullOrWhiteSpace(reviewer))
            throw new ArgumentException("Record an evidence reference and at least 20 characters describing the capability checked.");
        if (req.EvidenceType == "official_source" && (!Uri.TryCreate(reference, UriKind.Absolute, out var uri)
            || uri.Scheme != "https" || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)))
            throw new ArgumentException("Use an official HTTPS source URL without credentials, query parameters or fragments. It is recorded, not fetched automatically.");
        return new() { Id = Guid.NewGuid().ToString("N"), WorkspaceId = ws, PlaceId = candidate.PlaceId, Service = candidate.Service,
            PolicyVersion = Version, EvidenceType = req.EvidenceType, Reference = reference, Notes = notes,
            ReviewedBy = reviewer, ReviewedAt = now, ExpiresAt = now.AddDays(30) };
    }
    public static void RequireDispatch(NearbyFacility? candidate, string ws, string incidentId, string placeId, string service,
        DateTime now, DispatchRequest req)
    {
        if (candidate == null || candidate.PlaceId != placeId || candidate.Service != service || candidate.Provider != "google_places"
            || !FreshCache(candidate.WorkspaceId, candidate.IncidentId, candidate.Service, candidate.ScreeningPolicy,
                candidate.ScreenedAt ?? DateTime.MinValue, ws, incidentId, service, now)
            || Classify(candidate).Suitability != "candidate")
            throw new ArgumentException("Select a current backend-screened listing for this incident and service. Stale, unrelated or unscreened listings cannot be assigned.");
        if (!req.FacilityHumanConfirmed || !req.FacilityContactConfirmed || !req.FacilityAvailabilityConfirmed || !req.FacilityCapabilityConfirmed
            || string.IsNullOrWhiteSpace(req.FacilityContactNote) || req.FacilityContactNote.Trim().Length is < 10 or > 500)
            throw new ArgumentException("Confirm direct contact, the required service and current availability, then record a short contact note. Listing screening is not capability verification.");
        if (req.RequestedCapabilities?.Any(c => c != service) == true) throw new ArgumentException("Requested capabilities must match the confirmed facility service.");
    }
}
