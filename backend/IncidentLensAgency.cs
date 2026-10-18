using Duplo.Ai.DataManagement.Interfaces;
using Duplo.Ai.DataManagement.Services;
using Duplo.Ai.Model.Attributes;
using Duplo.Ai.Model.Interfaces;
using Duplo.Ai.Model.Resource;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using MongoDB.Bson.Serialization.Attributes;

namespace Duplo.Extension.IncidentLens;

// ── Agency: a directory entry with a roster of individual platform users (no real integration) ──────────────

[BsonIgnoreExtraElements]
public class RosterMember
{
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public bool LeadEligible { get; set; }
    public bool Active { get; set; } = true;
}

[BsonIgnoreExtraElements]
public class IncidentLensAgencySpec : BaseSpec
{
    public string AgencyType { get; set; } = "other";
    public string DisplayName { get; set; } = "";
    public List<string> Capabilities { get; set; } = new();
    public double CoverageCenterLat { get; set; }
    public double CoverageCenterLng { get; set; }
    public double CoverageRadiusKm { get; set; } = 10;
    /// <summary>A label only (e.g. "mock:radio-ch-3"). IncidentLens never contacts an agency.</summary>
    public string ContactRoute { get; set; } = "mock";
    public List<RosterMember> Roster { get; set; } = new();
    public string IntegrationStatus { get; set; } = "directory_only";
    /// <summary>"roster" (people in this workspace) or "facility" (a nearby facility; legacy rows say "google_places").</summary>
    public string Source { get; set; } = "roster";
    /// <summary>Facility provenance recorded by the server: google_places | fixture | unknown. Null on legacy rows.</summary>
    public string? Provenance { get; set; }
    public string? PlaceId { get; set; }
    public string? Address { get; set; }
    public string? Phone { get; set; }
}

[BsonIgnoreExtraElements]
public class MemberAvailability
{
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public int ActiveAssignmentCount { get; set; }
    public bool Busy { get; set; }
    /// <summary>Admin projection only — stripped from every responder-facing response.</summary>
    public List<string>? CurrentIncidentIds { get; set; }
}

[BsonIgnoreExtraElements]
public class IncidentLensAgencyResult : BaseResult
{
    public int ActiveAssignments { get; set; }
    public List<MemberAvailability>? Availability { get; set; }
}

[BsonCollection("extension_incidentlensagency")]
[BsonIgnoreExtraElements]
public class IncidentLensAgency : ResourceBase<IncidentLensAgencySpec, IncidentLensAgencyResult>
{
    public override string GetTicketOriginType() => "IncidentLensAgency";
    public override string GetTicketOriginSubType() => "incidentlens-agency";
}

public class IncidentLensAgencyHooks : DefaultEntityHooks<IncidentLensAgency> { }

public class IncidentLensAgencyService : ResourceServiceBase<IncidentLensAgency, IncidentLensAgencySpec, IncidentLensAgencyResult>
{
    /// <summary>A facility (no roster) — current rows use "facility", rows created by 0.3.x before D4 used "google_places".</summary>
    public static bool IsFacility(IncidentLensAgencySpec? s) => s?.Source is "facility" or "google_places" || !string.IsNullOrWhiteSpace(s?.PlaceId);

    /// <summary>
    /// Trusted facility provenance: the recorded value, else (legacy rows) "fixture" for fixture place ids, else "unknown".
    /// Never infers Google from a place id alone.
    /// </summary>
    public static string FacilityProviderOf(IncidentLensAgencySpec? s)
        => s?.Provenance is "google_places" or "fixture" ? s.Provenance
           : (s?.PlaceId ?? "").StartsWith("fixture-", StringComparison.Ordinal) ? "fixture" : "unknown";

    private readonly IRepository<IncidentLensAgency> _repo;
    private readonly IRepository<IncidentLensAssignment> _assignments;

    public IncidentLensAgencyService(
        IRepository<IncidentLensAgency> repository,
        ILogger<IncidentLensAgencyService> logger,
        IServiceScopeFactory scopeFactory,
        IHttpContextAccessor httpContextAccessor,
        IRepository<IncidentLensAssignment> assignments)
        : base(repository, logger, scopeFactory, httpContextAccessor)
    {
        _repo = repository; _assignments = assignments;
    }

    protected override bool IsProvisioningNeeded(IncidentLensAgency entity) => false;

    public override Task<IncidentLensAgency> DeprovisionAsync(string workspaceId, string resourceId, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("Agencies are directory entries with nothing to deprovision; delete them directly.");

    protected override Task ValidateSpecAsync(IncidentLensAgencySpec spec, bool isUpdate, IncidentLensAgencySpec existingSpec, CancellationToken cancellationToken = default)
    {
        if (!Vocab.AgencyTypes.Contains(spec.AgencyType)) throw new ArgumentException($"agencyType must be one of {string.Join(", ", Vocab.AgencyTypes)}.");
        if (string.IsNullOrWhiteSpace(spec.DisplayName)) throw new ArgumentException("displayName is required.");
        if (!Geo.ValidLatLng(spec.CoverageCenterLat, spec.CoverageCenterLng) || spec.CoverageRadiusKm is <= 0 or > 500)
            throw new ArgumentException("Coverage centre and a radius of 0–500 km are required.");
        var emails = new HashSet<string>();
        foreach (var m in spec.Roster)
        {
            m.Email = (m.Email ?? "").Trim().ToLowerInvariant();
            if (!m.Email.Contains('@')) throw new ArgumentException("Every roster member needs a platform user email.");
            if (!emails.Add(m.Email)) throw new ArgumentException($"{m.Email} appears twice in the roster.");
            if (string.IsNullOrWhiteSpace(m.DisplayName)) m.DisplayName = m.Email;
        }
        spec.IntegrationStatus = "directory_only";
        return base.ValidateSpecAsync(spec, isUpdate, existingSpec, cancellationToken);
    }

    protected override async Task EnrichResultAsync(IncidentLensAgency entity, CancellationToken cancellationToken = default)
        => await FillAvailabilityAsync(entity, includeIncidentIds: true, cancellationToken);

    /// <summary>Busy counts per roster member. Incident ids are filled only for the admin projection.</summary>
    public async Task FillAvailabilityAsync(IncidentLensAgency a, bool includeIncidentIds, CancellationToken ct)
    {
        var ws = a.OwnerWorkspaceId;
        var active = (await _assignments.FindAsync(x => x.OwnerWorkspaceId == ws, ct))
            .Where(x => Vocab.ActiveAssignmentStates.Contains(x.Result?.State ?? "")).ToList();
        a.Result ??= new IncidentLensAgencyResult();
        a.Result.ActiveAssignments = active.Count(x => x.Spec?.AgencyId == a.Id);
        a.Result.Availability = (a.Spec?.Roster ?? new()).Select(m =>
        {
            var mine = active.Where(x => x.Spec!.Members.Any(mm => mm.Email == m.Email)).ToList();
            return new MemberAvailability
            {
                Email = m.Email, DisplayName = m.DisplayName, ActiveAssignmentCount = mine.Count, Busy = mine.Count > 0,
                CurrentIncidentIds = includeIncidentIds ? mine.Select(x => x.Spec!.ParentId ?? "").Distinct().ToList() : null,
            };
        }).ToList();
    }

    public async Task<List<IncidentLensAgency>> ListAsync(string ws, CancellationToken ct)
        => (await _repo.FindAsync(a => a.OwnerWorkspaceId == ws, ct)).OrderBy(a => a.Spec!.DisplayName).ToList();
}
