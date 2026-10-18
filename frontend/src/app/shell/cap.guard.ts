import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { IncidentLensService } from '../incidentlens.service';
import { IL_MODE, landingFor } from './il-mode';

/**
 * Route guard choosing whether to SHOW a screen (the server enforces every endpoint regardless). On denial it
 * redirects to the mount's own "not granted" page so the user gets an explanation instead of a broken screen.
 * In IncidentLens mode only: `?home=1` (the entry link) and a denied screen send the user to their
 * capability-based landing screen instead. Navigation only — no capability is granted or assumed here.
 */
export const capGuard = (capability: string): CanActivateFn => (route, state) => {
  const svc = inject(IncidentLensService);
  const router = inject(Router);
  const base = state.url.match(/^(.*\/extensions\/incidentlens-[a-z]+)/)?.[1] ?? '';
  const wantsHome = IL_MODE && route.queryParamMap.get('home') === '1';
  return svc.whoami().pipe(
    map(m => {
      const allowed = m.isAdmin || !!m.capabilities?.[capability];
      if (IL_MODE && (wantsHome || !allowed)) {
        const land = landingFor(m);
        const target = land ? base.replace(/incidentlens-[a-z]+$/, land) : '';
        if (land && (target !== base || wantsHome)) return router.parseUrl(target);
      }
      return allowed ? true : router.parseUrl(`${base}/not-granted?need=${encodeURIComponent(capability)}`);
    }),
    catchError(() => of(router.parseUrl(`${base}/not-granted?need=error`))),
  );
};
