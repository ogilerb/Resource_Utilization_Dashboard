import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AnalyticsResource } from '../models';
import { formatBytes, formatNumber } from '../util';
import { DeltaBadgeComponent } from './delta-badge.component';

const METRIC_LABELS: Record<string, string> = {
  cpu_percent: 'Avg CPU',
  memory_bytes: 'Avg memory',
  utilization: 'Weekly usage',
  cost: 'Spend',
  tokens: 'Tokens',
};

/**
 * Week-over-week / month-over-month summary. Purely presentational — it's fed
 * the analytics the overview already fetched, so it makes no extra request.
 */
@Component({
  selector: 'app-analytics-panel',
  standalone: true,
  imports: [CommonModule, DeltaBadgeComponent],
  template: `
    @if (analytics.length) {
      <div class="card analytics">
        <div class="analytics-head">
          <h3 style="margin:0">Performance vs. previous period</h3>
          <span class="muted">rolling 7-day &amp; 30-day windows · ▼ = down vs. before</span>
        </div>
        <div class="analytics-grid">
          <div class="analytics-row head">
            <span>Resource</span><span>Metric</span><span>Current</span><span>WoW</span><span>MoM</span>
          </div>
          @for (a of analytics; track a.resource_id) {
            <div class="analytics-row">
              <span class="name">{{ names[a.resource_id] || '#' + a.resource_id }}</span>
              <span class="muted">{{ metricLabel(a.metric) }}</span>
              <span class="value">{{ fmtMetric(a.metric, a.week.current) }}</span>
              <span><app-delta-badge [delta]="a.week" label="wk" tooltip="vs previous 7 days" /></span>
              <span><app-delta-badge [delta]="a.month" label="mo" tooltip="vs previous 30 days" /></span>
            </div>
          }
        </div>
      </div>
    }
  `,
})
export class AnalyticsPanelComponent {
  @Input() analytics: AnalyticsResource[] = [];
  @Input() names: Record<number, string> = {};

  metricLabel(metric: string): string {
    return METRIC_LABELS[metric] ?? metric;
  }

  fmtMetric(metric: string, value: number | null): string {
    if (value == null) return '—';
    switch (metric) {
      case 'cpu_percent':
      case 'utilization':
        return `${value.toFixed(0)}%`;
      case 'cost':
        return `$${value.toFixed(2)}`;
      case 'memory_bytes':
        return formatBytes(value);
      case 'tokens':
        return formatNumber(value);
      default:
        return String(value);
    }
  }
}
