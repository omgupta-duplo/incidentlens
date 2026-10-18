namespace Duplo.Extension.IncidentLens;

/// <summary>
/// The persistence a reassignment swap touches. Every forward write may fail BEFORE it commits or AFTER it commits (lost
/// response), so compensation never trusts the forward call's outcome: it reads back the stored state and repairs it.
/// All reconcile/withdraw/restore calls must be idempotent and must ignore the request's cancellation token.
/// </summary>
public interface IReassignmentStore<T> where T : class
{
    /// <summary>Insert the replacement under the identity preallocated for THIS operation (unique client request id + name).</summary>
    Task<T> CreateReplacementAsync();
    Task CancelOriginalAsync();
    Task PersistIncidentAsync(T replacement);
    /// <summary>Read back the replacement by its preallocated identity; null when it never committed.</summary>
    Task<T?> FindReplacementAsync();
    /// <summary>Delete exactly that replacement (it was created by this operation; nothing pre-existing matches its identity).</summary>
    Task WithdrawReplacementAsync(T replacement);
    /// <summary>Read back the original assignment; rewrite the pre-swap snapshot only if the stored state differs.</summary>
    Task RestoreOriginalAsync();
    /// <summary>Read back the incident; rewrite the pre-swap persisted snapshot only if the stored state differs.</summary>
    Task RestoreIncidentAsync();
}

/// <summary>
/// Compensated swap used by reassignment (D3). The caller validates EVERYTHING before calling; this helper orders the
/// writes create replacement → cancel original → persist incident (audit + summary). On any failure every stage that
/// MAY have committed is reconciled against storage: the incident is restored to its pre-swap snapshot, the original
/// assignment to its pre-swap snapshot, and the replacement (found by its preallocated identity) withdrawn. Every
/// compensation step runs even if an earlier one fails; failures surface as <see cref="SwapCompensationException"/>
/// carrying the original error (never swallowed). Pre-existing data is never deleted.
/// </summary>
public static class ReassignmentSwap
{
    public static async Task<T> RunAsync<T>(IReassignmentStore<T> store) where T : class
    {
        T replacement;
        try { replacement = await store.CreateReplacementAsync(); }
        catch (Exception e) { await CompensateAsync(e, Withdraw(store)); throw; }
        try { await store.CancelOriginalAsync(); }
        catch (Exception e) { await CompensateAsync(e, ("restore original", store.RestoreOriginalAsync), Withdraw(store)); throw; }
        try { await store.PersistIncidentAsync(replacement); }
        catch (Exception e)
        {
            await CompensateAsync(e, ("restore incident", store.RestoreIncidentAsync), ("restore original", store.RestoreOriginalAsync), Withdraw(store));
            throw;
        }
        return replacement;
    }

    private static (string, Func<Task>) Withdraw<T>(IReassignmentStore<T> store) where T : class
        => ("withdraw replacement", async () => { var r = await store.FindReplacementAsync(); if (r != null) await store.WithdrawReplacementAsync(r); });

    private static async Task CompensateAsync(Exception cause, params (string Step, Func<Task> Run)[] steps)
    {
        var failed = new List<string>();
        foreach (var (step, run) in steps)
        {
            try { await run(); }
            catch (Exception ce) { failed.Add($"{step}: {ce.GetType().Name}"); }
        }
        if (failed.Count > 0) throw new SwapCompensationException(cause, failed);
    }
}

public sealed class SwapCompensationException : Exception
{
    public IReadOnlyList<string> FailedSteps { get; }
    public SwapCompensationException(Exception cause, List<string> failed)
        : base($"Reassignment failed and could not be fully rolled back ({string.Join("; ", failed)}). Manual repair may be needed.", cause)
        => FailedSteps = failed;
}
