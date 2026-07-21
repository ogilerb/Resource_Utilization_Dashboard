import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { ApiService } from '../services/api.service';
import { Resource } from '../models';
import { formatNumber } from '../util';

Chart.register(...registerables);

const RANGES: { label: string; days: number }[] = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

@Component({
  selector: 'app-api-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (!compact) {
      <div class="range-bar">
        @for (r of ranges; track r.days) {
          <button [class.active]="r.days === days" (click)="setRange(r.days)">{{ r.label }}</button>
        }
      </div>
    }
    <div class="kv" [class.compact]="compact">
      @if (!compact) {
        <div><span class="k">Tokens in</span><span class="v">{{ fmt(totals.in) }}</span></div>
        <div><span class="k">Tokens out</span><span class="v">{{ fmt(totals.out) }}</span></div>
      }
      <div><span class="k">Cost</span><span class="v">\${{ totals.cost.toFixed(2) }}</span></div>
    </div>
    <div class="chart-wrap" [class.compact]="compact"><canvas #canvas></canvas></div>
  `,
})
export class ApiChartComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) resource!: Resource;
  // Mini mode for the overview: hides the range bar and condenses the totals.
  @Input() compact = false;
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private api = inject(ApiService);
  private chart?: Chart;

  ranges = RANGES;
  days = 30;
  totals = { in: 0, out: 0, cost: 0 };
  fmt = formatNumber;

  ngAfterViewInit(): void {
    this.buildChart();
    this.load();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  setRange(days: number): void {
    this.days = days;
    this.load();
  }

  private buildChart(): void {
    const cfg: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'Tokens in', data: [], backgroundColor: '#4f8cff', yAxisID: 'yTok', stack: 'tokens' },
          { label: 'Tokens out', data: [], backgroundColor: '#3ddc84', yAxisID: 'yTok', stack: 'tokens' },
          { label: 'Cost (USD)', data: [], type: 'line', borderColor: '#ffb454', backgroundColor: '#ffb454', yAxisID: 'yCost', tension: 0.25 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, ticks: { color: '#93a1b8' }, grid: { color: '#22304a' } },
          yTok: {
            position: 'left', beginAtZero: true, stacked: true,
            title: { display: true, text: 'Tokens', color: '#93a1b8' },
            ticks: { color: '#93a1b8' }, grid: { color: '#22304a' },
          },
          yCost: {
            position: 'right', beginAtZero: true,
            title: { display: true, text: 'USD', color: '#93a1b8' },
            ticks: { color: '#93a1b8', callback: (v) => '$' + Number(v).toFixed(2) },
            grid: { drawOnChartArea: false },
          },
        },
        plugins: { legend: { labels: { color: '#e6ecf5' } } },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }

  private load(): void {
    const from = new Date(Date.now() - this.days * 86_400_000).toISOString();
    this.api.apiMetrics(this.resource.id, from).subscribe((points) => {
      if (!this.chart) return;
      this.chart.data.labels = points.map((p) => p.day);
      this.chart.data.datasets[0].data = points.map((p) => p.tokens_in);
      this.chart.data.datasets[1].data = points.map((p) => p.tokens_out);
      this.chart.data.datasets[2].data = points.map((p) => p.cost);
      this.chart.update();
      this.totals = {
        in: points.reduce((a, p) => a + p.tokens_in, 0),
        out: points.reduce((a, p) => a + p.tokens_out, 0),
        cost: points.reduce((a, p) => a + Number(p.cost), 0),
      };
    });
  }
}
