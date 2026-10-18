import { Component, OnChanges, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { compactFacilityGroups } from '../util';
import { switchMap, of } from 'rxjs';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { IncidentLensService, categoryLabel, newRequestId } from '../incidentlens.service';
import { GeoMapComponent, MapMarker } from '../shared/geo-map.component';

export const SERVICE_LABEL: Record<string, string> = {
  police: 'Police', ambulance: 'Medical support', fire_rescue: 'Fire & rescue', municipal_roads: 'Municipal roads', municipal_water: 'Municipal water',
};

/**
 * AI triage + nearest real responders for one incident. Gemini suggests WHICH services (per report, merged), the backend
 * scores corroboration from evidence facts, Google Places finds the nearest facilities and Routes gives drive time.
 * Nothing is dispatched automatically: the control room confirms each dispatch.
 */
@Component({
  selector: 'il-ai-dispatch',
  imports: [DecimalPipe, FormsModule, GeoMapComponent],
  styleUrl: './control.scss',
  template: `
    <section class="il-card il-ai" aria-labelledby="ai-h">
      <h2 id="ai-h">AI triage &amp; nearby candidates <small class="il-muted">— advisory; you decide</small>
        @if (provider() === 'fixture') { <span class="il-badge fixture">FIXTURE facilities — Maps server key not configured</span> }</h2>
      @if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
      @if (t(); as t) {
        <div class="il-ai-top">
          <div>
            <p style="margin:0"><strong>Corroboration:</strong> <span class="il-corr" [attr.data-level]="t.corroboration.level">{{ t.corroboration.level }}</span></p>
            <ul class="il-list" style="margin-top:4px">
              @for (r of t.corroboration.reasons; track r) { <li>✓ {{ r }}</li> }
              @for (c of t.corroboration.cautions; track c) { <li class="il-warn-text">! {{ c }}</li> }
            </ul>
            <p class="il-muted" style="margin:4px 0 0">Built from evidence facts only — it is not a verdict that the event is real or fake.</p>
          </div>
          <div>
            <p style="margin:0"><strong>Suggested services</strong></p>
            <ul class="il-list" style="margin-top:4px">
              @for (s of t.services; track s.service) {
                <li><strong>{{ label(s.service) }}</strong> — {{ s.reason || '' }}
                  <small class="il-muted">({{ s.source === 'ai' ? 'AI, ' + s.votes + ' report' + (s.votes === 1 ? '' : 's') : 'category default' }})</small></li>
              }
            </ul>
            @if (t.suggestedPriority) { <p style="margin:4px 0 0"><strong>Suggested priority:</strong> {{ t.suggestedPriority }} — {{ t.priorityReason }}</p> }
          </div>
        </div>
      } @else if (!error()) { <p class="il-muted" aria-live="polite">Analysing evidence…</p> }

      @if (nearby(); as n) {
        <p class="il-muted">Screened for relevance from Google listing data. Service capability and availability must be confirmed directly; drive time is not a response ETA.</p>
        <div class="il-split" style="margin-top:12px">
          <div>
            @for (g of groups(); track g.service) {
              <h3 class="il-h3">{{ label(g.service) }}</h3>
              @if (!g.facilities.length) { <p class="il-muted">No sufficiently matched listing found. No substitute has been invented.</p> }
              <ul class="il-fac">
                @for (f of g.facilities; track f.placeId) {
                  <li>
                    <div class="il-grow"><strong>{{ f.name }}</strong>
                      <br /><small class="il-muted">{{ f.address }}</small>
                      @if (f.screening === 'agent_screened_listing') { <br /><small class="il-muted">AI relevance selection · capability unconfirmed</small> }
                      <br /><small>@if (f.driveMinutes != null) { {{ f.driveMinutes }} min drive · {{ f.driveKm }} km } @else { {{ f.straightLineKm | number:'1.1-1' }} km straight line }
                        @if (f.phone) { · <a [href]="'tel:' + f.phone">{{ f.phone }}</a> }
                        @if (f.mapsUri) { · <a [href]="f.mapsUri" target="_blank" rel="noopener noreferrer">Map</a> }</small>
                    </div>
                    @if (!closed()) {
                      @if (confirming() === g.service + ':' + f.placeId) {
                        <div class="il-card il-fac-review" aria-label="Confirm assignment">
                          @if (g.service === 'ambulance') { <p class="il-muted">A hospital listing does not establish ambulance service. Confirm that capability explicitly.</p> }
                          <label><input type="checkbox" [ngModel]="contactChecked()" (ngModelChange)="contactChecked.set($event)" />
                            I contacted this facility and confirmed the required {{ g.service === 'ambulance' ? 'ambulance' : label(g.service) }} service and current availability.</label>
                          <label>Contact confirmation (method/time, at least 10 characters)
                            <input [ngModel]="contactNote()" (ngModelChange)="contactNote.set($event)" maxlength="500" /></label>
                          <button type="button" class="il-btn sm" [disabled]="busy() || !contactChecked() || contactNote().trim().length < 10" (click)="dispatch(g.service, f)">Confirm assignment</button>
                          <button type="button" class="il-btn ghost sm" (click)="confirming.set('')">Cancel</button>
                          <small class="il-muted">Records your assignment; IncidentLens does not notify this facility.</small>
                        </div>
                      } @else { <button type="button" class="il-btn sm" (click)="startContact(g.service, f)">Dispatch…</button> }
                    }
                  </li>
                }
              </ul>
              @if (g.withheldCount) {
                <details><summary class="il-muted">{{ g.withheldCount }} other listings not shown</summary>
                  <ul class="il-muted">@for (x of g.withheld || []; track $index) { <li>{{ x.name }} — {{ (x.reasons || []).join(' ') }}</li> }</ul>
                </details>
              }
            }
          </div>
          <il-geo-map [markers]="markers()" [showLegend]="true" ariaLabel="Incident and shortlisted facilities" listLabel="Incident and shortlisted facilities" />
        </div>
      }
      @if (msg()) { <p class="il-alert ok" role="status">{{ msg() }}</p> }
    </section>
  `,
})
export class AiDispatchComponent implements OnChanges {
  readonly incidentId = input.required<string>();
  readonly category = input<string>('');
  readonly area = input<string>('');
  readonly closed = input(false);
  readonly dispatched = output<void>();
  private readonly svc = inject(IncidentLensService);
  protected readonly t = signal<any>(null);
  protected readonly nearby = signal<any>(null);
  protected readonly error = signal('');
  protected readonly msg = signal('');
  protected readonly busy = signal(false);
  protected readonly confirming = signal('');
  protected readonly provider = computed(() => this.nearby()?.provider ?? null);
  protected readonly label = (s: string) => SERVICE_LABEL[s] ?? s;
  protected readonly contactChecked = signal(false);
  protected readonly contactNote = signal('');
  protected readonly groups = computed(() => compactFacilityGroups(this.nearby()));
  protected readonly markers = computed<MapMarker[]>(() => {
    const n = this.nearby(); if (!n) return [];
    const points = new Map<string, MapMarker>();
    for (const g of this.groups()) for (const f of g.facilities) points.set(f.placeId,
      { id: f.placeId, lat: f.lat, lng: f.lng, label: f.name, detail: this.label(g.service), kind: 'facility' });
    return [{ id: 'incident', lat: n.incident.lat, lng: n.incident.lng, label: 'Incident', kind: 'incident' }, ...points.values()];
  });
  protected startContact(service: string, f: any): void {
    this.confirming.set(service + ':' + f.placeId); this.contactChecked.set(false); this.contactNote.set(''); this.error.set('');
  }
  private loadedFor = '';

  ngOnChanges(): void { if (this.incidentId() && this.incidentId() !== this.loadedFor) { this.loadedFor = this.incidentId(); this.load(); } }

  private load(): void {
    this.t.set(null); this.nearby.set(null); this.error.set(''); this.msg.set('');
    this.confirming.set(''); this.contactChecked.set(false);
    this.svc.triageSummary(this.incidentId()).pipe(
      switchMap(t => { this.t.set(t); return t ? this.svc.nearbyResponders(this.incidentId(), (t.services ?? []).map((s: any) => s.service)) : of(null); }),
    ).subscribe({ next: n => this.nearby.set(n), error: e => this.error.set(extractErrorMessage(e) || 'Triage could not be loaded.') });
  }

  /** Human-confirmed: create/reuse the facility as a directory-only responder, then dispatch it. */
  protected dispatch(service: string, f: any): void {
    this.busy.set(true); this.error.set(''); this.msg.set('');
    const task = `Respond to ${categoryLabel(this.category()).toLowerCase()}${this.area() ? ' at ' + this.area() : ''}`;
    const create$ = this.svc.facilityAgency({ incidentId: this.incidentId(), placeId: f.placeId, service, name: f.name, address: f.address, phone: f.phone, lat: f.lat, lng: f.lng });
    create$.pipe(switchMap((a: any) => this.svc.dispatch(this.incidentId(), {
      agencyId: a.id, memberEmails: [], leadEmail: null, task, facilityService: service,
      facilityContactConfirmed: this.contactChecked(), facilityAvailabilityConfirmed: this.contactChecked(),
      facilityCapabilityConfirmed: this.contactChecked(),
      facilityHumanConfirmed: true, facilityContactNote: this.contactNote(), reason: `Backend-screened ${this.label(service)} listing; service and availability confirmed by operator`,
      clientRequestId: newRequestId(),   // drive time + provenance are derived by the server from its own lookup
    }))).subscribe({
      next: () => { this.busy.set(false); this.confirming.set(''); this.msg.set(`Assignment recorded for ${f.name} using your contact confirmation. IncidentLens did not send a notification.`); this.dispatched.emit(); },
      error: e => { this.busy.set(false); this.error.set(extractErrorMessage(e) || 'Dispatch failed.'); },
    });
  }
}
