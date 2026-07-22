import { Component, ElementRef, Input, OnDestroy, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { AnalyticsResource, UsageWeekSeries } from '../models';
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

// Categorical hues (dark-surface steps, validated for #182234 — CVD ≥ 10.3 in
// the floor band, paired with the always-present legend). The most recent week
// takes slot 0 (the dashboard accent) and is drawn boldest.
const WEEK_COLORS = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767'];

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
          <p class="muted" style="margin:0 0 0.75rem">
            Weekly usage %, each week overlaid by days since its reset
          </p>
          @if (weeklyLoaded && weekly.length === 0) {
            <p class="muted">No subscription usage samples yet. Install the Claude usage extension and point it here.</p>
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
  weekly: UsageWeekSeries[] = [];
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
    this.api.usageWeekly(6).subscribe((weeks) => {
      this.weekly = weeks;
      this.weeklyLoaded = true;
      this.renderChart();
    });
  }

  // Legend label for a cycle: "This week" for the newest, else its start date.
  private weekLabel(w: UsageWeekSeries, isLatest: boolean): string {
    if (isLatest) return 'This week';
    return 'Week of ' + new Date(w.cycle_start).toLocaleDateString([], { month: 'short', day: 'numeric' });
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
        interaction: { mode: 'nearest', intersect: false },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: 7,
            title: { display: true, text: 'Days since weekly reset', color: '#93a1b8' },
            ticks: { color: '#93a1b8', stepSize: 1, callback: (v) => 'day ' + v },
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
          legend: { reverse: true, labels: { color: '#e6ecf5', boxWidth: 12, usePointStyle: true } },
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? `Day ${Number(items[0].parsed.x).toFixed(1)} since reset` : ''),
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
    const lastIdx = this.weekly.length - 1;
    // One overlaid line per weekly cycle. Recency drives emphasis: newest is
    // slot 0 (accent) and boldest; older weeks step through the palette, thinner.
    this.chart.data.datasets = this.weekly.map((w, i) => {
      const recency = lastIdx - i; // 0 = newest
      const isLatest = recency === 0;
      const color = WEEK_COLORS[recency % WEEK_COLORS.length];
      return {
        label: this.weekLabel(w, isLatest),
        data: w.points.map((p) => ({ x: p.t, y: p.u })),
        borderColor: color,
        backgroundColor: color,
        borderWidth: isLatest ? 2.5 : 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.25,
        spanGaps: true,
        order: i, // higher order draws later; newest (largest i) sits on top
      } as any;
    });
    this.chart.update('none');
  }
}
