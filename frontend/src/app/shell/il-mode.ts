import type { WhoAmI } from '../incidentlens.service';
import type { Mount } from './mount';

/**
 * IncidentLens mode = the host hid its chrome for this page load. The patched host decides it from the PLATFORM
 * administrator flag (non-admins on IncidentLens routes; admins always get the normal portal) and publishes the
 * decision on <html data-incidentlens-mode="1">. An older host without that contract (no data-incidentlens-host)
 * falls back to the boot url's ?chromeless=1, which is what that host latched.
 */
function bootUrl(): string {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav?.name || window.location.href;
  } catch { return window.location.href; }
}
export const IL_MODE: boolean = (() => {
  try {
    const ds = document.documentElement.dataset;
    if (ds['incidentlensHost'] === '1') return ds['incidentlensMode'] === '1';
    return new URL(bootUrl()).searchParams.get('chromeless') === '1';
  } catch { return false; }
})();

/** Capability → screen. Navigation only; every screen is still guarded and every endpoint enforced server-side. */
export const NAV: { mount: Mount; label: string; cap: string; icon: string }[] = [
  { mount: 'incidentlens-incidents', label: 'Control room', cap: 'incidentlens.triage', icon: 'control' },
  { mount: 'incidentlens-reports', label: 'Report an incident', cap: 'incidentlens.report', icon: 'report' },
  { mount: 'incidentlens-inbox', label: 'My assignments', cap: 'incidentlens.respond', icon: 'team' },
  { mount: 'incidentlens-agencies', label: 'Agency directory', cap: 'incidentlens.triage', icon: 'agency' },
];

/** Situation brief: open to every IncidentLens role, served under the user's own landing mount. */
export const BRIEF_NAV = { label: 'Situation brief', icon: 'brief', sub: '/briefs' };

export const can = (w: WhoAmI | null | undefined, cap: string) => !!w && (w.isAdmin || !!w.capabilities?.[cap]);
export const canAnyRole = (w: WhoAmI | null | undefined) => ['incidentlens.report', 'incidentlens.triage', 'incidentlens.respond'].some(c => can(w, c));

/** Default landing from the signed-in user's real capabilities: control room → assignments → reports. */
export function landingFor(w: WhoAmI | null | undefined): Mount | null {
  for (const m of ['incidentlens-incidents', 'incidentlens-inbox', 'incidentlens-reports'] as Mount[])
    if (can(w, NAV.find(n => n.mount === m)!.cap)) return m;
  return null;
}

/** Absolute in-portal url for a mount (+ sub-path). The host keeps the mode by route + admin flag, not by query. */
export function mountUrl(ws: string, mount: Mount, sub = ''): string {
  return `/ai/suite/${ws}/extensions/${mount}${sub}`;
}
