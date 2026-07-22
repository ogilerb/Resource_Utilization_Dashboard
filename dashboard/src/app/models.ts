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

// Server-aggregated compute point (per-hour or per-day average) used for the
// wide 24h/7d chart views where raw 15s samples are too dense to read.
export interface ComputeBucketPoint {
  timestamp: string;
  cpu_percent_avg: number | null;
  cpu_percent_max: number | null;
  memory_bytes_avg: number | null;
  memory_bytes_max: number | null;
  sample_count: number;
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

// Average subscription usage % bucketed by calendar week (analytics graph view).
export interface UsageWeekPoint {
  week_start: string;
  avg_utilization: number;
  max_utilization: number;
  sample_count: number;
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
