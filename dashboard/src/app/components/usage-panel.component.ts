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

@Component({
  selector: 'app-usage-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (gauges.length === 0) {
      <p class="muted">No usage samples yet. Install the Claude usage extension and point it here.</p>
    }

    <div class="gauges">
      @for (g of gauges; track g.window_kind) {
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

    <h4 class="muted" style="margin:1.25rem 0 0.25rem">Weekly utilization trend</h4>
    <div class="chart-wrap" style="height:200px"><canvas #canvas></canvas></div>
  `,
})
export class UsagePanelComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) resource!: Resource;
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private api = inject(ApiService);
  private chart?: Chart;
  private sub?: Subscription;

  gauges: Gauge[] = [];
  weekElapsedPct: number | null = null;
  private points: UsagePoint[] = [];

  ngOnInit(): void {
    // Refresh every minute; the collector samples every ~15 min.
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
        this.render();
      });
  }

  ngAfterViewInit(): void {
    this.buildChart();
    this.render();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.chart?.destroy();
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
              callback: (v) =>
                new Date(Number(v)).toLocaleDateString([], { weekday: 'short', hour: '2-digit' }),
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
              title: (items) =>
                items.length ? new Date(Number(items[0].parsed.x)).toLocaleString() : '',
              label: (ctx) => `Weekly: ${ctx.parsed.y?.toFixed(1)}%`,
            },
          },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  private render(): void {
    if (!this.chart) return;
    this.chart.data.datasets[0].data = this.points
      .filter((p) => p.window_kind === 'seven_day')
      .map((p) => ({ x: new Date(p.timestamp).getTime(), y: Number(p.utilization) })) as any;
    this.chart.update('none');
  }
}
