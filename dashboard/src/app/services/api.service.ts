import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import {
  AnalyticsSummary,
  ApiPoint,
  ComputeBucketPoint,
  ComputePoint,
  RegisterResponse,
  Resource,
  ResourceType,
  UsagePoint,
  WeeklyUsageResource,
} from '../models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = environment.apiBase;

  listResources(): Observable<Resource[]> {
    return this.http
      .get<{ resources: Resource[] }>(`${this.base}/api/resources`)
      .pipe(map((r) => r.resources));
  }

  registerResource(body: {
    name: string;
    type: ResourceType;
    interval_seconds?: number;
    metadata?: Record<string, unknown>;
  }): Observable<RegisterResponse> {
    return this.http.post<RegisterResponse>(`${this.base}/api/resources`, body);
  }

  computeMetrics(resourceId: number, from?: string, to?: string): Observable<ComputePoint[]> {
    let params = new HttpParams().set('resource_id', resourceId);
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http
      .get<{ points: ComputePoint[] }>(`${this.base}/api/metrics/compute`, { params })
      .pipe(map((r) => r.points));
  }

  // Per-hour or per-day averaged compute series for the wide 24h / 7d views.
  computeBucketed(
    resourceId: number,
    bucket: 'hour' | 'day',
    from?: string,
    to?: string
  ): Observable<ComputeBucketPoint[]> {
    let params = new HttpParams().set('resource_id', resourceId).set('bucket', bucket);
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http
      .get<{ points: ComputeBucketPoint[] }>(`${this.base}/api/metrics/compute/bucketed`, { params })
      .pipe(map((r) => r.points));
  }

  usageMetrics(resourceId: number, from?: string, to?: string): Observable<UsagePoint[]> {
    let params = new HttpParams().set('resource_id', resourceId);
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http
      .get<{ points: UsagePoint[] }>(`${this.base}/api/metrics/usage`, { params })
      .pipe(map((r) => r.points));
  }

  apiMetrics(resourceId: number, from?: string, to?: string): Observable<ApiPoint[]> {
    let params = new HttpParams().set('resource_id', resourceId);
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http
      .get<{ points: ApiPoint[] }>(`${this.base}/api/metrics/api`, { params })
      .pipe(map((r) => r.points));
  }

  // Week-over-week / month-over-month comparison for every resource.
  analyticsSummary(): Observable<AnalyticsSummary> {
    return this.http.get<AnalyticsSummary>(`${this.base}/api/analytics/summary`);
  }

  // Weekly usage-% trend for every resource (one line each) — analytics graph.
  weeklyUsage(weeks = 12): Observable<WeeklyUsageResource[]> {
    const params = new HttpParams().set('weeks', weeks);
    return this.http
      .get<{ resources: WeeklyUsageResource[] }>(`${this.base}/api/analytics/weekly-usage`, {
        params,
      })
      .pipe(map((r) => r.resources));
  }
}
