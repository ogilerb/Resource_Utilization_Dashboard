export type ResourceType = 'compute' | 'api';

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
