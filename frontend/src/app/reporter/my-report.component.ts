import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, interval } from 'rxjs';
import { IncidentLensService, PROCESSING_STATES, RESPONSE_STATES, categoryLabel } from '../incidentlens.service';
import { AuthImageComponent } from '../shared/auth-image.component';
import { ReporterNavComponent } from './reporter-nav.component';
import { locationText, reportTitle } from '../util';

/** Reporter's private timeline. Shows only their own report and public progress — never responders or other reporters. */
@Component({
  selector: 'il-my-report',
  imports: [DatePipe, AuthImageComponent, ReporterNavComponent],
  styleUrl: './reporter.scss',
  template: `
    <div class="il-page rp-page">
      <div class="rp">
        <main class="rp-main">
          <button type="button" class="rp-text" (click)="back()"><span aria-hidden="true">← </span>My reports</button>
          @if (r(); as r) {
            <div class="rp-layout"><section class="rp-column">
            <div class="rp-row rp-between" style="margin:10px 0">
              <span class="rp-eyebrow"><span data-ref>{{ r.name }}</span> · {{ r.receivedAt | date:'d MMM, HH:mm' }}</span>
              <span class="rp-pill">{{ r.current?.label || 'Status unavailable' }}</span></div>
            <h1>{{ title(r) }}</h1>
            <div class="rp-photo"><il-auth-image [src]="photoUrl()" alt="Your photo for this report" />
              <span class="rp-label">{{ r.captureSource === 'upload' ? 'Your uploaded photo' : 'Your photo' }}</span></div>

            @if (r.current; as c) {
              <section class="rp-card" aria-labelledby="now-h">
                <div class="rp-row rp-between"><h2 id="now-h" style="margin:0">Where your report stands</h2><span class="rp-pill warn">Not verified</span></div>
                <p style="margin:14px 0 8px;font-size:14px"><strong>{{ c.label }}.</strong> {{ c.detail }}</p>
                <p class="rp-small rp-muted"><strong>Next:</strong> {{ c.nextStep }}</p>
                <details><summary>What this means</summary>
                  <p class="rp-small rp-muted">People in the control room review every report. A photo shows what you saw but does not prove its cause,
                    severity or current safety, and any automated first look is only a starting point that can be wrong.
                    Grouping your report with others does not independently verify them.</p></details>
              </section>
            }

            </section><section class="rp-side">
            <h2 id="tl-h">What’s happening</h2>
            <ol class="rp-timeline" aria-labelledby="tl-h">
              @for (s of r.timeline; track s.key) {
                <li [class.pending]="s.state === 'todo' || s.state === 'pending'" [class.now]="s.state === 'now'" [class.skipped]="s.state === 'skipped'">
                  <span class="mk" aria-hidden="true">{{ s.state === 'done' ? '✓' : s.state === 'now' ? '●' : s.state === 'skipped' ? '–' : '·' }}</span>
                  <strong>{{ s.label }}</strong>
                  <span class="sr-only">{{ s.state === 'done' ? ' — done' : s.state === 'now' ? ' — current step' : s.state === 'skipped' ? ' — did not happen' : ' — not yet' }}</span>
                  @if (s.at) { <p>{{ s.at | date:'d MMM, HH:mm' }}</p> }
                </li>
              }
            </ol>
            @if (grouped(r)) {
              <div class="rp-hint" role="note"><strong>One shared incident, your own updates.</strong><br />
                Grouping reduces duplicate work. It doesn’t independently verify the reports.</div>
            }
            <p class="rp-small rp-muted">Updates appear when the control room or teams act; this page refreshes while it is open.
              @if (r.incident?.lastUpdatedAt) { Last update {{ r.incident.lastUpdatedAt | date:'short' }}. }</p>
            <details><summary>Your submitted details</summary>
              <dl class="rp-kv">
                <dt>Location</dt><dd>{{ loc(r) }}</dd>
                <dt>Category you chose</dt><dd>{{ cat(r.categoryHint) }}</dd>
                <dt>Photo</dt><dd>{{ r.captureSource === 'upload' ? 'Uploaded from your device' : 'Taken in the app' }}</dd>
                <dt>Your note</dt><dd>{{ r.note || 'No additional note.' }}</dd>
              </dl></details>
            <p class="rp-hint" role="note">{{ r.safetyNotice }}</p>
            </section></div>
          } @else if (error()) { <p class="rp-err" role="alert">{{ error() }}</p> }
          @else { <p class="rp-muted" aria-live="polite">Loading your report…</p> }
        </main>
        <il-reporter-nav active="reports" />
      </div>
    </div>
  `,
})
export class MyReportComponent implements OnInit {
  private readonly svc = inject(IncidentLensService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly r = signal<any>(null);
  protected readonly error = signal('');
  protected readonly ps = PROCESSING_STATES;
  protected readonly rs = RESPONSE_STATES;
  protected readonly cat = categoryLabel;
  // Read the id live: Angular reuses this component when only the :id changes (in-app navigation between records),
  // so a value captured once would keep showing the previous record.
  private get id(): string { return this.route.snapshot.params['id']; }
  private lastId = '';
  private poll?: Subscription;

  protected photoUrl = () => this.svc.myPhotoUrl(this.id);
  protected readonly title = (r: any) => reportTitle(r, r.categoryHint);
  /** Grouped into a shared incident (the reporter view exposes the incident link only, never other reporters). */
  protected grouped(r: any): boolean { return !!r?.incident || r?.current?.key === 'grouped'; }
  protected loc(r: any): string { return locationText(r.latitude, r.longitude, r.locationSource, r.gpsAccuracyM); }

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe(p => {
      const id = p.get('id') ?? '';
      if (this.lastId && id !== this.lastId) { this.resetForNewId(); this.load(); }
      this.lastId = id;
    });
  }

  ngOnInit(): void {
    this.load();
    this.poll = interval(15000).subscribe(() => this.load());
    this.destroyRef.onDestroy(() => this.poll?.unsubscribe());
  }
  private resetForNewId(): void {
    this.r.set(null); this.error.set('');
    if (!this.poll || this.poll.closed) this.poll = interval(15000).subscribe(() => this.load());
  }
  private load(): void {
    const id = this.id;
    this.svc.myReport(id).subscribe({
      next: r => { if (id !== this.id) return; this.error.set(''); this.r.set(r); if (r?.incident?.responseState === 'closed') this.poll?.unsubscribe(); },
      error: () => { if (id === this.id) this.error.set('This report was not found among your reports.'); },
    });
  }
  protected back(): void { this.router.navigate(['../..'], { relativeTo: this.route }); }
}
