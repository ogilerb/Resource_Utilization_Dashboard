export type ResourceType = 'compute' | 'api' | 'usage';

export interface Resource {
  id: number;
  name: string;
  type: ResourceType;
  status: string;
  interval_seconds: number;
  metadata: Record<string, unknown>;
  created_at: string;
  last_seen: string | null;
  online: boolean;
}

export interface ComputePoint {
  timestamp: string;
  cpu_percent: number | null;
  memory_bytes: number | null;
}

export interface ApiPoint {
  day: string;
  tokens_in: number;
  tokens_out: number;
  cost: number;
}

export interface UsagePoint {
  timestamp: string;
  window_kind: string;
  utilization: number;
  resets_at: string | null;
  raw: Record<string, unknown> | null;
}

export interface RegisterResponse {
  resource: Resource;
  api_key: string;
}

// WebSocket live message for compute metrics.
export interface LiveComputeMsg {
  type: 'compute';
  resourceId: number;
  timestamp: string;
  cpu_percent: number | null;
  memory_bytes: number | null;
}

// --- Week-over-week / month-over-month analytics (GET /api/analytics/summary) ---

export interface PeriodDelta {
  current: number | null;
  previous: number | null;
  delta_pct: number | null; // null when there's no previous baseline
}

export interface AnalyticsMetric {
  metric: string; // e.g. 'cpu_percent' | 'utilization' | 'cost'
  week: PeriodDelta;
  month: PeriodDelta;
}

export interface AnalyticsResource extends AnalyticsMetric {
  resource_id: number;
  type: ResourceType;
  secondary?: AnalyticsMetric;
}

export interface AnalyticsSummary {
  resources: AnalyticsResource[];
}

// --- Dashboard layout customization (persisted per-browser in localStorage) ---

export type CardSpan = 1 | 2 | 3;

export interface CardPref {
  span: CardSpan; // width in columns (S/M/L)
  expanded: boolean; // full interactive chart vs compact mini chart
}

export interface DashboardLayout {
  order: number[]; // resource ids in display order
  cards: Record<number, CardPref>;
}
