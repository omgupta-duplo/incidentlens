using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
namespace Duplo.Extension.IncidentLens;

public static class GroupingRequestIdentity
{
    public static string Fingerprint(MembersRequest req) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {
        Add = (req.Add ?? new()).Distinct().OrderBy(x => x).ToArray(),
        Remove = (req.Remove ?? new()).Distinct().OrderBy(x => x).ToArray(),
        req.Reason, req.ExpectedVersion
    }))));
    public static string Fingerprint(CreateIncidentRequest req) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new {
        Reports = (req.ReportIds ?? new()).Distinct().OrderBy(x => x).ToArray(),
        req.TargetIncidentId, req.Category, req.Priority, req.Jurisdiction, req.Summary, req.Reason
    }))));
}
