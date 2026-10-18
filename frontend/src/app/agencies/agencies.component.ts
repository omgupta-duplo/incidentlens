import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { IncidentLensService } from '../incidentlens.service';

const TYPES = [
  { v: 'police', l: 'Police' }, { v: 'ambulance', l: 'Ambulance' }, { v: 'fire_rescue', l: 'Fire & Rescue' },
  { v: 'municipal_roads', l: 'Municipal — roads' }, { v: 'municipal_water', l: 'Municipal — water' }, { v: 'other', l: 'Other' },
];
interface RosterRow { email: string; displayName: string; leadEligible: boolean; active: boolean; }
interface Draft {
  id?: string; name: string; agencyType: string; displayName: string; capabilities: string; contactRoute: string;
  coverageCenterLat: number; coverageCenterLng: number; coverageRadiusKm: number; roster: RosterRow[]; spec?: any;
}

/**
 * Agency directory with user ROSTERS (control room). A roster lists individual platform users; dispatch later
 * selects specific people from it — never the whole agency. Contact routes are labels only (no real agency contact).
 */
@Component({
  selector: 'il-agencies',
  imports: [FormsModule],
  styleUrl: '../control/control.scss',
  template: `
    <div class="il-page">
      <header class="il-head"><div class="il-grow"><h1>Agencies &amp; rosters</h1>
        <p class="il-sub">Directory entries only — IncidentLens never contacts an agency. Rosters list the platform users who can be dispatched.</p></div>
        <button type="button" class="il-btn" (click)="startNew()">Add agency</button></header>
      @if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
      @if (msg()) { <p class="il-alert ok" role="status">{{ msg() }}</p> }

      @if (draft(); as d) {
        <form class="il-card" (ngSubmit)="save()" aria-labelledby="ag-form-h">
          <h2 id="ag-form-h">{{ d.id ? 'Edit ' + d.displayName : 'New agency' }}</h2>
          <div class="il-grid">
            @if (!d.id) { <label class="il-field"><span>Short id (lowercase, hyphens)</span>
              <input class="il-input" name="n" required pattern="^[a-z0-9]([a-z0-9\\-]*[a-z0-9])?$" [(ngModel)]="d.name" /></label> }
            <label class="il-field"><span>Display name</span><input class="il-input" name="dn" required [(ngModel)]="d.displayName" /></label>
            <label class="il-field"><span>Type</span><select class="il-input" name="t" [(ngModel)]="d.agencyType">@for (t of types; track t.v) { <option [value]="t.v">{{ t.l }}</option> }</select></label>
            <label class="il-field"><span>Capabilities (comma separated)</span><input class="il-input" name="c" [(ngModel)]="d.capabilities" placeholder="traffic_control, scene_safety" /></label>
            <label class="il-field"><span>Contact route label <span class="il-badge sim">MOCK</span></span><input class="il-input" name="cr" [(ngModel)]="d.contactRoute" /></label>
            <label class="il-field"><span>Coverage radius (km)</span><input class="il-input" type="number" min="1" max="500" name="r" [(ngModel)]="d.coverageRadiusKm" /></label>
            <label class="il-field"><span>Coverage centre latitude</span><input class="il-input" type="number" step="0.0001" name="la" [(ngModel)]="d.coverageCenterLat" /></label>
            <label class="il-field"><span>Coverage centre longitude</span><input class="il-input" type="number" step="0.0001" name="lo" [(ngModel)]="d.coverageCenterLng" /></label>
          </div>
          <fieldset><legend style="font-weight:650;font-size:1rem">Roster ({{ d.roster.length }})</legend>
            <table class="il-table">
              <thead><tr><th scope="col">Platform user email</th><th scope="col">Display name</th><th scope="col">Can lead</th><th scope="col">Active</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead>
              <tbody>
                @for (m of d.roster; track $index; let i = $index) {
                  <tr>
                    <td><input class="il-input" type="email" required [name]="'e' + i" [(ngModel)]="m.email" [attr.aria-label]="'Email of roster member ' + (i + 1)" /></td>
                    <td><input class="il-input" [name]="'d' + i" [(ngModel)]="m.displayName" [attr.aria-label]="'Display name of roster member ' + (i + 1)" /></td>
                    <td><input type="checkbox" [name]="'l' + i" [(ngModel)]="m.leadEligible" [attr.aria-label]="(m.displayName || m.email) + ' can lead'" /></td>
                    <td><input type="checkbox" [name]="'a' + i" [(ngModel)]="m.active" [attr.aria-label]="(m.displayName || m.email) + ' active'" /></td>
                    <td><button type="button" class="il-link" (click)="d.roster.splice(i, 1)">Remove</button></td>
                  </tr>
                }
              </tbody>
            </table>
            <button type="button" class="il-btn ghost sm" style="margin-top:8px" (click)="d.roster.push({ email: '', displayName: '', leadEligible: false, active: true })">Add roster member</button>
          </fieldset>
          <div class="il-row-actions" style="margin-top:12px">
            <button type="submit" class="il-btn" [disabled]="saving()">{{ saving() ? 'Saving…' : 'Save agency' }}</button>
            <button type="button" class="il-btn ghost" (click)="draft.set(null)">Cancel</button></div>
        </form>
      }

      <section class="il-card" aria-labelledby="ag-h"><h2 id="ag-h">Directory ({{ agencies().length }})</h2>
        @if (loading()) { <p class="il-muted" aria-live="polite">Loading…</p> }
        @else if (!agencies().length) { <p class="il-muted">No agencies yet.</p> }
        @for (a of agencies(); track a.id) {
          <article class="il-team">
            <h3>{{ a.spec.displayName }} <span class="il-chip">{{ typeLabel(a.spec.agencyType) }}</span> <span class="il-chip">directory only</span></h3>
            <p style="margin:0" class="il-muted">Capabilities: {{ a.spec.capabilities.join(', ') || '—' }} · contact {{ a.spec.contactRoute }} (mock) · {{ a.spec.coverageRadiusKm }} km coverage</p>
            <ul class="il-roster" style="margin-top:6px" [attr.aria-label]="a.spec.displayName + ' roster'">
              @for (m of a.spec.roster; track m.email) {
                <li>{{ m.displayName }} <span class="il-muted">({{ m.email }})</span>
                  @if (m.leadEligible) { <span class="il-chip">can lead</span> } @if (!m.active) { <span class="il-chip">inactive</span> }
                  @if (busy(a, m.email); as n) { <span class="il-warn-text">· on {{ n }} active assignment{{ n > 1 ? 's' : '' }}</span> }</li>
              }
            </ul>
            <button type="button" class="il-btn ghost sm" style="margin-top:6px" (click)="edit(a)">Edit</button>
          </article>
        }
      </section>
    </div>
  `,
})
export class AgenciesComponent implements OnInit {
  private readonly svc = inject(IncidentLensService);
  protected readonly types = TYPES;
  protected readonly agencies = signal<any[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal(''); protected readonly msg = signal('');
  protected readonly draft = signal<Draft | null>(null);
  protected readonly typeLabel = (t: string) => TYPES.find(x => x.v === t)?.l ?? t;

  ngOnInit(): void { this.load(); }
  private load(): void {
    this.svc.agencies().subscribe({
      next: list => {
        this.loading.set(false);
        // GET {id} adds live availability (busy counts) for the admin projection.
        const full: any[] = [];
        if (!list?.length) { this.agencies.set([]); return; }
        list.forEach(a => this.svc.agency(a.id).subscribe({ next: x => { full.push(x); if (full.length === list.length) this.agencies.set(full.sort((p, q) => p.spec.displayName.localeCompare(q.spec.displayName))); },
          error: () => { full.push(a); if (full.length === list.length) this.agencies.set(full); } }));
      },
      error: e => { this.loading.set(false); this.error.set(extractErrorMessage(e) || 'Agencies could not be loaded — control-room access is required.'); },
    });
  }
  protected busy(a: any, email: string): number { return a.result?.availability?.find((x: any) => x.email === email)?.activeAssignmentCount ?? 0; }
  protected startNew(): void {
    this.draft.set({ name: '', agencyType: 'police', displayName: '', capabilities: '', contactRoute: 'mock:', coverageCenterLat: 12.9716,
      coverageCenterLng: 77.5946, coverageRadiusKm: 25, roster: [{ email: '', displayName: '', leadEligible: true, active: true }] });
  }
  protected edit(a: any): void {
    const s = a.spec;
    this.draft.set({ id: a.id, name: a.name, agencyType: s.agencyType, displayName: s.displayName, capabilities: s.capabilities.join(', '),
      contactRoute: s.contactRoute, coverageCenterLat: s.coverageCenterLat, coverageCenterLng: s.coverageCenterLng, coverageRadiusKm: s.coverageRadiusKm,
      roster: s.roster.map((m: any) => ({ ...m })), spec: s });
  }
  protected save(): void {
    const d = this.draft(); if (!d) return;
    const spec = { ...(d.spec ?? {}), agencyType: d.agencyType, displayName: d.displayName.trim(),
      capabilities: d.capabilities.split(',').map(c => c.trim()).filter(Boolean), contactRoute: d.contactRoute.trim() || 'mock',
      coverageCenterLat: +d.coverageCenterLat, coverageCenterLng: +d.coverageCenterLng, coverageRadiusKm: +d.coverageRadiusKm,
      roster: d.roster.filter(m => m.email.trim()).map(m => ({ ...m, email: m.email.trim().toLowerCase() })) };
    this.saving.set(true); this.error.set(''); this.msg.set('');
    const call = d.id ? this.svc.updateAgency(d.id, spec) : this.svc.createAgency(d.name.trim(), spec);
    call.subscribe({
      next: () => { this.saving.set(false); this.draft.set(null); this.msg.set('Agency saved.'); this.load(); },
      error: e => { this.saving.set(false); this.error.set(extractErrorMessage(e) || 'The agency could not be saved.'); },
    });
  }
}
