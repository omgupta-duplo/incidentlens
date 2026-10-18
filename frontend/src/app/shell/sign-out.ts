/**
 * Sign-out through the HOST's AuthNZService (REMOTE_AuthNZService). The host clears its session only when its
 * /api/Account/LogOut call SUCCEEDS (AuthNZService.logout → resolve), so only success may leave the page.
 * Failure or a missing service reports an error and leaves the user signed in — never a false "signed out".
 */
export interface SignOutOutcome { ok: boolean; error?: string }

export function signOutVia(authnz: any): Promise<SignOutOutcome> {
  if (!authnz || typeof authnz.logout !== 'function')
    return Promise.resolve({ ok: false, error: 'Sign out is unavailable right now — you are still signed in. Reload the page and try again.' });
  return new Promise(resolve => {
    try {
      authnz.logout(() => resolve({ ok: true }),
        () => resolve({ ok: false, error: 'Sign out failed — you are still signed in. Check your connection and try again.' }));
    } catch {
      resolve({ ok: false, error: 'Sign out failed — you are still signed in. Try again.' });
    }
  });
}

/**
 * After a SUCCESSFUL host logout, a Keycloak user must also end the Keycloak SSO session — otherwise the next
 * "Continue with Keycloak" silently signs the previous Keycloak user back in (switching demo users in one browser).
 * Uses Keycloak's standard end-session endpoint with the realm's already-registered post-logout redirect; no
 * configuration change. Returns null (plain /app/login) for non-Keycloak users or incomplete/unsafe config.
 */
export function keycloakLogoutUrl(provider: string | null | undefined, sso: any, origin: string): string | null {
  if (provider !== 'keycloak' || !sso?.EnableKeycloak) return null;
  const host = String(sso.KeycloakHost ?? ''), realm = String(sso.KeycloakRealm ?? ''), client = String(sso.KeycloakClientId ?? '');
  if (!/^https?:\/\/[^\s/?#]+$/.test(host.replace(/\/$/, '')) || !/^[A-Za-z0-9_-]+$/.test(realm) || !/^[A-Za-z0-9_.-]+$/.test(client)) return null;
  return `${host.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/logout?client_id=${encodeURIComponent(client)}`
    + `&post_logout_redirect_uri=${encodeURIComponent(origin + '/app/login')}`;
}
