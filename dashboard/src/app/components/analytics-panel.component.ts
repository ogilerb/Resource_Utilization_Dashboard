import { Component, ElementRef, Input, OnDestroy, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { AnalyticsResource, UsageWeekPoint } from '../models';
import { formatBytes, formatNumber } from '../util';
import { ApiService } from '../services/api.service';
import { DeltaBadgeComponent } from './delta-badge.component';

Chart.register(...registerables);

const METRIC_LABELS: Record<string, string> = {
  cpu_percent: 'Avg CPU',
  memory_bytes: 'Avg memory',
  utilization: 'Weekly usage',
  cost: 'Spend',
  tokens: 'Tokens',
};

/**
 * Week-over-week / month-over-month summary with two views:
 *  - Table: per-resource current value + WoW/MoM deltas (fed by the overview,
 *    no extra request).
 *  - Graph: average subscription usage % bucketed by week, fetched lazily the
 *    first time the graph is opened.
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
          <div class="view-toggle">
            <button [class.active]="view === 'table'" (click)="setView('table')">Table</button>
            <button [class.active]="view === 'graph'" (click)="setView('graph')">Graph</button>
          </div>
        </div>

        @if (view === 'table') {
          <p class="muted" style="margin:0 0 0.75rem">
            rolling 7-day &amp; 30-day windows · ▼ = down vs. before
          </p>
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
        } @else {
          <p class="muted" style="margin:0 0 0.75rem">Average weekly usage % (all subscriptions)</p>
          @if (weeklyLoaded && weekly.length === 0) {
            <p class="muted">No subscription usage samples yet. Install the Claude usage extension and point it here.</p>
          } @else {
            <div class="chart-wrap" style="height:240px"><canvas #canvas></canvas></div>
          }
        }
      </div>
    }
  `,
})
export class AnalyticsPanelComponent implements OnDestroy {
  @Input() analytics: AnalyticsResource[] = [];
  @Input() names: Record<number, string> = {};

  private api = inject(ApiService);
  private chart?: Chart;
  private canvasRef?: ElementRef<HTMLCanvasElement>;

  view: 'table' | 'graph' = 'table';
  weekly: UsageWeekPoint[] = [];
  weeklyLoaded = false;

  // The canvas only exists in graph view (behind @if); build the chart when it
  // appears and tear it down when it's removed.
  @ViewChild('canvas') set canvas(ref: ElementRef<HTMLCanvasElement> | undefined) {
    this.canvasRef = ref;
    if (ref) {
      this.buildChart();
      this.renderChart();
    } else {
      this.chart?.destroy();
      this.chart = undefined;
    }
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  setView(view: 'table' | 'graph'): void {
    this.view = view;
    if (view === 'graph') this.loadWeekly();
  }

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

  private loadWeekly(): void {
    this.api.usageWeekly(12).subscribe((weeks) => {
      this.weekly = weeks;
      this.weeklyLoaded = true;
      this.renderChart();
    });
  }

  private buildChart(): void {
    if (!this.canvasRef) return;
    this.chart?.destroy();
    const cfg: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Avg weekly usage %',
            data: [],
            backgroundColor: '#4f8cff',
            borderRadius: 4,
            maxBarThickness: 48,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { ticks: { color: '#93a1b8' }, grid: { display: false } },
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: 'Avg usage %', color: '#93a1b8' },
            ticks: { color: '#93a1b8', callback: (v) => v + '%' },
            grid: { color: '#22304a' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? `Week of ${items[0].label}` : ''),
              label: (ctx) => `Avg: ${Number(ctx.parsed.y).toFixed(1)}%`,
              afterLabel: (ctx) => {
                const w = this.weekly[ctx.dataIndex];
                return w ? `Peak: ${w.max_utilization.toFixed(0)}% · ${w.sample_count} samples` : '';
              },
            },
          },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  private renderChart(): void {
    if (!this.chart) return;
    this.chart.data.labels = this.weekly.map((w) =>
      new Date(w.week_start).toLocaleDateString([], { month: 'short', day: 'numeric' })
    );
    this.chart.data.datasets[0].data = this.weekly.map((w) => Number(w.avg_utilization));
    this.chart.update('none');
  }
}
