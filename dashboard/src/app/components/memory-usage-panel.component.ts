import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { WeeklyUsageResource } from '../models';
import { ApiService } from '../services/api.service';

Chart.register(...registerables);

// Per-machine line colors: the same fixed dark-surface categorical steps used by
// the Usage-trends graph, so a machine reads consistently across both charts.
const SERIES_COLORS = [
  '#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926',
];

/**
 * Cross-machine RAM utilization: each compute machine's weekly RAM% (used memory
 * as a percentage of its total usable RAM) as its own line over time, overlaid on
 * a shared week (x) vs RAM-% (y) chart. Machines that haven't reported their total
 * RAM yet are omitted server-side (no denominator for a percentage).
 */
@Component({
  selector: 'app-memory-usage-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="card analytics">
      <div class="analytics-head">
        <h3 style="margin:0">RAM utilization</h3>
        <span class="muted">weekly average · % of total RAM · by machine</span>
      </div>

      @if (linesLoaded && lines.length === 0) {
        <p class="muted">
          No RAM data yet. Machines report their total RAM once an updated agent checks in.
        </p>
      } @else {
        <div class="chart-wrap main-chart"><canvas #canvas></canvas></div>
      }
    </div>
  `,
})
export class MemoryUsagePanelComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private chart?: Chart;
  private canvasRef?: ElementRef<HTMLCanvasElement>;

  lines: WeeklyUsageResource[] = [];
  linesLoaded = false;

  // The canvas is absent only in the empty state (behind @if); build the chart
  // when it appears and tear it down when it's removed.
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

  ngOnInit(): void {
    this.api.memoryUsage(12).subscribe((resources) => {
      this.lines = resources;
      this.linesLoaded = true;
      this.renderChart();
    });
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
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
        // Hovering a week shows every machine's RAM% at that week for comparison.
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
            title: { display: true, text: 'RAM %', color: '#93a1b8' },
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
    // One line per machine, colored in a fixed order so a machine keeps its color
    // regardless of how many others are present.
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
