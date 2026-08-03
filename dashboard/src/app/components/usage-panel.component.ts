import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { ApiService } from '../services/api.service';
import { Resource, UsagePoint } from '../models';

Chart.register(...registerables);

interface Gauge {
  window_kind: string;
  utilization: number;
  resets_at: string | null;
  timestamp: string;
}

const KNOWN_LABELS: Record<string, string> = {
  seven_day: 'Weekly (all models)',
  five_hour: '5-hour session',
  extra_spend: 'Extra usage spend',
};

// Display order: the weekly gauge is the headline.
const KIND_ORDER = ['seven_day', 'five_hour', 'extra_spend'];

type RangeKey = 'week' | 'month' | 'year';

// Chart time ranges. `bucket` set → the server averages the sparse ~15 min
// gauge samples into per-day (month) or per-week (year) points so the wide
// views stay readable; the 7d view plots the raw samples directly.
const RANGES: { key: RangeKey; label: string; ms: number; bucket?: 'day' | 'week' }[] = [
  { key: 'week', label: '7d', ms: 7 * 86_400_000 },
  { key: 'month', label: 'Month', ms: 30 * 86_400_000, bucket: 'day' },
  { key: 'year', label: 'Year', ms: 365 * 86_400_000, bucket: 'week' },
];

@Component({
  selector: 'app-usage-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (gauges.length === 0) {
      <p class="muted">No usage samples yet. Install the Claude usage extension and point it here.</p>
    }

    <div class="gauges">
      @for (g of visibleGauges; track g.window_kind) {
        <div class="gauge" [class.headline]="g.window_kind === 'seven_day'">
          <div class="k">{{ label(g.window_kind) }}</div>
          <div class="v" [class]="severity(g.utilization)">{{ g.utilization.toFixed(0) }}%</div>
          <div class="gauge-bar">
            <div [style.width.%]="clamp(g.utilization)" [class]="severity(g.utilization)"></div>
            @if (g.window_kind === 'seven_day' && weekElapsedPct !== null) {
              <div class="pace-mark" [style.left.%]="weekElapsedPct" title="Where you'd be if pacing evenly"></div>
            }
          </div>
          <div class="muted">
            resets in {{ resetIn(g.resets_at) }}
            @if (g.window_kind === 'seven_day' && weekElapsedPct !== null) {
              · week {{ weekElapsedPct.toFixed(0) }}% elapsed
              @if (g.utilization < weekElapsedPct - 10) {
                <span class="under">— under-using your allowance</span>
              }
            }
          </div>
        </div>
      }
    </div>

    @if (!compact) {
      <div class="range-bar" style="margin-top:1.25rem">
        @for (r of ranges; track r.key) {
          <button [class.active]="r.key === rangeKey" (click)="setRange(r.key)">{{ r.label }}</button>
        }
      </div>
      <h4 class="muted" style="margin:0 0 0.25rem">{{ chartTitle }}</h4>
    }
    <div class="chart-wrap" [class.compact]="compact" [style.height.px]="compact ? 120 : 200">
      <canvas #canvas></canvas>
    </div>
  `,
})
export class UsagePanelComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) resource!: Resource;
  // Mini mode for the overview: shows only the headline weekly gauge + trend.
  @Input() compact = false;
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private api = inject(ApiService);
  private chart?: Chart;
  private sub?: Subscription;

  gauges: Gauge[] = [];
  weekElapsedPct: number | null = null;
  ranges = RANGES;
  rangeKey: RangeKey = 'week';
  private points: UsagePoint[] = [];
  // The seven_day utilization series currently plotted; `max` carries the
  // per-bucket peak for the tooltip in the month/year (bucketed) views.
  private chartData: { x: number; y: number | null; max?: number }[] = [];

  // In compact mode only the headline weekly gauge is shown.
  get visibleGauges(): Gauge[] {
    return this.compact ? this.gauges.filter((g) => g.window_kind === 'seven_day') : this.gauges;
  }

  // Aggregation bucket for the current range (undefined = raw 7d samples).
  get chartBucket(): 'day' | 'week' | undefined {
    return this.ranges.find((r) => r.key === this.rangeKey)?.bucket;
  }

  get chartTitle(): string {
    if (this.rangeKey === 'month') return 'Utilization by day — last 30 days';
    if (this.rangeKey === 'year') return 'Utilization by week — last 12 months';
    return 'Weekly utilization trend — last 7 days';
  }

  ngOnInit(): void {
    // Refresh every minute; the collector samples every ~15 min. This poll keeps
    // the gauges (always the latest 7 days of raw samples) live regardless of the
    // chart's selected range.
    this.sub = interval(60_000)
      .pipe(
        startWith(0),
        switchMap(() => {
          const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
          return this.api.usageMetrics(this.resource.id, from);
        })
      )
      .subscribe((points) => {
        this.points = points;
        this.computeGauges();
        this.loadChart();
      });
  }

  ngAfterViewInit(): void {
    this.buildChart();
    this.loadChart();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.chart?.destroy();
  }

  setRange(key: RangeKey): void {
    if (key === this.rangeKey) return;
    this.rangeKey = key;
    this.loadChart();
  }

  // Populate chartData for the selected range, then render. The 7d view reuses
  // the raw samples already fetched for the gauges; the month/year views ask the
  // server for per-day / per-week averages so wide ranges stay light + readable.
  private loadChart(): void {
    const range = this.ranges.find((r) => r.key === this.rangeKey)!;
    if (!range.bucket) {
      this.chartData = this.points
        .filter((p) => p.window_kind === 'seven_day')
        .map((p) => ({ x: new Date(p.timestamp).getTime(), y: Number(p.utilization) }));
      this.render();
      return;
    }
    const from = new Date(Date.now() - range.ms).toISOString();
    this.api.usageBucketed(this.resource.id, range.bucket, from).subscribe((points) => {
      this.chartData = points
        .filter((p) => p.window_kind === 'seven_day')
        .map((p) => ({
          x: new Date(p.timestamp).getTime(),
          y: p.utilization_avg,
          max: p.utilization_max,
        }));
      this.render();
    });
  }

  label(kind: string): string {
    return KNOWN_LABELS[kind] ?? kind.replace(/_/g, ' ');
  }

  clamp(v: number): number {
    return Math.max(0, Math.min(100, v));
  }

  severity(pct: number): string {
    if (pct >= 90) return 'crit';
    if (pct >= 70) return 'warn';
    return 'ok';
  }

  resetIn(iso: string | null): string {
    if (!iso) return '—';
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return 'now';
    const h = Math.floor(ms / 3_600_000);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h`;
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${h}h ${m}m`;
  }

  private computeGauges(): void {
    // Latest sample per window.
    const latest = new Map<string, UsagePoint>();
    for (const p of this.points) latest.set(p.window_kind, p); // points are time-ascending
    this.gauges = [...latest.values()]
      .map((p) => ({
        window_kind: p.window_kind,
        utilization: Number(p.utilization),
        resets_at: p.resets_at,
        timestamp: p.timestamp,
      }))
      .sort((a, b) => {
        const ai = KIND_ORDER.indexOf(a.window_kind);
        const bi = KIND_ORDER.indexOf(b.window_kind);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

    // Pacing: how far through the 7-day window are we?
    const weekly = latest.get('seven_day');
    if (weekly?.resets_at) {
      const resets = new Date(weekly.resets_at).getTime();
      const start = resets - 7 * 86_400_000;
      this.weekElapsedPct = Math.max(0, Math.min(100, ((Date.now() - start) / (7 * 86_400_000)) * 100));
    } else {
      this.weekElapsedPct = null;
    }
  }

  private buildChart(): void {
    const cfg: ChartConfiguration = {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Weekly %',
            data: [],
            borderColor: '#4f8cff',
            backgroundColor: 'rgba(79,140,255,0.15)',
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.25,
            fill: true,
            spanGaps: true, // gauge trend: sparse samples are fine to connect
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        scales: {
          x: {
            type: 'linear',
            ticks: {
              color: '#93a1b8',
              maxRotation: 0,
              autoSkipPadding: 20,
              callback: (v) => {
                const d = new Date(Number(v));
                // Day/week buckets span calendar dates; show the date instead of
                // a meaningless time. The 7d view keeps weekday + hour.
                return this.chartBucket
                  ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                  : d.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
              },
            },
            grid: { color: '#22304a' },
          },
          y: {
            min: 0,
            max: 100,
            ticks: { color: '#93a1b8', callback: (v) => v + '%' },
            grid: { color: '#22304a' },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const d = new Date(Number(items[0].parsed.x));
                if (this.chartBucket === 'week')
                  return 'Week of ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                if (this.chartBucket === 'day')
                  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
                return d.toLocaleString();
              },
              label: (ctx) => {
                const max = (ctx.raw as { max?: number })?.max;
                // Bucketed views plot the average; surface the peak alongside it.
                return this.chartBucket && max != null
                  ? `Avg ${ctx.parsed.y?.toFixed(1)}% · peak ${max.toFixed(0)}%`
                  : `Weekly: ${ctx.parsed.y?.toFixed(1)}%`;
              },
            },
          },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  private render(): void {
    if (!this.chart) return;
    // Bucketed views are sparse (≤31 days / ≤52 weeks), so show markers to make
    // each point legible; the dense raw 7d series stays a smooth line.
    (this.chart.data.datasets[0] as any).pointRadius = this.chartBucket ? 3 : 0;
    this.chart.data.datasets[0].data = this.chartData as any;
    this.chart.update('none');
  }
}
