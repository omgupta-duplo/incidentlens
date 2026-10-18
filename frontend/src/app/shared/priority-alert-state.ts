export interface PriorityAlert { key: string; resourceId: string; reference: string; priority: 'P1'|'P2'; kind: 'report'|'incident'; basis: string; }
/** Browser-memory ledger only, partitioned by authenticated user/workspace/role. No report body is stored. */
export class AlertLedger {
  private seen = new Set<string>();
  private acknowledged = new Set<string>();
  private snoozed = new Map<string, number>();
  reconcile(rows: PriorityAlert[], now = Date.now()) {
    const unique = [...new Map(rows.filter(a => a && typeof a.key === 'string' && typeof a.resourceId === 'string' && ['P1','P2'].includes(a.priority) && ['report','incident'].includes(a.kind)).map(a=>[a.key,a])).values()];
    const active = unique.filter(a => !this.acknowledged.has(a.key) && (this.snoozed.get(a.key) ?? 0) <= now);
    const fresh = active.some(a => !this.seen.has(a.key));
    active.forEach(a => this.seen.add(a.key));
    // Bound memory to the current feed; removed/reopened events may alert again.
    const keys = new Set(unique.map(a => a.key));
    for(const key of this.seen) if(!keys.has(key)) this.seen.delete(key);
    for(const key of this.acknowledged) if(!keys.has(key)) this.acknowledged.delete(key);
    for(const key of this.snoozed.keys()) if(!keys.has(key)) this.snoozed.delete(key);
    return {active, fresh};
  }
  ack(key:string) { this.acknowledged.add(key); }
  snooze(key:string, now=Date.now()) { this.snoozed.set(key,now+300000); this.seen.delete(key); }
}
const ledgers = new Map<string,AlertLedger>();
export function alertLedger(scope:string) {
  if(!ledgers.has(scope)) { if(ledgers.size>=8) ledgers.delete(ledgers.keys().next().value!); ledgers.set(scope,new AlertLedger()); }
  return ledgers.get(scope)!;
}
