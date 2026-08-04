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
import { CalendarCategory, CalendarTier, Resource, TimePoint } from '../models';

Chart.register(...registerables);

type RangeKey = 'week' | 'month' | 'year';
const RANGES: { key: RangeKey; label: string; days: number; bucket: 'day' | 'week' }[] = [
  { key: 'week', label: '7d', days: 7, bucket: 'day' },
  { key: 'month', label: 'Month', days: 30, bucket: 'day' },
  { key: 'year', label: 'Year', days: 365, bucket: 'week' },
];

// Categorical hues (dataviz dark slots 1–8, validated CVD-safe in stack order on
// this dark surface). Color follows the domain's identity/config order, never
// its tier. An improbable 9th+ category folds to a neutral gray rather than a
// cycled hue.
const DOMAIN_HUES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OVERFLOW_HUE = '#898781';

// Tier = a good/neutral/bad quality state, so it uses the dashboard's status
// colors (always shown with a text label, never color alone).
const TIER_COLOR: Record<CalendarTier, string> = {
  productive: '#3ddc84', // --online
  neutral: '#93a1b8', // --muted
  waste: '#ff5c6c', // --offline
};
const TIER_LABEL: Record<CalendarTier, string> = {
  productive: 'Productive',
  neutral: 'Neutral',
  waste: 'Low-value',
};
const TIER_ORDER: CalendarTier[] = ['productive', 'neutral', 'waste'];

const GRID = '#22304a';
const INK = '#93a1b8';
const SURFACE = '#0f1420';
const DAY_MS = 86_400_000;

interface DomainStat {
  category: string;
  tier: CalendarTier;
  color: string;
  hours7: number;
  wowPct: number | null; // last 7d vs previous 7d
  momPct: number | null; // last 30d vs previous 30d
  streak: number; // longest consecutive-day run with any time, last 60d
}

@Component({
  selector: 'app-calendar-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (empty) {
      <p class="muted">
        No calendar time logged yet. Configure the calendar worker (see
        server/config/calendars.json) and run the backfill.
      </p>
    }

    <!-- Headline stats: rolling last-7d context + a 60d streak. -->
    <div class="gauges" [class.compact-gauges]="compact">
      <div class="gauge">
        <div class="k">Tracked · 7d</div>
        <div class="v">{{ fmtH(tracked7) }}</div>
        <div class="muted">{{ fmtH(tracked7 / 7) }} / day avg</div>
      </div>
      <div class="gauge">
        <div class="k">Productive · 7d</div>
        <div class="v" [style.color]="TIER_COLOR.productive">
          {{ productiveShare7 == null ? '—' : (productiveShare7 | number: '1.0-0') + '%' }}
        </div>
        <div class="muted">of tracked time</div>
      </div>
      @if (!compact) {
        <div class="gauge">
          <div class="k">Switches · 7d</div>
          <div class="v">{{ avgSwitches7 | number: '1.0-1' }}</div>
          <div class="muted">domain changes / day</div>
        </div>
        <div class="gauge">
          <div class="k">Best streak</div>
          <div class="v">{{ bestStreak }}{{ bestStreak === 1 ? ' day' : ' days' }}</div>
          <div class="muted">consecutive productive days</div>
        </div>
      }
    </div>

    @if (!compact) {
      <div class="range-bar" style="margin-top:1rem">
        @for (r of ranges; track r.key) {
          <button [class.active]="r.key === rangeKey" (click)="setRange(r.key)">{{ r.label }}</button>
        }
      </div>
      <h4 class="muted" style="margin:0 0 0.35rem">{{ chartTitle }}</h4>
    }
    <div class="chart-wrap" [class.compact]="compact" [style.height.px]="compact ? 130 : 300">
      <canvas #canvas></canvas>
    </div>

    @if (!compact && qmix.total > 0) {
      <h4 class="analytics-subhead">Quality mix · last 30 days</h4>
      <div class="qmix">
        @for (t of tierOrder; track t) {
          @if (qmix[t] > 0) {
            <div
              class="qseg"
              [style.width.%]="(qmix[t] / qmix.total) * 100"
              [style.background]="TIER_COLOR[t]"
              [title]="TIER_LABEL[t] + ' ' + fmtH(qmix[t] / 60)"
            ></div>
          }
        }
      </div>
      <div class="qmix-legend">
        @for (t of tierOrder; track t) {
          <span class="qmix-key">
            <span class="swatch" [style.background]="TIER_COLOR[t]"></span>
            {{ TIER_LABEL[t] }} {{ ((qmix[t] / qmix.total) * 100) | number: '1.0-0' }}%
          </span>
        }
      </div>

      <h4 class="analytics-subhead">By domain · last 7 days</h4>
      <div class="time-table">
        <div class="time-row head">
          <span>Domain</span><span class="value">7d</span><span class="value">WoW</span>
          <span class="value">MoM</span><span class="value">Streak</span>
        </div>
        @for (d of domainStats; track d.category) {
          <div class="time-row">
            <span class="name"><span class="swatch" [style.background]="d.color"></span>{{ d.category }}</span>
            <span class="value">{{ fmtH(d.hours7) }}</span>
            <span class="value delta" [class]="deltaClass(d.wowPct, d.tier)">{{ fmtDelta(d.wowPct) }}</span>
            <span class="value delta" [class]="deltaClass(d.momPct, d.tier)">{{ fmtDelta(d.momPct) }}</span>
            <span class="value">{{ d.streak }}d</span>
          </div>
        }
      </div>
    }
  `,
})
export class CalendarPanelComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) resource!: Resource;
  @Input() compact = false;
  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private api = inject(ApiService);
  private chart?: Chart;
  private sub?: Subscription;

  // expose to template
  readonly TIER_COLOR = TIER_COLOR;
  readonly TIER_LABEL = TIER_LABEL;
  readonly tierOrder = TIER_ORDER;
  ranges = RANGES;
  rangeKey: RangeKey = 'week';

  empty = false;
  tracked7 = 0;
  productiveShare7: number | null = null;
  avgSwitches7 = 0;
  bestStreak = 0;
  qmix: Record<CalendarTier, number> & { total: number } = { productive: 0, neutral: 0, waste: 0, total: 0 };
  domainStats: DomainStat[] = [];

  get chartTitle(): string {
    if (this.rangeKey === 'month') return 'Hours by domain — last 30 days';
    if (this.rangeKey === 'year') return 'Hours by domain — per week, last 12 months';
    return 'Hours by domain — last 7 days';
  }

  ngOnInit(): void {
    // Aggregates change slowly; refresh each minute like the other pull panels.
    this.sub = interval(60_000)
      .pipe(
        startWith(0),
        switchMap(() => {
          const from = new Date(Date.now() - 60 * DAY_MS).toISOString();
          return this.api.timeMetrics(this.resource.id, from);
        })
      )
      .subscribe((resp) => {
        this.computeStats(resp.points, resp.categories);
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

  fmtH(h: number): string {
    if (!isFinite(h) || h <= 0) return '0h';
    if (h < 1) return `${Math.round(h * 60)}m`;
    return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  }

  fmtDelta(pct: number | null): string {
    if (pct == null) return '—';
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '·';
    return `${arrow} ${Math.abs(pct).toFixed(0)}%`;
  }

  // Green when the change is an improvement — for waste that means going DOWN,
  // otherwise going up. Keeps the dashboard's utilization-positive feel while
  // staying honest about low-value time.
  deltaClass(pct: number | null, tier: CalendarTier): string {
    if (pct == null || pct === 0) return 'none';
    const improving = tier === 'waste' ? pct < 0 : pct > 0;
    return improving ? 'up' : 'down';
  }

  // --- 60-day rolling stats (independent of the chart's range selector) ------
  private computeStats(rawPoints: TimePoint[], categories: CalendarCategory[]): void {
    // Normalize `day` to a bare YYYY-MM-DD regardless of how the server encodes
    // it (plain string, or an ISO timestamp from a DATE column), so day-key
    // comparisons (streaks, windows) line up.
    const points = rawPoints.map((p) => ({ ...p, day: p.day.slice(0, 10) }));
    this.empty = points.length === 0;
    const order = categories.length ? categories : this.derivedCategories(points);
    const tierOf = new Map(order.map((c) => [c.category, c.tier]));
    const colorOf = (cat: string) => {
      const i = order.findIndex((c) => c.category === cat);
      return i < 0 ? OVERFLOW_HUE : DOMAIN_HUES[i] ?? OVERFLOW_HUE;
    };

    const now = Date.now();
    const at = (offset: number) => now - offset * DAY_MS;
    const dayMs = (p: TimePoint) => new Date(`${p.day}T00:00:00`).getTime();
    const sumMin = (pred: (p: TimePoint) => boolean) =>
      points.reduce((s, p) => (pred(p) ? s + p.minutes : s), 0);
    const sumEv = (pred: (p: TimePoint) => boolean) =>
      points.reduce((s, p) => (pred(p) ? s + p.event_count : s), 0);

    const tracked7min = sumMin((p) => dayMs(p) > at(7));
    this.tracked7 = tracked7min / 60;
    const prod7min = sumMin((p) => dayMs(p) > at(7) && tierOf.get(p.category) === 'productive');
    this.productiveShare7 = tracked7min > 0 ? (prod7min / tracked7min) * 100 : null;
    this.avgSwitches7 = sumEv((p) => dayMs(p) > at(7)) / 7;

    // Quality mix over the last 30 days.
    const mix: Record<CalendarTier, number> & { total: number } = {
      productive: 0,
      neutral: 0,
      waste: 0,
      total: 0,
    };
    for (const p of points) {
      if (dayMs(p) <= at(30)) continue;
      const t = tierOf.get(p.category) ?? 'neutral';
      mix[t] += p.minutes;
      mix.total += p.minutes;
    }
    this.qmix = mix;

    // Per-day presence maps for streaks (over the full 60-day span).
    const productiveDay = new Set<string>();
    const domainDays = new Map<string, Set<string>>();
    for (const p of points) {
      if (p.minutes <= 0) continue;
      if (tierOf.get(p.category) === 'productive') productiveDay.add(p.day);
      let s = domainDays.get(p.category);
      if (!s) domainDays.set(p.category, (s = new Set()));
      s.add(p.day);
    }
    const spanDays: string[] = [];
    for (let d = 60; d >= 0; d--) spanDays.push(new Date(at(d)).toISOString().slice(0, 10));
    const longestRun = (has: Set<string>) => {
      let best = 0;
      let run = 0;
      for (const day of spanDays) {
        run = has.has(day) ? run + 1 : 0;
        if (run > best) best = run;
      }
      return best;
    };
    this.bestStreak = longestRun(productiveDay);

    // Per-domain table, in config order.
    this.domainStats = order.map((c) => {
      const cat = c.category;
      const cur7 = sumMin((p) => p.category === cat && dayMs(p) > at(7));
      const prev7 = sumMin((p) => p.category === cat && dayMs(p) > at(14) && dayMs(p) <= at(7));
      const cur30 = sumMin((p) => p.category === cat && dayMs(p) > at(30));
      const prev30 = sumMin((p) => p.category === cat && dayMs(p) > at(60) && dayMs(p) <= at(30));
      return {
        category: cat,
        tier: c.tier,
        color: colorOf(cat),
        hours7: cur7 / 60,
        wowPct: prev7 > 0 ? ((cur7 - prev7) / prev7) * 100 : null,
        momPct: prev30 > 0 ? ((cur30 - prev30) / prev30) * 100 : null,
        streak: longestRun(domainDays.get(cat) ?? new Set()),
      };
    });
  }

  // Fallback category order if the server sent none (e.g. calendars.json empty):
  // distinct categories in first-seen order, all treated as neutral.
  private derivedCategories(points: TimePoint[]): CalendarCategory[] {
    const seen: CalendarCategory[] = [];
    const set = new Set<string>();
    for (const p of points) {
      if (!set.has(p.category)) {
        set.add(p.category);
        seen.push({ category: p.category, tier: 'neutral' });
      }
    }
    return seen;
  }

  // --- Range-driven stacked chart -------------------------------------------
  private loadChart(): void {
    const range = this.ranges.find((r) => r.key === this.rangeKey)!;
    const from = new Date(Date.now() - range.days * DAY_MS).toISOString();
    this.api.timeBucketed(this.resource.id, range.bucket, from).subscribe((resp) => {
      const points = resp.points.map((p) => ({ ...p, day: p.day.slice(0, 10) }));
      const order = resp.categories.length ? resp.categories : this.derivedCategories(points);
      const days = [...new Set(points.map((p) => p.day))].sort();
      const dayIndex = new Map(days.map((d, i) => [d, i]));

      // minutes[category][dayIdx] and switches per bucket.
      const minutesBy = new Map<string, number[]>();
      const switches = new Array(days.length).fill(0);
      for (const c of order) minutesBy.set(c.category, new Array(days.length).fill(0));
      for (const p of points) {
        const di = dayIndex.get(p.day);
        if (di == null) continue;
        const arr = minutesBy.get(p.category);
        if (arr) arr[di] += p.minutes;
        switches[di] += p.event_count;
      }

      const isWeek = range.bucket === 'week';
      const labels = days.map((d) => {
        const dt = new Date(`${d}T00:00:00`);
        const s = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return isWeek ? `wk ${s}` : s;
      });
      const datasets = order.map((c, i) => ({
        label: c.category,
        data: (minutesBy.get(c.category) ?? []).map((m) => m / 60),
        backgroundColor: DOMAIN_HUES[i] ?? OVERFLOW_HUE,
        borderColor: SURFACE, // 1.5px surface gap between stacked segments
        borderWidth: 1.5,
        borderRadius: 2,
        stack: 'time',
      }));

      if (!this.chart) return;
      this.chart.data.labels = labels;
      this.chart.data.datasets = datasets as any;
      (this.chart as any)._switches = switches;
      this.chart.update('none');
    });
  }

  private buildChart(): void {
    const cfg: ChartConfiguration = {
      type: 'bar',
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          x: { stacked: true, ticks: { color: INK, maxRotation: 0, autoSkipPadding: 16 }, grid: { color: GRID } },
          y: {
            stacked: true,
            beginAtZero: true,
            ticks: { color: INK, callback: (v) => `${v}h` },
            grid: { color: GRID },
          },
        },
        plugins: {
          legend: {
            display: !this.compact,
            position: 'bottom',
            labels: { color: INK, boxWidth: 12, boxHeight: 12, padding: 10, font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              // Footer shows the bucket's domain-switch count (fragmentation) and total.
              footer: (items) => {
                if (!items.length) return '';
                const idx = items[0].dataIndex;
                const total = items.reduce((s, it) => s + (Number(it.parsed.y) || 0), 0);
                const sw = (this.chart as any)?._switches?.[idx] ?? 0;
                return `Total ${total.toFixed(1)}h · ${sw} switch${sw === 1 ? '' : 'es'}`;
              },
              label: (ctx) => {
                const h = Number(ctx.parsed.y) || 0;
                return h > 0 ? `${ctx.dataset.label}: ${h.toFixed(1)}h` : '';
              },
            },
          },
        },
      },
    };
    this.chart = new Chart(this.canvasRef.nativeElement, cfg);
  }
}
