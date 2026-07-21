import { Injectable, signal } from '@angular/core';
import { CardPref, CardSpan, DashboardLayout, Resource } from '../models';

const KEY = 'dashboard.layout.v1';
const DEFAULT_PREF: CardPref = { span: 1, expanded: false };

/**
 * Per-browser dashboard layout (card order + size + expanded state), persisted
 * to localStorage. There's no auth/user system, so per-browser is the right
 * scope. New resources are appended; deleted ones are pruned on reconcile.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private state = signal<DashboardLayout>(this.load());
  readonly layout = this.state.asReadonly();

  private load(): DashboardLayout {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DashboardLayout;
        if (parsed && Array.isArray(parsed.order) && parsed.cards) return parsed;
      }
    } catch {
      /* malformed / unavailable storage → fall through to empty layout */
    }
    return { order: [], cards: {} };
  }

  private persist(next: DashboardLayout): void {
    this.state.set(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota exceeded / private mode — keep the in-memory layout anyway */
    }
  }

  /**
   * Reconcile the saved layout with the current resource set and return the
   * resources in display order. Keeps known order, appends newly-registered
   * resources at the end, drops deleted ones. Call whenever resources refetch.
   */
  reconcile(resources: Resource[]): Resource[] {
    const byId = new Map(resources.map((r) => [r.id, r]));
    const cur = this.state();

    const cards: Record<number, CardPref> = {};
    for (const r of resources) cards[r.id] = cur.cards[r.id] ?? { ...DEFAULT_PREF };

    const kept = cur.order.filter((id) => byId.has(id));
    const known = new Set(kept);
    const appended = resources.filter((r) => !known.has(r.id)).map((r) => r.id);
    const next: DashboardLayout = { order: [...kept, ...appended], cards };

    // Avoid churning localStorage on every 10s poll when nothing changed.
    if (JSON.stringify(cur) !== JSON.stringify(next)) this.persist(next);

    return next.order.map((id) => byId.get(id)).filter((r): r is Resource => !!r);
  }

  pref(id: number): CardPref {
    return this.state().cards[id] ?? { ...DEFAULT_PREF };
  }

  setSpan(id: number, span: CardSpan): void {
    const cur = this.state();
    this.persist({ ...cur, cards: { ...cur.cards, [id]: { ...this.pref(id), span } } });
  }

  setExpanded(id: number, expanded: boolean): void {
    const cur = this.state();
    this.persist({ ...cur, cards: { ...cur.cards, [id]: { ...this.pref(id), expanded } } });
  }

  setOrder(order: number[]): void {
    this.persist({ ...this.state(), order });
  }

  reset(): void {
    this.persist({ order: [], cards: {} });
  }
}
