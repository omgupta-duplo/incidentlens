using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.IncidentLens;

[BsonIgnoreExtraElements]
public class GroupingWindow
{
    public string Category { get; set; } = "";
    public double MaxDistanceM { get; set; }
    public double MaxMinutes { get; set; }
}

[BsonIgnoreExtraElements]
public class GroupingCandidate
{
    public string ReportId { get; set; } = "";
    public string ReportName { get; set; } = "";
    public string? IncidentId { get; set; }
    public double DistanceM { get; set; }
    public double MinutesApart { get; set; }
    public string? Category { get; set; }
    public double Score { get; set; }
    /// <summary>low | medium | high — how uncertain the suggestion is (high = weak evidence).</summary>
    public string Uncertainty { get; set; } = "high";
    public List<string> Reasons { get; set; } = new();
    public bool ExactPhotoReuse { get; set; }
    public bool RecommendedForGrouping { get; set; }
    /// <summary>"same_event" (offer to group) or "link_suggestion" (the match already belongs to another incident).</summary>
    public string Kind { get; set; } = "same_event";
    public double Latitude { get; set; }
    public double Longitude { get; set; }
    public DateTime ReceivedAt { get; set; }
}

/// <summary>
/// Type-aware candidate windows + transparent scoring. Nothing here merges anything: it only proposes, each
/// candidate carrying its reasons and an uncertainty band, and an admin confirms membership. Distance alone
/// never qualifies a candidate — the category must also agree (or be unknown on one side).
/// </summary>
public static class GroupingPolicy
{
    public static List<GroupingWindow> Defaults() => new()
    {
        new() { Category = "road_collision", MaxDistanceM = 75, MaxMinutes = 30 },
        new() { Category = "pothole_road_damage", MaxDistanceM = 40, MaxMinutes = 14 * 24 * 60 },
        new() { Category = "waterlogging_flood", MaxDistanceM = 300, MaxMinutes = 48 * 60 },
        new() { Category = "fallen_tree_obstruction", MaxDistanceM = 100, MaxMinutes = 72 * 60 },
        new() { Category = "smoke_fire_indicator", MaxDistanceM = 500, MaxMinutes = 12 * 60 },
        new() { Category = "other_uncertain", MaxDistanceM = 150, MaxMinutes = 48 * 60 },
    };

    public static GroupingWindow WindowFor(IEnumerable<GroupingWindow> windows, string? category)
        => windows.FirstOrDefault(w => w.Category == category)
           ?? windows.FirstOrDefault(w => w.Category == "other_uncertain")
           ?? new GroupingWindow { Category = "other_uncertain", MaxDistanceM = 150, MaxMinutes = 2880 };

    public static void Validate(IEnumerable<GroupingWindow> windows)
    {
        foreach (var w in windows)
        {
            if (!Vocab.IsCategory(w.Category)) throw new ArgumentException($"Unknown category '{w.Category}'.");
            if (w.MaxDistanceM is < 5 or > 5000) throw new ArgumentException($"{w.Category}: distance must be 5–5000 m.");
            if (w.MaxMinutes is < 5 or > 60 * 24 * 60) throw new ArgumentException($"{w.Category}: window must be 5 min – 60 days.");
        }
    }

    public static string CategoryOf(IncidentLensReport r)
        => r.Result?.Assessment?.SuggestedCategory is { } c && Vocab.IsCategory(c) ? c
           : Vocab.IsCategory(r.Spec?.CategoryHint) ? r.Spec!.CategoryHint! : "other_uncertain";

    public static List<GroupingCandidate> Candidates(IncidentLensReport subject, IEnumerable<IncidentLensReport> pool,
        IReadOnlyList<GroupingWindow> windows)
    {
        var s = subject.Spec!;
        var sCat = CategoryOf(subject);
        var win = WindowFor(windows, sCat);
        var sLabels = LabelSet(subject);
        var sWords = Words(subject);
        var outList = new List<GroupingCandidate>();

        foreach (var o in pool)
        {
            if (o.Id == subject.Id || o.Spec == null || o.OwnerWorkspaceId != subject.OwnerWorkspaceId) continue;
            var oCat = CategoryOf(o);
            var reuse = !string.IsNullOrEmpty(s.PhotoSha256) && s.PhotoSha256 == o.Spec.PhotoSha256;
            var dist = Geo.DistanceM(s.Latitude, s.Longitude, o.Spec.Latitude, o.Spec.Longitude);
            // GPS accuracy widens tolerance (bounded): two ±40 m fixes may describe the same spot 100 m apart.
            var tolerance = win.MaxDistanceM + Math.Min(100, (s.GpsAccuracyM ?? 0) + (o.Spec.GpsAccuracyM ?? 0));
            var minutes = Math.Abs((s.ReceivedAt - o.Spec.ReceivedAt).TotalMinutes);
            var categoryAgrees = sCat == oCat || sCat == "other_uncertain" || oCat == "other_uncertain";

            if (!reuse && (dist > tolerance || minutes > win.MaxMinutes || !categoryAgrees)) continue;

            var c = new GroupingCandidate
            {
                ReportId = o.Id, ReportName = o.Name, IncidentId = o.Spec.IncidentId, DistanceM = Math.Round(dist),
                MinutesApart = Math.Round(minutes, 1), Category = oCat, ExactPhotoReuse = reuse,
                Latitude = o.Spec.Latitude, Longitude = o.Spec.Longitude, ReceivedAt = o.Spec.ReceivedAt,
            };
            double score = 0;
            if (reuse)
            {
                c.Reasons.Add("Same photo bytes as this report (exact reuse) — not independent corroboration; no judgement about intent.");
                score += 0.3;
            }
            if (dist <= tolerance)
            {
                var f = 1 - dist / Math.Max(tolerance, 1);
                score += 0.3 * f;
                c.Reasons.Add($"{Math.Round(dist)} m apart (window for {sCat}: {win.MaxDistanceM} m"
                    + (tolerance > win.MaxDistanceM ? $", widened to {Math.Round(tolerance)} m for GPS accuracy" : "") + ")");
            }
            if (minutes <= win.MaxMinutes)
            {
                score += 0.2 * (1 - minutes / Math.Max(win.MaxMinutes, 1));
                c.Reasons.Add($"{FormatMinutes(minutes)} apart (window: {FormatMinutes(win.MaxMinutes)})");
            }
            if (sCat == oCat) { score += 0.2; c.Reasons.Add($"Same category ({oCat})"); }
            else c.Reasons.Add($"Category not confirmed on both sides ({sCat} vs {oCat})");

            var oLabels = LabelSet(o);
            if (sLabels.Count > 0 && oLabels.Count > 0)
            {
                var j = Jaccard(sLabels, oLabels);
                score += 0.2 * j;
                if (j > 0) c.Reasons.Add($"Visual labels overlap {j:0.00} ({string.Join(", ", sLabels.Intersect(oLabels).Take(4))})");
            }
            var oWords = Words(o);
            if (sWords.Count > 0 && oWords.Count > 0)
            {
                var j = Jaccard(sWords, oWords);
                score += 0.1 * j;
                if (j >= 0.15) c.Reasons.Add($"Descriptions share terms ({string.Join(", ", sWords.Intersect(oWords).Take(4))})");
            }
            c.Score = Math.Round(Math.Min(score, 1), 2);
            // Conservative preselection: never infer one event from area, unknown category or reused bytes alone.
            c.RecommendedForGrouping = sCat != "other_uncertain" && sCat == oCat && !reuse
                && dist <= win.MaxDistanceM && minutes <= win.MaxMinutes && c.Score >= 0.7
                && subject.Result?.Assessment?.Uncertainty is "low" or "medium"
                && o.Result?.Assessment?.Uncertainty is "low" or "medium";
            c.Uncertainty = c.Score >= 0.7 ? "low" : c.Score >= 0.45 ? "medium" : "high";
            if (!string.IsNullOrEmpty(o.Spec.IncidentId) && o.Spec.IncidentId != s.IncidentId)
            {
                c.Kind = "link_suggestion";
                c.Reasons.Add("Already part of another incident — offered as a related-incident suggestion, not a merge.");
            }
            outList.Add(c);
        }
        return outList.OrderByDescending(c => c.Score).Take(20).ToList();
    }

    private static string FormatMinutes(double m)
        => m < 120 ? $"{Math.Round(m)} min" : m < 2880 ? $"{Math.Round(m / 60, 1)} h" : $"{Math.Round(m / 1440, 1)} d";

    private static HashSet<string> LabelSet(IncidentLensReport r)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var v = r.Result?.Vision;
        if (v == null) return set;
        foreach (var l in v.Labels ?? new()) if (l.Score >= 0.5 && !string.IsNullOrWhiteSpace(l.Description)) set.Add(l.Description.Trim().ToLowerInvariant());
        foreach (var o in v.Objects ?? new()) if (o.Score >= 0.5 && !string.IsNullOrWhiteSpace(o.Name)) set.Add(o.Name.Trim().ToLowerInvariant());
        return set;
    }

    private static readonly HashSet<string> Stop = new(StringComparer.OrdinalIgnoreCase)
    { "the", "a", "an", "and", "or", "of", "on", "in", "at", "to", "is", "are", "with", "near", "there", "this", "that", "visible", "image", "photo" };

    private static HashSet<string> Words(IncidentLensReport r)
    {
        var text = $"{r.Spec?.Note} {r.Result?.Assessment?.Observations}";
        return text.Split(new[] { ' ', ',', '.', ';', ':', '-', '\n', '\t', '(', ')', '/' }, StringSplitOptions.RemoveEmptyEntries)
                   .Select(w => w.ToLowerInvariant()).Where(w => w.Length > 2 && !Stop.Contains(w)).ToHashSet();
    }

    private static double Jaccard(HashSet<string> a, HashSet<string> b)
    {
        var inter = a.Intersect(b).Count();
        var uni = a.Union(b).Count();
        return uni == 0 ? 0 : Math.Round((double)inter / uni, 2);
    }
}

public static class Geo
{
    public static double DistanceM(double lat1, double lon1, double lat2, double lon2)
    {
        const double R = 6371000;
        double dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        double a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2)
                 + Math.Cos(lat1 * Math.PI / 180) * Math.Cos(lat2 * Math.PI / 180) * Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        return 2 * R * Math.Asin(Math.Min(1, Math.Sqrt(a)));
    }

    public static bool ValidLatLng(double lat, double lng) => lat is >= -90 and <= 90 && lng is >= -180 and <= 180;
}
