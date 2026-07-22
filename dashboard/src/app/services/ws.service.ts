import { Injectable, NgZone, inject } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { filter } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { LiveComputeMsg } from '../models';
import { getToken } from './token';

/**
 * Single shared WebSocket to the server, with per-resource subscribe/unsubscribe
 * and auto-reconnect. Components subscribe to a resource's live compute stream.
 */
@Injectable({ providedIn: 'root' })
export class WsService {
  private zone = inject(NgZone);
  private ws: WebSocket | null = null;
  private messages = new Subject<LiveComputeMsg>();
  private subscribed = new Set<number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private ensureConnected(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.ws = new WebSocket(environment.wsUrl);

    this.ws.onopen = () => {
      // Authenticate first — the server drops sockets that don't. Messages are
      // ordered, so the auth is processed before the subscriptions that follow.
      this.send({ action: 'auth', token: getToken() });
      // Re-subscribe to every channel after a (re)connect.
      for (const id of this.subscribed) this.send({ action: 'subscribe', resourceId: id });
    };
    this.ws.onmessage = (ev) => {
      let msg: LiveComputeMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'compute') {
        // WebSocket callbacks run outside Angular; re-enter so change detection fires.
        this.zone.run(() => this.messages.next(msg));
      }
    };
    this.ws.onclose = () => this.scheduleReconnect();
    this.ws.onerror = () => this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribed.size > 0) this.ensureConnected();
    }, 2000);
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Live compute datapoints for one resource. Manages (un)subscription by ref count. */
  compute(resourceId: number): Observable<LiveComputeMsg> {
    this.subscribed.add(resourceId);
    this.ensureConnected();
    this.send({ action: 'subscribe', resourceId });

    return new Observable<LiveComputeMsg>((observer) => {
      const sub = this.messages
        .pipe(filter((m) => m.resourceId === resourceId))
        .subscribe(observer);
      return () => {
        sub.unsubscribe();
        this.subscribed.delete(resourceId);
        this.send({ action: 'unsubscribe', resourceId });
      };
    });
  }
}
