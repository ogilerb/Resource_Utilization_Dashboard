import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import {
  ApiPoint,
  ComputePoint,
  RegisterResponse,
  Resource,
  ResourceType,
  UsagePoint,
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
}
