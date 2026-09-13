import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { dashboardTokenValid } from '../middleware/dashboardAuth.js';

/**
 * Live compute-metric fan-out. Dashboard clients connect and subscribe to a
 * per-resource channel; each compute ingest broadcasts the new datapoint to the
 * subscribers of that resource.
 *
 * A client MUST authenticate first — { "action": "auth", "token": <dashboard token> }
 * — before any subscribe is honored; unauthenticated sockets are dropped after a
 * short grace period. This mirrors the REST dashboard-token gate so the live
 * stream isn't an open back door around it.
 *
 * Client → server messages: { "action": "auth", "token": string }
 *                           { "action": "subscribe" | "unsubscribe", "resourceId": number }
 * Server → client messages:  { "type": "compute", "resourceId", "timestamp", "cpu_percent", "memory_bytes" }
 *                            { "type": "authed" } | { "type": "subscribed", "resourceId" }
 */

// Sockets that have presented a valid dashboard token.
const authed = new Set<WebSocket>();
const AUTH_GRACE_MS = 5_000;

// Per-IP throttle on FAILED ws auth, mirroring the REST authLimiter so the live
// stream isn't a rate-limit-free path for guessing the token. Fixed window.
const WS_AUTH_WINDOW_MS = 15 * 60_000;
const WS_AUTH_MAX_FAILURES = 30;
const wsAuthFailures = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

function wsAuthBlocked(ip: string): boolean {
  const entry = wsAuthFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    wsAuthFailures.delete(ip);
    return false;
  }
  return entry.count >= WS_AUTH_MAX_FAILURES;
}

function recordWsAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = wsAuthFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    wsAuthFailures.set(ip, { count: 1, resetAt: now + WS_AUTH_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export interface ComputePoint {
  resourceId: number;
  timestamp: string;
  cpu_percent: number | null;
  memory_bytes: number | null;
}

const subscriptions = new Map<WebSocket, Set<number>>();
let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server, path = '/ws'): WebSocketServer {
  wss = new WebSocketServer({ server, path });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    subscriptions.set(ws, new Set());

    // Drop the socket if it hasn't authenticated within the grace window.
    const authTimer = setTimeout(() => {
      if (!authed.has(ws)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Auth timeout' }));
        ws.close();
      }
    }, AUTH_GRACE_MS);

    ws.on('message', (raw) => {
      let msg: { action?: string; resourceId?: number; token?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      if (msg.action === 'auth') {
        if (wsAuthBlocked(ip)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Too many failed attempts' }));
          ws.close();
          return;
        }
        if (typeof msg.token === 'string' && dashboardTokenValid(msg.token)) {
          authed.add(ws);
          ws.send(JSON.stringify({ type: 'authed' }));
        } else {
          recordWsAuthFailure(ip);
          ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
          ws.close();
        }
        return;
      }

      // No subscription (and thus no data) until authenticated.
      if (!authed.has(ws)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
        return;
      }

      const channels = subscriptions.get(ws);
      if (!channels || typeof msg.resourceId !== 'number') return;

      if (msg.action === 'subscribe') {
        channels.add(msg.resourceId);
        ws.send(JSON.stringify({ type: 'subscribed', resourceId: msg.resourceId }));
      } else if (msg.action === 'unsubscribe') {
        channels.delete(msg.resourceId);
      }
    });

    const cleanup = () => {
      clearTimeout(authTimer);
      subscriptions.delete(ws);
      authed.delete(ws);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    // Lightweight keepalive ping so proxies don't drop idle connections.
    ws.send(JSON.stringify({ type: 'hello' }));
  });

  return wss;
}

/** Push a new compute datapoint to every client subscribed to its resource. */
export function broadcastCompute(point: ComputePoint): void {
  if (!wss) return;
  const payload = JSON.stringify({ type: 'compute', ...point });
  for (const [ws, channels] of subscriptions) {
    if (ws.readyState === WebSocket.OPEN && authed.has(ws) && channels.has(point.resourceId)) {
      ws.send(payload);
    }
  }
}

export function closeWebSocket(): void {
  wss?.close();
  wss = null;
  subscriptions.clear();
  authed.clear();
  wsAuthFailures.clear();
}
