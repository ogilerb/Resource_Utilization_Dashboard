import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDropList,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { ApiService } from '../services/api.service';
import { LayoutService } from '../services/layout.service';
import { AnalyticsResource, CardSpan, Resource } from '../models';
import { relativeTime } from '../util';
import { ComputeChartComponent } from './compute-chart.component';
import { ApiChartComponent } from './api-chart.component';
import { UsagePanelComponent } from './usage-panel.component';
import { AnalyticsPanelComponent } from './analytics-panel.component';
import { DeltaBadgeComponent } from './delta-badge.component';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    CdkDropList,
    CdkDrag,
    CdkDragHandle,
    ComputeChartComponent,
    ApiChartComponent,
    UsagePanelComponent,
    AnalyticsPanelComponent,
    DeltaBadgeComponent,
  ],
  template: `
    <div class="toolbar">
      <h2 style="margin:0">Resources</h2>
      <div class="toolbar-actions">
        <button class="secondary" (click)="editMode = !editMode">
          {{ editMode ? 'Done' : '⚙ Customize' }}
        </button>
        @if (editMode) {
          <button class="secondary" (click)="resetLayout()">Reset layout</button>
        }
        <a class="btn" routerLink="/register">+ Register Resource</a>
      </div>
    </div>

    @if (editMode) {
      <p class="muted" style="margin:0 0 1rem">
        Drag the ⠿ handle to reorder · use S/M/L to resize · changes are saved in this browser.
      </p>
    }

    @if (error) {
      <p class="muted">Couldn't reach the API: {{ error }}</p>
    }
    @if (!error && resources.length === 0) {
      <p class="muted">No resources yet. Register one to start collecting telemetry.</p>
    }

    <app-analytics-panel [analytics]="analyticsList" [names]="names" />

    <div
      class="board"
      [class.editing]="editMode"
      cdkDropList
      cdkDropListOrientation="mixed"
      (cdkDropListDropped)="drop($event)"
    >
      @for (r of resources; track r.id) {
        <div
          class="card board-card"
          [ngClass]="'span-' + layout.pref(r.id).span"
          [class.editing]="editMode"
          cdkDrag
          [cdkDragDisabled]="!editMode"
        >
          <div class="card-head">
            @if (editMode) {
              <span class="drag-handle" cdkDragHandle title="Drag to reorder">⠿</span>
            }
            <a class="card-title" [routerLink]="['/resource', r.id]">{{ r.name }}</a>
            <span class="type-pill">{{ r.type }}</span>
            <span class="badge" [class.online]="r.online" [class.offline]="!r.online">
              <span class="dot"></span>{{ r.online ? 'online' : 'offline' }}
            </span>
            <span class="spacer"></span>
            @if (analyticsFor(r.id); as a) {
              <app-delta-badge [delta]="a.week" label="wk" tooltip="vs previous 7 days" />
            }
            <button
              class="icon-btn"
              (click)="toggleExpanded(r.id)"
              [title]="layout.pref(r.id).expanded ? 'Collapse chart' : 'Expand chart'"
            >
              {{ layout.pref(r.id).expanded ? '▾' : '▸' }}
            </button>
          </div>

          @if (editMode) {
            <div class="size-bar">
              <span class="muted">size</span>
              @for (s of spans; track s) {
                <button [class.active]="layout.pref(r.id).span === s" (click)="setSpan(r.id, s)">
                  {{ sizeLabel(s) }}
                </button>
              }
            </div>
          }

          <div class="card-body">
            @switch (r.type) {
              @case ('compute') { <app-compute-chart [resource]="r" [compact]="!layout.pref(r.id).expanded" /> }
              @case ('api') { <app-api-chart [resource]="r" [compact]="!layout.pref(r.id).expanded" /> }
              @case ('usage') { <app-usage-panel [resource]="r" [compact]="!layout.pref(r.id).expanded" /> }
            }
          </div>

          <p class="muted card-foot">Last seen: {{ relative(r.last_seen) }}</p>
        </div>
      }
    </div>
  `,
})
export class OverviewComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  layout = inject(LayoutService);

  resources: Resource[] = [];
  analyticsList: AnalyticsResource[] = [];
  names: Record<number, string> = {};
  error = '';
  editMode = false;

  readonly spans: CardSpan[] = [1, 2, 3];
  relative = relativeTime;

  // Stable Resource objects keyed by id. We mutate these in place across polls
  // so each chart's [resource] input reference stays stable and it doesn't
  // reload history / resubscribe its WebSocket every 10s.
  private resById = new Map<number, Resource>();
  private analyticsById = new Map<number, AnalyticsResource>();
  private resSub?: Subscription;
  private analyticsSub?: Subscription;

  ngOnInit(): void {
    // Resource list + liveness every 10s.
    this.resSub = interval(10_000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.listResources())
      )
      .subscribe({
        next: (list) => {
          this.applyList(list);
          this.error = '';
        },
        error: (e) => (this.error = e.message ?? 'unknown error'),
      });

    // WoW/MoM analytics every 60s (aggregates change slowly). A failure here
    // must not break the board, so errors are swallowed.
    this.analyticsSub = interval(60_000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.analyticsSummary())
      )
      .subscribe({
        next: (s) => {
          this.analyticsList = s.resources;
          this.analyticsById = new Map(s.resources.map((a) => [a.resource_id, a]));
        },
        error: () => {},
      });
  }

  ngOnDestroy(): void {
    this.resSub?.unsubscribe();
    this.analyticsSub?.unsubscribe();
  }

  private applyList(list: Resource[]): void {
    const incoming = new Set(list.map((r) => r.id));
    for (const r of list) {
      const existing = this.resById.get(r.id);
      if (existing) Object.assign(existing, r);
      else this.resById.set(r.id, r);
    }
    for (const id of [...this.resById.keys()]) {
      if (!incoming.has(id)) this.resById.delete(id);
    }
    const stable = [...this.resById.values()];
    this.names = Object.fromEntries(stable.map((r) => [r.id, r.name]));
    // LayoutService returns the stable objects in saved display order.
    this.resources = this.layout.reconcile(stable);
  }

  analyticsFor(id: number): AnalyticsResource | undefined {
    return this.analyticsById.get(id);
  }

  toggleExpanded(id: number): void {
    this.layout.setExpanded(id, !this.layout.pref(id).expanded);
  }

  setSpan(id: number, span: CardSpan): void {
    this.layout.setSpan(id, span);
  }

  sizeLabel(span: CardSpan): string {
    return span === 1 ? 'S' : span === 2 ? 'M' : 'L';
  }

  resetLayout(): void {
    this.layout.reset();
    this.resources = this.layout.reconcile([...this.resById.values()]);
  }

  drop(event: CdkDragDrop<Resource[]>): void {
    moveItemInArray(this.resources, event.previousIndex, event.currentIndex);
    this.layout.setOrder(this.resources.map((r) => r.id));
  }
}
