import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { ApiService } from '../services/api.service';
import { Resource } from '../models';
import { relativeTime } from '../util';
import { ComputeChartComponent } from './compute-chart.component';
import { ApiChartComponent } from './api-chart.component';
import { UsagePanelComponent } from './usage-panel.component';

@Component({
  selector: 'app-resource-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, ComputeChartComponent, ApiChartComponent, UsagePanelComponent],
  template: `
    <p><a routerLink="/">← Overview</a></p>

    @if (resource) {
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="margin:0 0 0.25rem">{{ resource.name }}</h2>
          <span class="type-pill">{{ resource.type }}</span>
          <span class="muted" style="margin-left:0.5rem">Last seen {{ relative(resource.last_seen) }}</span>
        </div>
        <span class="badge" [class.online]="resource.online" [class.offline]="!resource.online">
          <span class="dot"></span>{{ resource.online ? 'online' : 'offline' }}
        </span>
      </div>

      <div class="card" style="margin-top:1rem">
        <!-- The visualization switches purely on resource.type — no hardcoding. -->
        @switch (resource.type) {
          @case ('compute') { <app-compute-chart [resource]="resource" /> }
          @case ('api') { <app-api-chart [resource]="resource" /> }
          @case ('usage') { <app-usage-panel [resource]="resource" /> }
        }
      </div>
    } @else if (error) {
      <p class="muted">{{ error }}</p>
    } @else {
      <p class="muted">Loading…</p>
    }
  `,
})
export class ResourceDetailComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);

  resource?: Resource;
  error = '';
  relative = relativeTime;
  private sub?: Subscription;

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    // Refresh the resource header (online/last_seen) periodically; the child
    // charts manage their own live/historical data.
    this.sub = interval(10_000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.listResources())
      )
      .subscribe({
        next: (list) => {
          const found = list.find((r) => r.id === id);
          if (!found) {
            this.error = `Resource ${id} not found`;
            return;
          }
          // Mutate in place so the child chart's @Input reference stays stable
          // (avoids resubscribing the WebSocket / reloading history every poll).
          if (this.resource) Object.assign(this.resource, found);
          else this.resource = found;
        },
        error: (e) => (this.error = e.message ?? 'error'),
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}
