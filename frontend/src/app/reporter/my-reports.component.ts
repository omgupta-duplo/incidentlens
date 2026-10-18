import { Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { IncidentLensService } from '../incidentlens.service';
import { AuthImageComponent } from '../shared/auth-image.component';
import { reportTitle } from '../util';
import { ReporterNavComponent } from './reporter-nav.component';

/**
 * Reporter home (default) and "My reports" (?view=all) — one route, so the shared route table is unchanged.
 * Home is submission-focused: no report history panel; history and status live only under My reports.
 * Real data only: the reporter's own reports from /mine (title, reference, received time, public status label).
 */
@Component({
  selector: 'il-my-reports',
  imports: [DatePipe, AuthImageComponent, ReporterNavComponent],
  styleUrl: './reporter.scss',
  template: `
    <div class="il-page rp-page">
      <div class="rp">
        <main class="rp-main"><div class="rp-layout" [class.rp-list-layout]="all()" [class.rp-home-layout]="!all()">
          <section class="rp-column">
          @if (!all()) {
            <span class="rp-eyebrow">Your neighbourhood, seen clearly</span>
            <h1>A small report.<br />A better picture.</h1>
            <p class="rp-muted">Notice something that needs attention? Help your community see it.</p>
            <section class="rp-hero" aria-labelledby="hero-h">
              <div class="rp-orb" aria-hidden="true"></div>
              <span class="rp-eyebrow">Start with what you see</span>
              <h2 id="hero-h">One photo.<br />A useful first step.</h2>
              <p>Add a location and a little context. Track what happens next.</p>
              <button type="button" class="rp-primary" (click)="newReport()"><span aria-hidden="true">＋ </span>Report an incident</button>
            </section>
            <p class="rp-safe" role="note"><b aria-hidden="true">ⓘ</b><span><strong>Not an emergency service.</strong> Submitting a report does not
              summon help. In immediate danger, move to safety and call your local emergency number first.</span></p>
            <p class="rp-home-history"><button type="button" class="rp-text" (click)="showAll()">See your reports and their status <span aria-hidden="true">→</span></button></p>
          } @else {
            <span class="rp-eyebrow">Your contributions</span><h1>My reports</h1>
            <p class="rp-muted">A clear view of what you shared and what happened next.</p>
          }
          </section>
          @if (all()) {
          <section class="rp-side rp-history">
          <h2 id="mr-h" class="sr-only">Your reports</h2>

          @if (error()) { <p class="rp-err" role="alert">{{ error() }}</p> }
          @else if (loading()) { <p class="rp-muted" aria-live="polite">Loading your reports…</p> }
          @else if (!rows().length) {
            <div class="rp-empty"><div class="rp-icon" aria-hidden="true">＋</div><h2>No reports yet</h2>
              <p>You have not reported anything yet. Your first report starts with a photo and a location.</p>
              <button type="button" class="rp-primary" (click)="newReport()">Make a report</button></div>
          } @else {
            <ul class="rp-list" aria-labelledby="mr-h" style="list-style:none;margin:0;padding:0">
              @for (r of rows(); track r.id) {
                <li><button type="button" class="rp-report" [attr.aria-label]="title(r) + ', ref ' + r.name + ', ' + (r.current?.label || 'status unavailable')" (click)="open(r.id)">
                  <span class="rp-thumb"><il-auth-image [src]="photo(r.id)" alt="" /></span>
                  <span><strong>{{ title(r) }}</strong><small>{{ r.receivedAt | date:'d MMM, HH:mm' }} · <span class="il-mono">{{ r.name }}</span></small><br />
                    <span class="rp-pill">{{ r.current?.label || 'Status unavailable' }}</span></span>
                  <span class="rp-chevron" aria-hidden="true">›</span></button></li>
              }
            </ul>
          }
          </section>
          }
          </div>
        </main>
        <il-reporter-nav [active]="all() ? 'reports' : 'home'" />
      </div>
    </div>
  `,
})
export class MyReportsComponent implements OnInit {
  private readonly svc = inject(IncidentLensService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly rows = signal<any[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly all = signal(false);
  protected readonly title = (r: any) => reportTitle(r, r.categoryHint);
  protected readonly photo = (id: string) => this.svc.myPhotoUrl(id);

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(q => this.all.set(q.get('view') === 'all'));
  }

  ngOnInit(): void {
    this.svc.myReports().subscribe({
      next: r => { this.rows.set(r ?? []); this.loading.set(false); },
      error: () => { this.loading.set(false); this.error.set('Your reports could not be loaded. You may not have reporter access in this workspace.'); },
    });
  }
  protected showAll(): void { this.router.navigate([], { relativeTo: this.route, queryParams: { view: 'all' } }); }
  protected newReport(): void { this.router.navigate(['new'], { relativeTo: this.route }); }
  protected open(id: string): void { this.router.navigate(['view', id], { relativeTo: this.route }); }
}
