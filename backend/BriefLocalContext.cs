using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

namespace Duplo.Extension.IncidentLens;

/// <summary>Fixed 0.25-degree tile: indices computed from floor((latitude+90)/0.25), floor((longitude+180)/0.25).
/// Dates are UTC calendar dates. No arbitrary polygon, address, category or identity predicates.</summary>
[BsonIgnoreExtraElements]
public sealed class BriefLocalSelection
{
    public int LatitudeTile { get; set; }
    public int LongitudeTile { get; set; }
    public DateTime FromUtc { get; set; }
    public DateTime UntilUtc { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class BriefLocalSnapshot
{
    public string Policy { get; set; } = "local-aggregate-v1";
    public string State { get; set; } = "withheld";
    public string Provenance { get; set; } = "Server snapshot of workspace incident records; reported events, not independently verified facts.";
    public DateTime CapturedAt { get; set; }
    public BriefLocalSelection Selection { get; set; } = new();
    public string IncidentCountBand { get; set; } = "suppressed";
    public string LinkedComplaintCountBand { get; set; } = "suppressed";
    public Dictionary<string, string> Categories { get; set; } = new();
    public Dictionary<string, string> Progress { get; set; } = new();
    public List<string> Limitations { get; set; } = new();
}

// Minimal in-memory inputs; never returned from the API or sent to a model.
public sealed record BriefLocalIncident(string Id, string Workspace, DateTime CreatedAt, string Category, string State, IReadOnlyList<string> Members);
public sealed record BriefLocalComplaint(string Id, string Workspace, string? IncidentId, DateTime ReceivedAt, double Lat, double Lng);

public static class BriefLocalContext
{
    public const int MaxRecords = 10000;
    private static readonly string[] States = { "under_review", "in_response", "awaiting_allocation", "needs_reassignment", "response_complete", "closed", "unknown" };
    public static void Validate(BriefLocalSelection s, DateTime now)
    {
        // Latitude limited to +/-60, so even the narrowest accepted tile is over 13 km wide.
        if (s.LatitudeTile < 120 || s.LatitudeTile >= 600 || s.LongitudeTile < 0 || s.LongitudeTile >= 1440)
            throw new ArgumentException("Choose a supported 0.25-degree area tile between 60°S and 60°N.");
        if (s.FromUtc.Kind != DateTimeKind.Utc || s.UntilUtc.Kind != DateTimeKind.Utc ||
            s.FromUtc.TimeOfDay != TimeSpan.Zero || s.UntilUtc.TimeOfDay != TimeSpan.Zero ||
            s.UntilUtc <= s.FromUtc || (s.UntilUtc - s.FromUtc).TotalDays > 7 ||
            s.UntilUtc > now.Date.AddDays(1) || s.FromUtc < now.Date.AddDays(-30))
            throw new ArgumentException("Use UTC midnight bounds covering 1–7 calendar days within the last 30 days, including today at most.");
    }
    private static string Band(int n) => n < 5 ? "suppressed" : $"{n / 5 * 5}–{n / 5 * 5 + 4}";
    private static bool Inside(BriefLocalComplaint r, BriefLocalSelection s) => double.IsFinite(r.Lat) && double.IsFinite(r.Lng)
        && r.Lat >= s.LatitudeTile * .25 - 90 && r.Lat < (s.LatitudeTile + 1) * .25 - 90
        && r.Lng >= s.LongitudeTile * .25 - 180 && r.Lng < (s.LongitudeTile + 1) * .25 - 180;

    public static BriefLocalSnapshot Build(string workspace, BriefLocalSelection selection, DateTime now,
        IReadOnlyList<BriefLocalIncident> incidents, IReadOnlyList<BriefLocalComplaint> complaints)
    {
        if (string.IsNullOrWhiteSpace(workspace)) throw new ArgumentException("Workspace is required.");
        Validate(selection, now);
        var result = new BriefLocalSnapshot { CapturedAt = now, Selection = new BriefLocalSelection {
            LatitudeTile = selection.LatitudeTile, LongitudeTile = selection.LongitudeTile,
            FromUtc = selection.FromUtc, UntilUtc = selection.UntilUtc }, Limitations = new() {
            "Counts are bands of five; cells below five are suppressed, including zero. Suppression does not imply no incidents or safety.",
            "Incident groups are counted once, not once per complaint. Only consistently linked complaints are represented; ungrouped complaints are excluded.",
            "Selection uses incident creation time and all linked complaint pins inside the tile. Older active incidents and boundary-spanning groups may be absent.",
            "Progress is recorded internal workflow status, not proof of external dispatch, arrival, resolution or authenticity.",
            "This is an as-of snapshot, not live tracking. Concurrent updates may delay inclusion; news may refer to the same event and must not be added to these counts."
        }};
        // Defense in depth even when the database query has already scoped its reads.
        var ii = incidents.Where(i => i.Workspace == workspace).ToList();
        var rr = complaints.Where(r => r.Workspace == workspace).ToList();
        if (ii.Count > MaxRecords || rr.Count > MaxRecords) { result.State = "unavailable"; return result; }
        if (ii.Select(i => i.Id).Distinct().Count() != ii.Count || rr.Select(r => r.Id).Distinct().Count() != rr.Count)
            return result;
        var lookup = rr.ToDictionary(r => r.Id);
        var owners = new Dictionary<string, string>();
        foreach (var i in ii)
            foreach (var rid in i.Members.Distinct())
            {
                if (!owners.TryAdd(rid, i.Id) || !lookup.TryGetValue(rid, out var r) || r.IncidentId != i.Id)
                    return result; // Never publish a partial misleading snapshot when ownership conflicts.
            }
        foreach (var r in rr.Where(r => !string.IsNullOrWhiteSpace(r.IncidentId)))
            if (!owners.TryGetValue(r.Id, out var owner) || owner != r.IncidentId) return result;
        var selected = ii.Where(i => i.CreatedAt >= selection.FromUtc && i.CreatedAt < selection.UntilUtc && i.CreatedAt <= now
            && i.Members.Count > 0 && i.Members.All(id => Inside(lookup[id], selection) && lookup[id].ReceivedAt <= now)).ToList();
        result.State = "available";
        result.IncidentCountBand = Band(selected.Count);
        result.LinkedComplaintCountBand = Band(selected.SelectMany(i => i.Members).Distinct().Count());
        result.Categories = Vocab.Categories.ToDictionary(c => c, c => Band(selected.Count(i => (Vocab.IsCategory(i.Category) ? i.Category : "other_uncertain") == c)));
        result.Progress = States.ToDictionary(s => s, s => Band(selected.Count(i => (States.Contains(i.State) ? i.State : "unknown") == s)));
        return result;
    }
}

internal static class BriefLocalContextStore
{
    // Called only after RequireAnyRoleAsync. No external calls, assignments, raw content or identity projection.
    public static async Task<BriefLocalSnapshot> CaptureAsync(IMongoDatabase db, string ws, BriefLocalSelection selection, DateTime now, CancellationToken ct)
    {
        BriefLocalContext.Validate(selection, now);
        var incidents = await db.GetCollection<IncidentLensIncident>("extension_incidentlensincident")
            .Find(i => i.OwnerWorkspaceId == ws).Limit(BriefLocalContext.MaxRecords + 1)
            .Project(i => new BriefLocalIncident(i.Id, i.OwnerWorkspaceId, i.CreatedAt, i.Spec!.Category,
                i.Result!.ResponseState, i.Spec.MemberReportIds)).ToListAsync(ct);
        var complaints = await db.GetCollection<IncidentLensReport>("extension_incidentlensreport")
            .Find(r => r.OwnerWorkspaceId == ws).Limit(BriefLocalContext.MaxRecords + 1)
            .Project(r => new BriefLocalComplaint(r.Id, r.OwnerWorkspaceId, r.Spec!.IncidentId, r.Spec.ReceivedAt, r.Spec.Latitude, r.Spec.Longitude))
            .ToListAsync(ct);
        return BriefLocalContext.Build(ws, selection, now, incidents, complaints);
    }
}
