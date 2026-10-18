import { Component, DestroyRef, OnChanges, inject, input, signal } from '@angular/core';
import { IncidentLensService } from '../incidentlens.service';

/** Fetches a protected photo through the authenticated host client (no token in a URL) and renders it. */
@Component({
  selector: 'il-auth-image',
  styles: [`:host { display: block; } img { width: 100%; max-height: 360px; object-fit: contain; background: #0b2545; border-radius: 8px; }
            .ph { border: 1px dashed #9fb6c1; border-radius: 8px; padding: 18px; color: #4a5d6e; text-align: center; }`],
  template: `
    @if (url()) { <img [src]="url()" [alt]="alt()" /> }
    @else if (failed()) { <div class="ph" role="note">Photo unavailable to you.</div> }
    @else { <div class="ph" aria-live="polite">Loading photo…</div> }
  `,
})
export class AuthImageComponent implements OnChanges {
  readonly src = input.required<string>();
  readonly alt = input.required<string>();
  private readonly svc = inject(IncidentLensService);
  protected readonly url = signal<string | null>(null);
  protected readonly failed = signal(false);

  constructor() { inject(DestroyRef).onDestroy(() => this.revoke()); }

  ngOnChanges(): void {
    this.revoke(); this.failed.set(false);
    this.svc.imageUrl(this.src()).subscribe({ next: u => this.url.set(u), error: () => this.failed.set(true) });
  }

  private revoke(): void { const u = this.url(); if (u) URL.revokeObjectURL(u); this.url.set(null); }
}
