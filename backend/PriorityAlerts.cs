namespace Duplo.Extension.IncidentLens;

// Deliberately excludes reporter identities, observations, locations, photos and model reasoning.
public record PriorityAlert(string Key, string ResourceId, string Reference, string Priority, string Kind, string Basis);
public static class PriorityAlertPolicy
{
    public static bool Urgent(string? priority) => priority is "P1" or "P2";
    public static bool Open(IncidentLensIncident i) => i.Spec != null && i.Result != null && !i.Result.Closed
        && i.Result.ResponseState is not ("closed" or "response_complete");
    public static PriorityAlert Incident(IncidentLensIncident i, string assignment = "")
    {
        // Unrelated note/status edits never re-ring. Reopen or priority change is a new alert revision.
        var revision = i.Result!.Audit.Where(a => a.Action == "incident.reopen"
            || (a.Action == "incident.triage" && (a.Detail ?? "").Contains("priority ")))
            .Select(a => a.At.Ticks).DefaultIfEmpty(0).Max();
        return new($"incident:{i.Id}:{assignment}:{i.Spec!.Priority}:{revision}", i.Id!, i.Name ?? "Incident",
            i.Spec.Priority, "incident", "Recorded incident priority; not a verification of safety");
    }
    public static List<PriorityAlert> Control(string ws, IEnumerable<IncidentLensIncident> incidents, IEnumerable<IncidentLensReport> reports)
    {
        var rows = incidents.Where(i => i.OwnerWorkspaceId == ws && Open(i) && Urgent(i.Spec?.Priority)).Select(i => Incident(i)).ToList();
        rows.AddRange(reports.Where(r => r.OwnerWorkspaceId == ws && r.Spec != null && string.IsNullOrEmpty(r.Spec.IncidentId)
            && Urgent(r.Result?.Assessment?.SuggestedPriority)).Select(r => new PriorityAlert(
                $"report:{r.Id}:{r.Result!.Assessment!.SuggestedPriority}:{r.Result.Assessment.AssessedAt?.Ticks ?? 0}",
                r.Id!, r.Name ?? "Complaint", r.Result.Assessment.SuggestedPriority!, "report",
                "AI suggestion — unverified complaint; human review needed")));
        return rows.OrderBy(a => a.Priority).ThenBy(a => a.Key, StringComparer.Ordinal).ToList();
    }
    public static List<PriorityAlert> Responder(string ws, string email, IEnumerable<IncidentLensIncident> incidents, IEnumerable<IncidentLensAssignment> assignments)
    {
        if (string.IsNullOrWhiteSpace(email)) return new();
        var permitted = assignments.Where(a => a.OwnerWorkspaceId == ws && a.Spec != null && !string.IsNullOrEmpty(a.Spec.ParentId) && Vocab.ActiveAssignmentStates.Contains(a.Result?.State ?? "")
            && a.Spec.Members.Any(m => m.Email == email)).GroupBy(a => a.Spec!.ParentId).ToDictionary(g => g.Key!, g => string.Join(",", g.Select(a => a.Id).OrderBy(x => x, StringComparer.Ordinal)));
        return incidents.Where(i => i.OwnerWorkspaceId == ws && Open(i) && Urgent(i.Spec?.Priority) && permitted.ContainsKey(i.Id!))
            .Select(i => Incident(i, permitted[i.Id!])).OrderBy(a => a.Priority).ThenBy(a => a.Key, StringComparer.Ordinal).ToList();
    }
}

public partial class IncidentLensIncidentService
{
    public async Task<List<PriorityAlert>> ControlAlertsAsync(string ws, CancellationToken ct)
    {
        _ = Me();
        return PriorityAlertPolicy.Control(ws, await _repo.FindAsync(i => i.OwnerWorkspaceId == ws, ct),
            await _reports.FindAsync(r => r.OwnerWorkspaceId == ws, ct));
    }
    public async Task<List<PriorityAlert>> ResponderAlertsAsync(string ws, CancellationToken ct)
    {
        var email = Me();
        var assignments = await _assignmentRepo.FindAsync(a => a.OwnerWorkspaceId == ws, ct);
        var ids = assignments.Where(a => IsActiveMember(a, email)).Select(a => a.Spec!.ParentId).Where(id => !string.IsNullOrEmpty(id)).Distinct();
        var incidents = new List<IncidentLensIncident>();
        foreach (var id in ids) { var i = await _repo.GetByIdAsync(id!, ct); if (i?.OwnerWorkspaceId == ws) incidents.Add(i); }
        return PriorityAlertPolicy.Responder(ws, email, incidents, assignments);
    }
}
