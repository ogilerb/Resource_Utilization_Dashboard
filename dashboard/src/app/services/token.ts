// Dashboard access token store. The token is the single shared secret the
// server requires on every read/admin request and on the WebSocket. We keep it
// in localStorage so it survives reloads; a wrong/rotated token is cleared by
// the auth interceptor on the first 401 so the user is re-prompted.
//
// This is deliberately minimal (a prompt + localStorage) — appropriate for a
// single-user personal dashboard. Swap for a real login screen if this ever
// becomes multi-user.

const KEY = 'dashboardToken';

export function getToken(): string {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem(KEY) ?? '';
}

export function setToken(token: string): void {
  if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(KEY);
}

/** Return the stored token, prompting for one if none is set. May return ''. */
export function ensureToken(): string {
  let token = getToken();
  if (!token && typeof window !== 'undefined') {
    token = window.prompt('Enter dashboard access token') ?? '';
    if (token) setToken(token);
  }
  return token;
}
