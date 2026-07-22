import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { ApiService } from '../services/api.service';
import { WsService } from '../services/ws.service';
import { Resource } from '../models';
import { formatBytes, withGaps } from '../util';

type Bucket = 'hour' | 'day' | undefined;

Chart.register(...registerables);

interface Row {
  timestamp: string;
  cpu_percent: number | null;
  memory_bytes: number | null;
}

// `bucket` set → the server averages samples into per-hour/per-day points so
// wide views stay readable instead of cramming thousands of raw 15s samples.
const RANGES: { label: string; ms: number; bucket?: 'hour' | 'day' }[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '6h', ms: 6 * 60 * 60_000 },
  { label: '24h', ms: 24 * 60 * 60_000, bucket: 'hour' },
  { label: '7d', ms: 7 * 24 * 60 * 60_000, bucket: 'day' },
];

@Component({
  selector: 'app-compute-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (!compact) {
      <div class="range-bar">
        @for (r of ranges; track r.label) {
          <button [class.active]="r.ms === rangeMs" (click)="setRange(r.ms)">{{ r.label }}</button>
        }
        <span class="badge" style="margin-left:auto"
          [class.online]="resource.online" [class.offline]="!resource.online">
          <span class="dot"></span>{{ resource.online ? 'live' : 'offline' }}
        </span>
      </div>
    }
    <div class="chart-wrap" [class.compact]="compact"><canvas #canvas></canvas></div>
    @if (!compact) {
      <p class="muted">{{ caption }}</p>
    }
  `,
})
export class ComputeChartComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input({ required: true }) resource!: Resource;
  // Mini mode for the overview: hides the range bar/caption and shrinks the chart.
  @Input() compact = false;
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private api = inject(ApiService);
  private ws = inject(WsService);
  private chart?: Chart;
  private wsSub?: Subscription;
  private rows: Row[] = [];

  ranges = RANGES;
  rangeMs = RANGES[1].ms; // default 1h

  // Aggregation bucket for the current range (undefined = raw samples).
  get bucket(): Bucket {
    return this.ranges.find((r) => r.ms === this.rangeMs)?.bucket;
  }

  get caption(): string {
    if (this.bucket === 'hour')
      return 'Each point is a 1-hour average. Breaks are periods with no data (machine asleep/offline).';
    if (this.bucket === 'day')
      return 'Each point is a 1-day average. Breaks are periods with no data (machine asleep/offline).';
    return 'Breaks in the line are periods with no data (machine asleep/offline).';
  }

  ngAfterViewInit(): void {
    this.buildChart();
    this.loadHistory();
    this.subscribeLive();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['resource'] && !changes['resource'].firstChange) {
      this.resubscribe();
      this.loadHistory();
    }
  }

  ngOnDestroy(): void {
    this.wsSub?.unsubscribe();
    this.chart?.destroy();
  }

  setRange(ms: number): void {
    this.rangeMs = ms;
    this.loadHistory();
  }

  private buildChart(): void {
    const cfg: ChartConfiguration = {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'CPU %',
            yAxisID: 'yCpu',
            data: [],
            borderColor: '#4f8cff',
            backgroundColor: 'rgba(79,140,255,0.15)',
            spanGaps: false, // render null points as gaps (offline/asleep)
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.25,
            fill: true,
          },
          {
            label: 'Memory',
            yAxisID: 'yMem',
            data: [],
            borderColor: '#3ddc84',
            spanGaps: false,
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            ticks: {
              color: '#93a1b8',
              maxRotation: 0,
              autoSkipPadding: 20,
              callback: (v) => {
                const d = new Date(Number(v));
                // Day buckets span calendar dates; show the date instead of a
                // meaningless 00:00 time on every tick.
                return this.bucket === 'day'
                  ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                  : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              },
            },
            grid: { color: '#22304a' },
          },
          yCpu: {
            position: 'left', min: 0, max: 100,
            title: { display: true, text: 'CPU %', color: '#93a1b8' },
            ticks: { color: '#93a1b8' }, grid: { color: '#22304a' },
          },
          yMem: {
            position: 'right', min: 0,
            title: { display: true, text: 'Memory', color: '#93a1b8' },
            ticks: { color: '#93a1b8', callback: (v) => formatBytes(Number(v)) },
            grid: { drawOnChartArea: false },
          },
        },
        plugins: {
          legend: { labels: { color: '#e6ecf5' } },
          tooltip: {
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const d = new Date(Number(items[0].parsed.x));
                return this.bucket === 'day'
                  ? d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
                  : d.toLocaleString();
              },
              label: (ctx) => {
                const avg = this.bucket ? 'Avg ' : '';
                return ctx.dataset.label === 'Memory'
                  ? `${avg}Memory: ${formatBytes(ctx.parsed.y)}`
                  : `${avg}CPU: ${ctx.parsed.y?.toFixed(1)}%`;
              },
            },
          },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  private loadHistory(): void {
    const from = new Date(Date.now() - this.rangeMs).toISOString();
    const bucket = this.bucket;
    if (bucket) {
      // Wide view: let the server average samples into per-hour/per-day points.
      this.api.computeBucketed(this.resource.id, bucket, from).subscribe((points) => {
        this.rows = points.map((p) => ({
          timestamp: p.timestamp,
          cpu_percent: p.cpu_percent_avg,
          memory_bytes: p.memory_bytes_avg == null ? null : Number(p.memory_bytes_avg),
        }));
        this.render();
      });
    } else {
      this.api.computeMetrics(this.resource.id, from).subscribe((points) => {
        this.rows = points;
        this.render();
      });
    }
  }

  private subscribeLive(): void {
    this.wsSub = this.ws.compute(this.resource.id).subscribe((msg) => {
      // Bucketed (24h/7d) views show server-side averages; a single raw live
      // sample doesn't belong on that series, so skip it. The next range reload
      // picks up new data.
      if (this.bucket) return;
      this.rows.push({
        timestamp: msg.timestamp,
        cpu_percent: msg.cpu_percent,
        memory_bytes: msg.memory_bytes,
      });
      // Keep only what's in range.
      const cutoff = Date.now() - this.rangeMs;
      this.rows = this.rows.filter((r) => new Date(r.timestamp).getTime() >= cutoff);
      this.render();
    });
  }

  private resubscribe(): void {
    this.wsSub?.unsubscribe();
    this.subscribeLive();
  }

  private render(): void {
    if (!this.chart) return;
    // Gap threshold marks a break in the line where data is missing. For raw
    // series that's 3× the reporting interval; for bucketed series it's 1.5×
    // the bucket size (a whole missing hour/day).
    const gapMs =
      this.bucket === 'day'
        ? 1.5 * 24 * 3_600_000
        : this.bucket === 'hour'
          ? 1.5 * 3_600_000
          : this.resource.interval_seconds * 3 * 1000;
    // Averaged views are sparse (≤24 or ≤7 points), so show markers to make
    // each datapoint legible; raw views stay as a smooth line.
    const pointRadius = this.bucket ? 3 : 0;
    const gapped = withGaps<Row>(this.rows, gapMs, (iso) => ({
      timestamp: iso,
      cpu_percent: null,
      memory_bytes: null,
    }));
    (this.chart.data.datasets[0] as any).pointRadius = pointRadius;
    (this.chart.data.datasets[1] as any).pointRadius = pointRadius;
    this.chart.data.datasets[0].data = gapped.map((r) => ({
      x: new Date(r.timestamp).getTime(),
      y: r.cpu_percent,
    })) as any;
    this.chart.data.datasets[1].data = gapped.map((r) => ({
      x: new Date(r.timestamp).getTime(),
      y: r.memory_bytes,
    })) as any;
    this.chart.update('none');
  }
}
