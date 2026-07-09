// REST + WebSocket base URLs. In production the dashboard is served behind the
// same reverse proxy as the API, so relative paths resolve correctly and the WS
// URL is derived from the current origin.
function wsBase(): string {
  if (typeof window === 'undefined') return 'ws://localhost:4000/ws';
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // Same-origin /ws by default (nginx proxies it); override for local dev below.
  return `${proto}://${window.location.host}/ws`;
}

const isDevServer =
  typeof window !== 'undefined' && window.location.port === '4200';

export const environment = {
  production: false,
  // In `ng serve` (port 4200) talk to the local API on :4000; otherwise same-origin.
  apiBase: isDevServer ? 'http://localhost:4000' : '',
  wsUrl: isDevServer ? 'ws://localhost:4000/ws' : wsBase(),
};
