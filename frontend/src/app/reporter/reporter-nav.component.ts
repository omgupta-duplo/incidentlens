import { Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';

/** Reporter bottom navigation (Home · My reports), as in the approved reporter design. Real links within the reporter mount. */
@Component({
  selector: 'il-reporter-nav',
  styleUrl: './reporter.scss',
  template: `
    <nav class="rp-nav" aria-label="Reporter navigation">
      <a [href]="home()" [attr.aria-current]="active() === 'home' ? 'page' : null" (click)="go($event, home())"><b aria-hidden="true">⌂</b>Home</a>
      <a [href]="reports()" [attr.aria-current]="active() === 'reports' ? 'page' : null" (click)="go($event, reports())"><b aria-hidden="true">▤</b>My reports</a>
    </nav>
  `,
})
export class ReporterNavComponent {
  private readonly router = inject(Router);
  readonly active = input<'home' | 'reports' | null>(null);
  /** The reporter mount root, taken from the current URL (works under any workspace id). */
  private readonly base = computed(() => {
    const u = this.router.url.split(/[?#]/)[0];
    const i = u.indexOf('/extensions/incidentlens-reports');
    return i >= 0 ? u.slice(0, i) + '/extensions/incidentlens-reports' : u;
  });
  protected readonly home = computed(() => this.base());
  protected readonly reports = computed(() => this.base() + '?view=all');
  protected go(e: Event, url: string): void { e.preventDefault(); this.router.navigateByUrl(url); }
}
