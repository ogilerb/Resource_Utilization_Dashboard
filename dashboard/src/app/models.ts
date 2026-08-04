export type ResourceType = 'compute' | 'api' | 'usage' | 'calendar';

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

// Server-aggregated usage point (per-day or per-week average) used for the wide
// month/year usage views where raw ~15 min gauge samples are too dense to read.
// pace_* track how close usage stayed to an even weekly pace (100% = on track);
// null for non-resetting windows or buckets with no usable pace samples.
export interface UsageBucketPoint {
  timestamp: string;
  window_kind: string;
  utilization_avg: number;
  utilization_max: number;
  pace_avg: number | null;
  pace_max: number | null;
  sample_count: number;
}

// --- Calendar time analytics (GET /api/metrics/time[/bucketed]) ---

export type CalendarTier = 'productive' | 'neutral' | 'waste';

// One (day, category) time bucket: minutes spent + contiguous blocks that day.
export interface TimePoint {
  day: string; // YYYY-MM-DD (local)
  category: string;
  minutes: number;
  event_count: number;
}

// Config-order category→tier map, so the panel groups/orders/colors the stack
// consistently even for categories with no data in the window.
export interface CalendarCategory {
  category: string;
  tier: CalendarTier;
}

export interface TimeMetricsResponse {
  resource_id: number;
  points: TimePoint[];
  categories: CalendarCategory[];
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

// One resource's weekly usage-% trend, for overlaying every resource on the
// analytics graph view (x = week, y = usage %). pct is the weekly average of the
// resource's percentage metric (compute → CPU %, usage → subscription %).
export interface WeeklyUsageResource {
  resource_id: number;
  name: string;
  type: ResourceType;
  points: { week_start: string; pct: number }[];
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
