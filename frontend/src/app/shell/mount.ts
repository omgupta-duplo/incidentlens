import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';

/**
 * Every manifest route (reports / incidents / inbox / agencies) mounts this same remote's `Extension` routes, so
 * each top-level subtree is selected by which mount the URL is under. The host's extension-route-registrar
 * places mounts at `…/extensions/<segment>`.
 */
export type Mount = 'incidentlens-reports' | 'incidentlens-incidents' | 'incidentlens-inbox' | 'incidentlens-agencies';

export function currentMount(router: Router): Mount | null {
  const url = router.getCurrentNavigation()?.extractedUrl?.toString() ?? router.url ?? '';
  const m = url.match(/\/extensions\/(incidentlens-(?:reports|incidents|inbox|agencies))(?:[/?#]|$)/);
  return (m?.[1] as Mount) ?? null;
}

export const mountIs = (m: Mount): CanMatchFn => () => currentMount(inject(Router)) === m;
