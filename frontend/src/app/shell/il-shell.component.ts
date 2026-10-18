import { Component, DestroyRef, ElementRef, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, interval } from 'rxjs';
import { IncidentLensService, WhoAmI } from '../incidentlens.service';
import { BRIEF_NAV, IL_MODE, NAV, can, canAnyRole, landingFor, mountUrl } from './il-mode';
import { keycloakLogoutUrl, signOutVia } from './sign-out';
import { isFocusLost, pathOf, shouldMoveFocus } from '../util';
import { Mount } from './mount';
import { PriorityAlertsComponent } from '../shared/priority-alerts.component';

const SECTION: Record<Mount, string> = {
  'incidentlens-incidents': 'Control room', 'incidentlens-reports': 'My reports',
  'incidentlens-inbox': 'My assignments', 'incidentlens-agencies': 'Agency directory',
};
const TEXT_KEY = 'incidentlens.largeText';

/**
 * Layout parent for every IncidentLens screen. Outside IncidentLens mode it renders only <router-outlet> (the
 * normal portal look is unchanged). In IncidentLens mode (the host hid its chrome: non-admin on an IncidentLens route) it
 * renders the extension's own navy sidebar + slim header. It never chooses screens — routes + guards do — so the
 * router cannot reuse one screen's instance for another. Nav entries come from the signed-in user's capabilities.
 */
@Component({
  selector: 'il-shell',
  imports: [RouterOutlet, PriorityAlertsComponent],
  styleUrl: './il-shell.scss',
  template: `
    @if (mode) {
      <div class="ils" [class.ils-large]="largeText()" [class.ils-menu-open]="menuOpen()">
        <a class="ils-skip" href="#il-main" (click)="skip($event)">Skip to content</a>
        <aside class="ils-side" aria-label="IncidentLens">
          <div class="ils-brand"><svg class="ils-logo" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><path d="M11 3H3v8M29 3h8v8M37 29v8h-8M11 37H3v-8" fill="none" stroke="#edf2e8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="20" r="9" fill="none" stroke="#718f70" stroke-width="2.5"/><circle cx="20" cy="20" r="4.25" fill="#d88728"/></svg>
            <span><span class="ils-word">Incident<b>Lens</b></span><span class="ils-tag">Connected response</span></span></div>
          <div class="ils-ws"><span class="ils-ws-i" aria-hidden="true">{{ wsInitial() }}</span>
            <span><strong>{{ wsName() }}</strong><small>{{ roleLine() }}</small></span></div>
          <p class="ils-label" id="ils-nav-h">Your workspace</p>
          <nav aria-labelledby="ils-nav-h">
            <ul>
              @for (n of nav(); track n.mount) {
                <li><a [href]="href(n.mount)" (click)="go($event, n.mount)" [class.on]="active() === n.mount && !inBriefs()"
                       [attr.aria-current]="active() === n.mount && !inBriefs() ? 'page' : null">
                  <span aria-hidden="true" [class]="'ils-ico i-' + n.icon"></span>
                  <span class="ils-nl">{{ n.label }}</span>
                  @if (count(n.mount); as c) { <span class="ils-count" [attr.aria-label]="c + ' ' + countLabel(n.mount)">{{ c }}</span> }
                </a></li>
              }
              @if (briefHome(); as bh) {
                <li><a [href]="href(bh, brief.sub)" (click)="go($event, bh, brief.sub)" [class.on]="inBriefs()" [attr.aria-current]="inBriefs() ? 'page' : null">
                  <span aria-hidden="true" class="ils-ico i-brief"></span><span class="ils-nl">{{ brief.label }}</span></a></li>
              }
            </ul>
          </nav>
          <div class="ils-foot">
            <p class="ils-motto"><span aria-hidden="true">●</span> One incident. One shared picture.</p>
            <div class="ils-user"><span class="ils-av" aria-hidden="true">{{ initials() }}</span>
              <span><strong [attr.title]="who()?.email">{{ who()?.email || 'Signed in' }}</strong><small>{{ roleLine() }}</small></span></div>
          </div>
        </aside>
        <div class="ils-body">
          <header class="ils-top">
            <button type="button" class="ils-menu" (click)="menuOpen.set(!menuOpen())" [attr.aria-expanded]="menuOpen()" aria-label="Menu">☰</button>
            <span class="ils-mobile-brand" role="img" aria-label="IncidentLens"><svg class="ils-mobile-logo" viewBox="0 0 40 40" aria-hidden="true" focusable="false"><path d="M11 3H3v8M29 3h8v8M37 29v8h-8M11 37H3v-8" fill="none" stroke="#203e37" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="20" r="9" fill="none" stroke="#718f70" stroke-width="2.5"/><circle cx="20" cy="20" r="4.25" fill="#d88728"/></svg></span>
            <nav aria-label="Breadcrumb" class="ils-crumbs"><ol>
              <li>{{ wsName() }}</li>
              @if (active(); as a) { <li [attr.aria-current]="!detail() ? 'page' : null">
                @if (detail()) { <a [href]="href(a)" (click)="go($event, a)">{{ section(a) }}</a> } @else { {{ section(a) }} }</li> }
              @if (detail(); as d) { <li aria-current="page">{{ d }}</li> }
            </ol></nav>
            <div class="ils-actions">
              <button type="button" class="ils-act" [attr.aria-pressed]="largeText()" (click)="toggleText()"><span aria-hidden="true">Aa</span> Larger text</button>
              <button type="button" class="ils-act" [disabled]="signingOut()" [attr.aria-busy]="signingOut()" (click)="signOut()">{{ signingOut() ? 'Signing out…' : 'Sign out' }}</button>
              <span class="ils-av sm" [attr.title]="who()?.email" aria-hidden="true">{{ initials() }}</span>
            </div>
          </header>
          @if (signOutError()) { <p class="ils-err" role="alert">{{ signOutError() }}
            <button type="button" class="ils-act" (click)="signOutError.set('')">Dismiss</button></p> }
          @if (alertAudience(); as audience) { <il-priority-alerts [audience]="audience" [identity]="who()?.email || ''" /> }
          <main id="il-main" class="ils-main" tabindex="-1" #main><router-outlet /></main>
        </div>
      </div>
    } @else {
      @if (alertAudience(); as audience) { <il-priority-alerts [audience]="audience" [identity]="who()?.email || ''" /> }
      <router-outlet />
    }
  `,
})
export class IlShellComponent implements OnInit {
  private readonly svc = inject(IncidentLensService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly main = viewChild<ElementRef<HTMLElement>>('main');
  // The host's own AuthNZService (string DI token). Its logout() calls /api/Account/LogOut and clears the session.
  private readonly authnz = inject<any>('REMOTE_AuthNZService' as any, { optional: true });
  protected readonly signingOut = signal(false);
  protected readonly signOutError = signal('');
  protected readonly mode = IL_MODE;
  protected readonly who = signal<WhoAmI | null>(null);
  protected readonly url = signal(this.router.url);
  protected readonly menuOpen = signal(false);
  protected readonly largeText = signal(readFlag());
  private readonly counts = signal<Partial<Record<Mount, number>>>({});

  protected readonly nav = computed(() => NAV.filter(n => can(this.who(), n.cap)));
  protected readonly alertAudience = computed(() => !this.active() ? null : this.active() === 'incidentlens-inbox' && can(this.who(), 'incidentlens.respond') ? 'responder' as const : can(this.who(), 'incidentlens.triage') ? 'control' as const : can(this.who(), 'incidentlens.respond') ? 'responder' as const : null);
  protected readonly brief = BRIEF_NAV;
  protected readonly briefHome = computed(() => canAnyRole(this.who()) ? landingFor(this.who()) : null);
  protected readonly inBriefs = computed(() => /\/briefs(\/|$|\?)/.test(this.url()));
  protected readonly active = computed<Mount | null>(() => mountOf(this.url()));
  protected readonly detail = computed(() => detailOf(this.url()));
  protected readonly wsName = computed(() => this.svc.workspaceName() || 'Workspace');
  protected readonly wsInitial = computed(() => (this.wsName()[0] ?? 'W').toUpperCase());
  protected readonly initials = computed(() => (this.who()?.email ?? '?').split('@')[0].split(/[._-]/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase() || '?');
  protected readonly roleLine = computed(() => {
    const w = this.who(); if (!w) return '';
    const r = [can(w, 'incidentlens.triage') && 'Control room', can(w, 'incidentlens.respond') && 'Responder', can(w, 'incidentlens.report') && 'Reporter'].filter(Boolean);
    return (w.isAdmin ? 'Administrator · ' : '') + (r.join(' · ') || 'No IncidentLens access');
  });

  ngOnInit(): void {
    this.svc.whoami().subscribe({ next: w => { this.who.set(w); if (this.mode) this.loadCounts(); }, error: () => this.who.set(null) });
    this.router.events.pipe(filter(e => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      const prev = this.url();
      this.url.set(this.router.url); this.menuOpen.set(false);
      if (this.mode && pathOf(prev) !== pathOf(this.router.url)) this.focusNewScreen(prev, this.router.url);
    });
    interval(30000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => { if (this.mode) this.loadCounts(); });
  }

  /** D6: once the new screen's h1 renders, focus it (programmatic only) if keyboard focus was lost to <body>. */
  private focusNewScreen(prev: string, next: string): void {
    let tries = 0;
    const attempt = () => {
      if (this.router.url !== next) return;                                   // superseded by another navigation
      if (!shouldMoveFocus(prev, next, isFocusLost(document.activeElement, document.body))) return;
      const main = this.main()?.nativeElement;
      const h1 = main?.querySelector('h1') as HTMLElement | null;
      if (!h1 && ++tries < 40) { setTimeout(attempt, 50); return; }          // async screens render their h1 late (≤ 2 s)
      const target = h1 ?? main;
      if (!target) return;
      if (target === h1 && !h1.hasAttribute('tabindex')) h1.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: false });
    };
    setTimeout(attempt, 0);
  }

  private loadCounts(): void {
    const w = this.who();
    if (can(w, 'incidentlens.triage')) this.svc.incidents().subscribe({ next: r => this.setCount('incidentlens-incidents', (r ?? []).filter(i => !i.result?.closed).length), error: () => {} });
    if (can(w, 'incidentlens.respond')) this.svc.assigned().subscribe({ next: r => this.setCount('incidentlens-inbox', (r ?? []).length), error: () => {} });
  }
  private setCount(m: Mount, n: number): void { this.counts.update(c => ({ ...c, [m]: n })); }
  protected count(m: Mount): number { return this.counts()[m] ?? 0; }
  protected countLabel(m: Mount): string { return m === 'incidentlens-incidents' ? 'open incidents' : 'active assignments'; }
  protected section(m: Mount): string { return SECTION[m]; }
  protected href(m: Mount, sub = ''): string { return mountUrl(this.svc.workspaceId(), m, sub); }
  protected go(e: Event, m: Mount, sub = ''): void { e.preventDefault(); this.router.navigateByUrl(this.href(m, sub)); }
  protected skip(e: Event): void { e.preventDefault(); this.main()?.nativeElement.focus(); }
  protected toggleText(): void { const v = !this.largeText(); this.largeText.set(v); try { localStorage.setItem(TEXT_KEY, v ? '1' : '0'); } catch { /* optional */ } }
  /** Host logout; only on SUCCESS leave the page — via Keycloak's end-session for Keycloak users, else /app/login
   *  (a FULL load either way, which also leaves the bootstrap-latched mode). Failure/missing service → inline error. */
  protected signOut(): void {
    this.signingOut.set(true); this.signOutError.set('');
    const provider = this.svc.userProvider();          // read BEFORE logout clears the session
    const sso$ = fetch('/api/Account/SsoConfig').then(r => (r.ok ? r.json() : null)).catch(() => null);
    signOutVia(this.authnz).then(async r => {
      if (!r.ok) { this.signingOut.set(false); this.signOutError.set(r.error ?? 'Sign out failed — you are still signed in.'); return; }
      window.location.assign(keycloakLogoutUrl(provider, await sso$, window.location.origin) ?? '/app/login');
    });
  }
}

function readFlag(): boolean { try { return localStorage.getItem(TEXT_KEY) === '1'; } catch { return false; } }
function mountOf(url: string): Mount | null { return (url.match(/\/extensions\/(incidentlens-(?:reports|incidents|inbox|agencies))(?:[/?#]|$)/)?.[1] as Mount) ?? null; }
function detailOf(url: string): string {
  const p = url.split('?')[0];
  if (/incidentlens-reports\/new$/.test(p)) return 'New report';
  if (/incidentlens-reports\/view\//.test(p)) return 'Report';
  if (/incidentlens-incidents\/reports\//.test(p)) return 'Report review';
  if (/incidentlens-incidents\/incidents\//.test(p)) return 'Incident';
  if (/\/briefs\/[^/]+$/.test(p)) return 'Situation brief';
  if (/\/briefs$/.test(p)) return 'Situation briefs';
  if (/\/not-granted$/.test(p)) return 'Not available';
  if (/incidentlens-inbox\/[^/]+$/.test(p)) return 'Assigned incident';
  return '';
}
