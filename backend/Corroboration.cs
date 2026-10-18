namespace Duplo.Extension.IncidentLens;

/// <summary>
/// Corroboration level for an incident — a transparent, deterministic score built only from facts IncidentLens holds.
/// It is NOT a verdict that the event is real or fake; it says how much independent, checkable evidence exists, with a
/// human-readable reason for every point. Semantics:
///  - an INDEPENDENT reporter is a distinct reporter who supplied at least one photo (by SHA-256) that no other reporter
///    submitted. Repeated rows, repeated photos and shared photos therefore cannot inflate the count; reports without a
///    reporter identity or a photo fingerprint are never counted as independent (and are named in a caution);
///  - the web check earns a point only when EVERY photo was checked and none was found elsewhere; partial coverage is
///    reported as a caution, never as "not found";
///  - with fewer than two independent reporters the level is always "low" (nothing corroborates a single source).
/// The result does not depend on report order.
/// </summary>
public record CorroborationResult(string Level, int Score, List<string> Reasons, List<string> Cautions, int IndependentReporters);
public record ServiceVote(string Service, int Votes, string? Reason, string Source);

public static class Corroboration
{
    public static CorroborationResult Compute(IReadOnlyList<IncidentLensReport> members)
    {
        var reasons = new List<string>(); var cautions = new List<string>(); var score = 0;
        // One row per report id (duplicate rows must not count twice); stable order for deterministic output.
        var rs = members.Where(r => r.Spec != null).GroupBy(r => r.Id).Select(g => g.First()).OrderBy(r => r.Id, StringComparer.Ordinal).ToList();
        if (rs.Count == 0) return new("low", 0, reasons, new() { "No reports linked yet." }, 0);
        static string Who(IncidentLensReport r) => (r.Spec!.ReporterEmail ?? "").Trim().ToLowerInvariant();
        static string Hash(IncidentLensReport r) => (r.Spec!.PhotoSha256 ?? "").Trim().ToLowerInvariant();

        var usable = rs.Where(r => Who(r).Length > 0 && Hash(r).Length > 0).ToList();
        var unusable = rs.Count - usable.Count;
        var ownersByPhoto = usable.GroupBy(Hash).ToDictionary(g => g.Key, g => g.Select(Who).Distinct().ToList());
        var independent = usable.Where(r => ownersByPhoto[Hash(r)].Count == 1).Select(Who).Distinct().Count();
        var distinctReporters = usable.Select(Who).Distinct().Count();

        if (independent >= 2) { score += Math.Min(3, independent - 1) * 2; reasons.Add($"{independent} independent reporters, each with a photo no one else sent"); }
        else cautions.Add(independent == 1 ? "Only one reporter supplied a photo no one else sent" : "No reporter supplied a photo of their own yet");
        var shared = ownersByPhoto.Count(kv => kv.Value.Count > 1);
        if (shared > 0) { score -= 1; cautions.Add($"The same photo was sent by more than one reporter ({shared} photo{(shared == 1 ? "" : "s")}) — counted once, not as independent evidence"); }
        else if (usable.GroupBy(Hash).Any(g => g.Count() > 1)) cautions.Add("A reporter sent the same photo more than once (counted once)");
        if (distinctReporters > independent)
            cautions.Add($"{distinctReporters - independent} reporter(s) sent only photos that someone else also sent");
        if (unusable > 0) cautions.Add($"{unusable} report{(unusable == 1 ? "" : "s")} without a reporter identity or photo fingerprint not counted as independent");

        var seenOnline = rs.Count(r => (r.Result?.Vision?.Web?.PagesWithMatches ?? 0) > 0 || (r.Result?.Vision?.Web?.FullMatches ?? 0) > 0);
        var webChecked = rs.Count(r => r.Result?.Vision?.Status == "ok" && r.Result.Vision.Web != null);
        if (seenOnline > 0) { score -= 3; cautions.Add($"{seenOnline} photo{(seenOnline == 1 ? " was" : "s were")} already on the web (may be old or from elsewhere)"); }
        else if (webChecked == rs.Count) { score += 1; reasons.Add(rs.Count == 1 ? "Web check: the photo was not found on other web pages" : $"Web check: none of the {rs.Count} photos was found on other web pages"); }
        else if (webChecked > 0) cautions.Add($"Web check covered only {webChecked} of {rs.Count} photos (none of those was found online; the rest were not checked)");
        else cautions.Add("Photos were not checked against the web");

        var inApp = rs.Count(r => r.Spec!.CaptureSource != "upload");
        if (inApp > 0) { score += 1; reasons.Add(inApp == rs.Count ? "All photos taken in the app" : $"{inApp} of {rs.Count} photos taken in the app"); }
        else cautions.Add("All photos were uploaded from devices");

        var gps = rs.Count(r => r.Spec!.GpsLatitude.HasValue);
        if (gps > 0) { score += 1; reasons.Add($"{gps} report{(gps == 1 ? "" : "s")} with a device location fix"); }
        else cautions.Add("No device location fixes (manual pins)");

        var spanMin = (rs.Max(r => r.Spec!.ReceivedAt) - rs.Min(r => r.Spec!.ReceivedAt)).TotalMinutes;
        if (independent >= 2 && spanMin >= 2) reasons.Add($"Reports arrived over {Math.Round(spanMin)} min (not a single burst)");

        if (rs.All(r => r.Result?.Assessment?.Uncertainty == "high")) { score -= 1; cautions.Add("AI was uncertain about every photo"); }

        // Corroboration needs at least two independent reporters: below that the level stays "low" whatever the other
        // signals say (capture source, GPS and the web check describe evidence quality, not confirmation).
        var level = independent < 2 ? "low" : score >= 5 ? "strong" : score >= 2 ? "medium" : "low";
        return new(level, score, reasons, cautions, independent);
    }

    /// <summary>Default services by category when no AI suggestion exists (advisory only).</summary>
    public static readonly Dictionary<string, string[]> CategoryServices = new()
    {
        ["road_collision"] = new[] { "police", "ambulance" },
        ["smoke_fire_indicator"] = new[] { "fire_rescue", "ambulance" },
        ["waterlogging_flood"] = new[] { "municipal_water", "fire_rescue" },
        ["fallen_tree_obstruction"] = new[] { "municipal_roads", "fire_rescue" },
        ["pothole_road_damage"] = new[] { "municipal_roads" },
        ["other_uncertain"] = new[] { "police" },
    };

    public static readonly string[] Services = { "police", "ambulance", "fire_rescue", "municipal_roads", "municipal_water" };

    /// <summary>Merge member reports' AI suggestions (with vote counts and reasons) and fall back to the category default.</summary>
    public static List<ServiceVote> SuggestServices(IReadOnlyList<IncidentLensReport> members, string? category)
    {
        var votes = members.SelectMany(r => r.Result?.Assessment?.SuggestedServices ?? new())
            .Where(s => Services.Contains(s.Service)).GroupBy(s => s.Service)
            .Select(g => new ServiceVote(g.Key, g.Count(), g.Select(x => x.Reason).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x)), "ai"))
            .OrderByDescending(x => x.Votes).ToList();
        if (votes.Count > 0) return votes;
        return (CategoryServices.TryGetValue(category ?? "other_uncertain", out var d) ? d : new[] { "police" })
            .Select(s => new ServiceVote(s, 0, "Default for this category", "category_default")).ToList();
    }

    public static (string? Priority, string? Reason) SuggestPriority(IReadOnlyList<IncidentLensReport> members)
    {
        var p = members.Select(r => r.Result?.Assessment).Where(a => a?.SuggestedPriority is "P1" or "P2" or "P3" or "P4")
            .OrderBy(a => a!.SuggestedPriority).FirstOrDefault();
        return (p?.SuggestedPriority, p?.PriorityReason);
    }
}
