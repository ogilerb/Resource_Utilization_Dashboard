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

Chart.register(...registerables);

interface Row {
  timestamp: string;
  cpu_percent: number | null;
  memory_bytes: number | null;
}

const RANGES: { label: string; ms: number }[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '6h', ms: 6 * 60 * 60_000 },
  { label: '24h', ms: 24 * 60 * 60_000 },
  { label: '7d', ms: 7 * 24 * 60 * 60_000 },
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
      <p class="muted">Breaks in the line are periods with no data (machine asleep/offline).</p>
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
              callback: (v) => new Date(Number(v)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
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
              title: (items) =>
                items.length ? new Date(Number(items[0].parsed.x)).toLocaleString() : '',
              label: (ctx) =>
                ctx.dataset.label === 'Memory'
                  ? `Memory: ${formatBytes(ctx.parsed.y)}`
                  : `CPU: ${ctx.parsed.y?.toFixed(1)}%`,
            },
          },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  private loadHistory(): void {
    const from = new Date(Date.now() - this.rangeMs).toISOString();
    this.api.computeMetrics(this.resource.id, from).subscribe((points) => {
      this.rows = points;
      this.render();
    });
  }

  private subscribeLive(): void {
    this.wsSub = this.ws.compute(this.resource.id).subscribe((msg) => {
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
    // Gap threshold: 3× the resource's reporting interval marks a break.
    const gapMs = this.resource.interval_seconds * 3 * 1000;
    const gapped = withGaps<Row>(this.rows, gapMs, (iso) => ({
      timestamp: iso,
      cpu_percent: null,
      memory_bytes: null,
    }));
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
