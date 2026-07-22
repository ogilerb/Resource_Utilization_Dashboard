import { Component, ElementRef, Input, OnDestroy, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { AnalyticsResource, WeeklyUsageResource } from '../models';
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

// Per-resource line colors: the dark-surface categorical steps from the data-viz
// palette, in fixed order (validated for the #182234 panel surface; adjacent CVD
// sits in the 8–12 floor band, which the always-present legend covers).
const SERIES_COLORS = [
  '#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926',
];

/**
 * Week-over-week / month-over-month summary with two views:
 *  - Table: per-resource current value + WoW/MoM deltas (fed by the overview,
 *    no extra request).
 *  - Graph: each resource's weekly usage % as its own line over time (compute
 *    CPU %, subscription utilization %), fetched lazily when first opened.
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
          <p class="muted" style="margin:0 0 0.75rem">
            Weekly average usage % per resource · compute CPU &amp; subscription utilization
          </p>
          @if (linesLoaded && lines.length === 0) {
            <p class="muted">No percentage-based usage yet (compute or subscription resources).</p>
          } @else {
            <div class="chart-wrap" style="height:260px"><canvas #canvas></canvas></div>
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
  lines: WeeklyUsageResource[] = [];
  linesLoaded = false;

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
    if (view === 'graph') this.loadLines();
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

  private loadLines(): void {
    this.api.weeklyUsage(12).subscribe((resources) => {
      this.lines = resources;
      this.linesLoaded = true;
      this.renderChart();
    });
  }

  private buildChart(): void {
    if (!this.canvasRef) return;
    this.chart?.destroy();
    const cfg: ChartConfiguration = {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        // Hovering a week shows every resource's value at that week for comparison.
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Week', color: '#93a1b8' },
            ticks: {
              color: '#93a1b8',
              maxRotation: 0,
              autoSkipPadding: 16,
              callback: (v) =>
                new Date(Number(v)).toLocaleDateString([], { month: 'short', day: 'numeric' }),
            },
            grid: { color: '#22304a' },
          },
          y: {
            min: 0,
            max: 100,
            title: { display: true, text: 'Usage %', color: '#93a1b8' },
            ticks: { color: '#93a1b8', callback: (v) => v + '%' },
            grid: { color: '#22304a' },
          },
        },
        plugins: {
          legend: { labels: { color: '#e6ecf5', boxWidth: 12, usePointStyle: true } },
          tooltip: {
            callbacks: {
              title: (items) =>
                items.length
                  ? 'Week of ' +
                    new Date(Number(items[0].parsed.x)).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                    })
                  : '',
              label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)}%`,
            },
          },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  private renderChart(): void {
    if (!this.chart) return;
    // One line per resource, colored in a fixed order so a resource keeps its
    // color regardless of how many others are present.
    this.chart.data.datasets = this.lines.map((r, i) => {
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      return {
        label: r.name,
        data: r.points.map((p) => ({ x: new Date(p.week_start).getTime(), y: p.pct })),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0.25,
        spanGaps: true,
      } as any;
    });
    this.chart.update('none');
  }
}
