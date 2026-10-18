import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, interval } from 'rxjs';
import { ASSIGNMENT_STATES, IncidentLensService, RESPONSE_STATES, categoryLabel } from '../incidentlens.service';
import { GeoMapComponent, MapMarker } from '../shared/geo-map.component';
import { StatusChipComponent } from '../shared/status-chip.component';
import { incidentTitle } from '../util';

/** Responder inbox: incidents where I am on an ACTIVE assignment, plus my own completed history. */
@Component({
  selector: 'il-my-assignments',
  imports: [DatePipe, GeoMapComponent, StatusChipComponent],
  styleUrl: './responder.scss',
  template: `
    <div class="il-page">
      <header class="il-head"><div class="il-grow"><h1>My assignments</h1>
        <p class="il-sub">Incidents your team is assigned to. Statuses are set by people — nothing here tracks locations.</p></div>
        <button type="button" class="il-btn ghost sm" (click)="load()">Refresh</button></header>
      @if (error()) { <p class="il-alert err" role="alert">{{ error() }}</p> }
      <div class="il-split">
        <section class="il-card" aria-labelledby="ac-h"><h2 id="ac-h">Active ({{ active().length }})</h2>
          @if (!active().length) { <p class="il-muted">No active assignments.</p> }
          <ul class="il-list">
            @for (a of active(); track a.myAssignmentId) {
              <li><button type="button" class="il-link" [attr.aria-label]="iTitle(a) + ', ref ' + a.name" (click)="open(a.incidentId)">{{ iTitle(a) }}</button> · {{ a.priority }}
                <small class="il-muted il-mono">{{ a.name }}</small>
                <br />{{ a.agencyName }}: {{ a.task }} — <il-status [value]="a.state" [label]="asl[a.state]" />
                @if (a.iAmLead) { <span class="il-chip">you lead</span> } · {{ a.teams }} team(s) · updated {{ a.lastUpdatedAt | date:'short' }}</li>
            }
          </ul>
        </section>
        <section class="il-card" aria-labelledby="mp-h"><h2 id="mp-h">Map</h2>
          <il-geo-map [markers]="markers()" [selectable]="true" (selected)="open($event)" ariaLabel="Map of your active incidents" listLabel="Your active incidents" /></section>
      </div>
      <section class="il-card" aria-labelledby="hi-h"><h2 id="hi-h">My history</h2>
        @if (!history().length) { <p class="il-muted">Nothing yet.</p> }
        <ul class="il-list">
          @for (h of history(); track h.id) {
            <li>{{ h.agencyName }} · {{ h.task }} — <il-status [value]="h.state" [label]="asl[h.state]" /> · {{ h.lastUpdatedAt | date:'short' }}
              @if (h.resolution) { <br /><small>Resolution: {{ h.resolution.note }} @if (h.resolution.hasPhoto) { (photo on file) }</small> }</li>
          }
        </ul>
      </section>
    </div>
  `,
})
export class MyAssignmentsComponent implements OnInit {
  protected readonly iTitle = incidentTitle;
  private readonly svc = inject(IncidentLensService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly asl = ASSIGNMENT_STATES; protected readonly rs = RESPONSE_STATES; protected readonly cat = categoryLabel;
  protected readonly active = signal<any[]>([]);
  protected readonly history = signal<any[]>([]);
  protected readonly error = signal('');
  protected readonly markers = computed<MapMarker[]>(() => this.active().filter(a => a.centroidLat != null)
    .map(a => ({ id: a.incidentId, lat: a.centroidLat, lng: a.centroidLng, label: a.name, detail: this.asl[a.state] })));
  private poll?: Subscription;

  ngOnInit(): void { this.load(); this.poll = interval(20000).subscribe(() => this.load()); this.destroyRef.onDestroy(() => this.poll?.unsubscribe()); }
  load(): void {
    this.svc.assigned().subscribe({ next: r => this.active.set(r ?? []), error: () => this.error.set('Your assignments could not be loaded — responder access is required.') });
    this.svc.myAssignments().subscribe({ next: r => this.history.set((r ?? []).filter((x: any) => x.state === 'completed')) });
  }
  protected open(id: string): void { this.router.navigate([id], { relativeTo: this.route }); }
}
