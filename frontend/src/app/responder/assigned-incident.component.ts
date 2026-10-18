import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, interval } from 'rxjs';
import { extractErrorMessage } from '@duplocloud-internal/ng-common-lib';
import { ASSIGNMENT_STATES, IncidentLensService, NEXT_STATE, RESPONSE_STATES, categoryLabel, newRequestId } from '../incidentlens.service';
import { AuthImageComponent } from '../shared/auth-image.component';
import { CameraCaptureComponent } from '../shared/camera-capture.component';
import { GeoMapComponent, MapMarker } from '../shared/geo-map.component';
import { StatusChipComponent } from '../shared/status-chip.component';
import { incidentTitle, sourceLabel } from '../util';

/** A responder's view of ONE assigned incident: my team's actions, every participating team, help requests, evidence. */
@Component({
  selector: 'il-assigned-incident',
  imports: [DatePipe, FormsModule, AuthImageComponent, CameraCaptureComponent, GeoMapComponent, StatusChipComponent],
  styleUrl: './responder.scss',
  template: `
    <div class="il-page">
      <header class="il-head"><button type="button" class="il-link" (click)="back()">← My assignments</button></header>
      @if (v(); as v) {
        <header class="il-head"><div class="il-grow"><h1>{{ iTitle(v.incident) }} · {{ v.incident.priority }}</h1>
          <p class="il-sub">Ref <span class="il-mono" data-ref>{{ v.incident.name }}</span> · {{ cat(v.incident.category) }} @if (v.incident.summary) { · {{ v.incident.summary }} }</p></div>
          <il-status [value]="v.incident.responseState" [label]="rs[v.incident.responseState]" /></header>
        @if (msg()) { <p class="il-alert ok" role="status">{{ msg() }}</p> }
        @if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }

        @if (mine(); as m) {
          <section class="il-card" aria-labelledby="my-h">
            <h2 id="my-h">My team — {{ m.agencyName }} <il-status [value]="m.state" [label]="asl[m.state]" /></h2>
            <p class="il-next" role="note"><strong>Next step:</strong> {{ nextFor(m) }}</p>
            <p style="margin:0">Task: {{ m.task }}</p>
            <p class="il-muted" style="margin:0">Lead {{ m.lead }} · {{ m.members.join(', ') }} · last updated {{ m.lastUpdatedAt | date:'short' }} by {{ m.lastUpdatedBy }}
              @if (m.simulatedEtaMinutes != null) { · ETA {{ m.simulatedEtaMinutes }} min <span class="il-badge sim">SIMULATED</span> }</p>
            @if (m.iAmLead) {
              <div class="il-row-actions" style="margin-top:8px" role="group" aria-label="Update team status">
                @for (s of nextStates(m.state); track s) {
                  @if (s === 'completed') { <button type="button" class="il-btn" (click)="wantPhoto.set(false); resPhoto.set(null); panel.set('complete')">Mark completed…</button> }
                  @else { <button type="button" class="il-btn" [disabled]="busy()" (click)="setState(m, s)">Mark {{ asl[s].toLowerCase() }}</button> }
                }
              </div>
            } @else { <p class="il-muted" style="margin-top:6px">Your lead updates the team's status; you can add notes and request help.</p> }
            @if (panel() === 'complete') {
              <form class="il-panel" (ngSubmit)="complete(m)" aria-label="Complete assignment">
                <p style="margin-top:0">Record what was done. The control room reviews it; completing your team never closes the incident.</p>
                <label class="il-field"><span>Resolution note</span><textarea class="il-input" name="rn" rows="3" required [ngModel]="resNote()" (ngModelChange)="resNote.set($event)"></textarea></label>
                <p style="margin:0 0 6px"><strong>Resolution photo</strong> (optional, private to the control room and your team)</p>
                @if (wantPhoto()) {
                  <il-camera-capture captureLabel="Capture resolution photo" (captured)="resPhoto.set($event)" />
                  <button type="button" class="il-btn ghost sm" style="margin-top:6px" (click)="wantPhoto.set(false); resPhoto.set(null)">Remove photo</button>
                } @else {
                  <button type="button" class="il-btn ghost sm" (click)="wantPhoto.set(true)">Add photo</button>
                  <span class="il-muted"> The camera opens only if you choose to add one.</span>
                }
                <div class="il-row-actions" style="margin-top:8px"><button type="submit" class="il-btn" [disabled]="busy() || !resNote().trim()">Complete assignment</button>
                  <button type="button" class="il-btn ghost" (click)="panel.set('')">Cancel</button></div>
              </form>
            }
            <form (ngSubmit)="addNote(m)" style="margin-top:10px" aria-label="Add a progress note">
              <label class="il-field"><span>Progress note</span><input class="il-input" name="note" maxlength="1000" [ngModel]="note()" (ngModelChange)="note.set($event)" /></label>
              <button type="submit" class="il-btn ghost sm" [disabled]="busy() || !note().trim()">Add note</button>
            </form>
            @if (m.notes?.length) { <ul class="il-list" style="margin-top:6px">@for (n of m.notes; track $index) { <li>{{ n.at | date:'short' }} · {{ n.by }}: {{ n.text }}</li> }</ul> }
            @if (panel() !== 'help') { <button type="button" class="il-btn ghost" style="margin-top:8px" (click)="openHelp()">Request help…</button> }
            @if (panel() === 'help') {
              <form class="il-panel" (ngSubmit)="requestHelp(m)" aria-label="Request help">
                <p style="margin-top:0">No approval is needed. Choose specific people to dispatch them now (their lead must acknowledge), or name only an agency/capability and the control room allocates.</p>
                <label class="il-field"><span>Agency</span><select class="il-input" name="ha" [ngModel]="hAgency()" (ngModelChange)="hAgency.set($event); hPeople.set([]); hLead.set('')">
                  <option value="">Any agency (capability only)</option>@for (a of directory(); track a.id) { <option [value]="a.id">{{ a.displayName }} — {{ a.capabilities.join(', ') }}</option> }</select></label>
                <label class="il-field"><span>Capabilities needed (comma separated)</span><input class="il-input" name="hc" [ngModel]="hCaps()" (ngModelChange)="hCaps.set($event)" placeholder="e.g. extrication" /></label>
                @if (helpAgency(); as a) {
                  <fieldset class="il-field"><legend style="font-weight:600;font-size:1rem">Specific people (optional)</legend>
                    <ul class="il-roster">@for (p of a.roster; track p.email) {
                      <li><label><input type="checkbox" [checked]="hPeople().includes(p.email)" (change)="togglePerson(p.email)" [name]="'hp_' + p.email" /> {{ p.displayName }}
                        @if (p.leadEligible) { <span class="il-muted">(can lead)</span> } @if (p.busy) { <span class="il-warn-text">· busy ({{ p.activeAssignmentCount }})</span> }</label></li> }</ul></fieldset>
                  @if (hPeople().length) {
                    <label class="il-field"><span>Lead</span><select class="il-input" name="hl" [ngModel]="hLead()" (ngModelChange)="hLead.set($event)"><option value="">Choose…</option>
                      @for (p of helpLeads(); track p.email) { <option [value]="p.email">{{ p.displayName }}</option> }</select></label>
                  }
                }
                <label class="il-field"><span>Reason</span><input class="il-input" name="hr" required [ngModel]="hReason()" (ngModelChange)="hReason.set($event)" /></label>
                <div class="il-row-actions"><button type="submit" class="il-btn" [disabled]="busy() || !helpValid()">{{ hPeople().length ? 'Dispatch help now' : 'Send request' }}</button>
                  <button type="button" class="il-btn ghost" (click)="panel.set('')">Cancel</button></div>
              </form>
            }
          </section>
        }

        <div class="il-grid">
          <section class="il-card" aria-labelledby="tm-h"><h2 id="tm-h">All teams on this incident</h2>
            <ul class="il-list">
              @for (t of v.teams; track t.id) {
                <li><strong>{{ t.agencyName }}</strong> — <il-status [value]="t.state" [label]="asl[t.state]" /> @if (t.isMine) { <span class="il-chip">your team</span> }
                  <br />{{ t.task }} · lead {{ t.lead }} · updated {{ t.lastUpdatedAt | date:'short' }} by {{ t.lastUpdatedBy }}
                  @if (t.simulatedEtaMinutes != null) { · ETA {{ t.simulatedEtaMinutes }} min <span class="il-badge sim">SIMULATED</span> }
                  @if (t.resolutionSubmitted && !t.isMine) { <br /><small class="il-muted">Resolution submitted to the control room.</small> }</li>
              }
            </ul>
            <h3 style="font-size:.95rem;margin:12px 0 4px">Help requests</h3>
            @if (!v.assistanceRequests.length) { <p class="il-muted">None.</p> }
            <ul class="il-list">@for (q of v.assistanceRequests; track q.id) {
              <li><il-status [value]="q.state" [label]="q.display" /> {{ q.requestedAgencyName || q.requestedCapabilities.join(', ') }} · by {{ q.requestedBy }} · {{ q.createdAt | date:'short' }}<br /><small>{{ q.reason }}</small></li> }</ul>
          </section>
          <section class="il-card" aria-labelledby="ev-h"><h2 id="ev-h">Complaints</h2>
            <il-geo-map [markers]="markers()" ariaLabel="Reported locations" listLabel="Reported locations" />
            @for (r of v.reports; track r.id) {
              <article style="margin-top:12px">
                <il-auth-image [src]="photo(r.id)" [alt]="'Photo for report ' + r.name" />
                <p style="margin:6px 0 0"><strong>{{ r.name }}</strong> · {{ r.receivedAt | date:'short' }} · {{ src(r.locationSource) }}
                  @if (r.captureSource === 'upload') { · <span class="il-chip">uploaded</span> }
                  @if (r.seenOnlinePages) { · <span class="il-chip">seen online on {{ r.seenOnlinePages }} page{{ r.seenOnlinePages === 1 ? '' : 's' }}</span> }</p>
                @if (r.assessment) { <p style="margin:0"><small>AI (advisory): {{ r.assessment.observations }} — uncertainty {{ r.assessment.uncertainty }}</small></p> }
                @if (r.note) { <p style="margin:0"><small>Reporter note: {{ r.note }}</small></p> }
              </article>
            }
          </section>
        </div>
      } @else if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
      @else { <p class="il-muted" aria-live="polite">Loading…</p> }
    </div>
  `,
})
export class AssignedIncidentComponent implements OnInit {
  protected readonly wantPhoto = signal(false);
  protected readonly iTitle = incidentTitle;
  protected nextFor(m: any): string {
    if (!m.iAmLead) return 'Add progress notes for your lead, or request help if the scene needs more people.';
    switch (m.state) {
      case 'requested': return 'Acknowledge the assignment so the control room knows your team has it.';
      case 'acknowledged': return 'Mark en route when you leave, or on scene if you are already there.';
      case 'en_route': return 'Mark on scene when you arrive.';
      case 'on_scene': return 'When the work is done, mark completed with a short resolution note.';
      default: return 'No action needed.';
    }
  }
  private readonly svc = inject(IncidentLensService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly asl = ASSIGNMENT_STATES; protected readonly rs = RESPONSE_STATES; protected readonly cat = categoryLabel; protected readonly src = sourceLabel;
  protected readonly v = signal<any>(null);
  protected readonly directory = signal<any[]>([]);
  protected readonly panel = signal('');
  protected readonly busy = signal(false);
  protected readonly msg = signal(''); protected readonly error = signal('');
  protected readonly note = signal(''); protected readonly resNote = signal(''); protected readonly resPhoto = signal<Blob | null>(null);
  protected readonly hAgency = signal(''); protected readonly hCaps = signal(''); protected readonly hPeople = signal<string[]>([]);
  protected readonly hLead = signal(''); protected readonly hReason = signal('');
  // Read the id live: Angular reuses this component when only the :id changes (in-app navigation between records),
  // so a value captured once would keep showing the previous record.
  private get id(): string { return this.route.snapshot.params['id']; }
  private lastId = '';
  private helpRequestId = newRequestId();
  private poll?: Subscription;

  protected readonly mine = computed(() => this.v()?.teams?.find((t: any) => t.id === this.v()?.myAssignmentId));
  protected readonly markers = computed<MapMarker[]>(() => (this.v()?.reports ?? []).map((r: any) => ({ id: r.id, lat: r.latitude, lng: r.longitude, label: r.name, detail: sourceLabel(r.locationSource) })));
  protected readonly helpAgency = computed(() => this.directory().find(a => a.id === this.hAgency()));
  protected readonly helpLeads = computed(() => (this.helpAgency()?.roster ?? []).filter((p: any) => p.leadEligible && this.hPeople().includes(p.email)));
  protected readonly helpValid = computed(() => !!this.hReason().trim() && (!!this.hAgency() || !!this.hCaps().trim())
    && (!this.hPeople().length || (!!this.hLead() && this.hPeople().includes(this.hLead()))));

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(p => {
      const id = p.get('id') ?? '';
      if (this.lastId && id !== this.lastId) { this.resetForNewId(); this.load(); }
      this.lastId = id;
    });
  }

  ngOnInit(): void { this.load(); this.poll = interval(10000).subscribe(() => { if (!this.panel()) this.load(); }); this.destroyRef.onDestroy(() => this.poll?.unsubscribe()); }
  private resetForNewId(): void {
    this.v.set(null); this.panel.set(''); this.msg.set(''); this.error.set('');
    if (!this.poll || this.poll.closed) this.poll = interval(10000).subscribe(() => { if (!this.panel()) this.load(); });
  }
  private load(): void {
    this.svc.assignedOne(this.id).subscribe({ next: v => this.v.set(v),
      error: () => { this.v.set(null); this.error.set('You are no longer on an active assignment for this incident.'); this.poll?.unsubscribe(); } });
  }
  protected nextStates(s: string): string[] { return NEXT_STATE[s] ?? []; }
  protected photo(rid: string): string { return this.svc.assignedPhotoUrl(this.id, rid); }
  protected back(): void { this.router.navigate(['..'], { relativeTo: this.route }); }

  private run(obs: any, ok: string, after?: () => void): void {
    this.busy.set(true); this.error.set(''); this.msg.set('');
    obs.subscribe({ next: () => { this.busy.set(false); this.msg.set(ok); this.panel.set(''); after?.(); this.load(); },
      error: (e: any) => { this.busy.set(false); this.error.set(extractErrorMessage(e) || 'The action failed — the page was refreshed.'); this.load(); } });
  }
  protected setState(m: any, s: string): void { this.run(this.svc.setState(this.id, m.id, { state: s, expectedVersion: m.stateVersion }), `Status set to ${this.asl[s]}.`); }
  protected addNote(m: any): void { this.run(this.svc.addNote(this.id, m.id, { text: this.note().trim() }), 'Note added.', () => this.note.set('')); }
  protected complete(m: any): void {
    const f = new FormData();
    f.append('payload', JSON.stringify({ note: this.resNote().trim(), expectedVersion: m.stateVersion }));
    const p = this.resPhoto(); if (p) f.append('photo', p, 'resolution.jpg');
    this.run(this.svc.complete(this.id, m.id, f), 'Assignment completed — the control room will review.', () => { this.resNote.set(''); this.resPhoto.set(null); this.wantPhoto.set(false); });
  }
  protected openHelp(): void { this.panel.set('help'); if (!this.directory().length) this.svc.directory().subscribe(d => this.directory.set(d ?? [])); }
  protected togglePerson(e: string): void { this.hPeople.update(p => p.includes(e) ? p.filter(x => x !== e) : [...p, e]); if (!this.hPeople().includes(this.hLead())) this.hLead.set(''); }
  protected requestHelp(m: any): void {
    const caps = this.hCaps().split(',').map(c => c.trim()).filter(Boolean);
    this.run(this.svc.requestAssistance(this.id, { fromAssignmentId: m.id, agencyId: this.hAgency() || null, capabilities: caps,
      personnelCount: this.hPeople().length || 1, reason: this.hReason().trim(), memberEmails: this.hPeople().length ? this.hPeople() : null,
      leadEmail: this.hLead() || null, clientRequestId: this.helpRequestId }),
      this.hPeople().length ? 'Help dispatched — their lead must acknowledge. The control room was notified.' : 'Request sent — awaiting allocation by the control room.',
      () => { this.helpRequestId = newRequestId(); this.hPeople.set([]); this.hLead.set(''); this.hReason.set(''); this.hCaps.set(''); this.hAgency.set(''); });
  }
}
