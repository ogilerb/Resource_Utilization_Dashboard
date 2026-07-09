import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Live compute-metric fan-out. Dashboard clients connect and subscribe to a
 * per-resource channel; each compute ingest broadcasts the new datapoint to the
 * subscribers of that resource.
 *
 * Client → server messages: { "action": "subscribe" | "unsubscribe", "resourceId": number }
 * Server → client messages:  { "type": "compute", "resourceId", "timestamp", "cpu_percent", "memory_bytes" }
 *                            { "type": "subscribed", "resourceId" }
 */

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

  wss.on('connection', (ws) => {
    subscriptions.set(ws, new Set());

    ws.on('message', (raw) => {
      let msg: { action?: string; resourceId?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
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

    ws.on('close', () => subscriptions.delete(ws));
    ws.on('error', () => subscriptions.delete(ws));

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
    if (ws.readyState === WebSocket.OPEN && channels.has(point.resourceId)) {
      ws.send(payload);
    }
  }
}

export function closeWebSocket(): void {
  wss?.close();
  wss = null;
  subscriptions.clear();
}
