import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { ApiService } from '../services/api.service';
import { Resource } from '../models';
import { relativeTime } from '../util';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <h2 style="margin:0">Resources</h2>
      <a class="btn" routerLink="/register">+ Register Resource</a>
    </div>

    @if (error) {
      <p class="muted">Couldn't reach the API: {{ error }}</p>
    }
    @if (!error && resources.length === 0) {
      <p class="muted">No resources yet. Register one to start collecting telemetry.</p>
    }

    <div class="grid">
      @for (r of resources; track r.id) {
        <a class="card" [routerLink]="['/resource', r.id]" style="color:inherit">
          <div style="display:flex;justify-content:space-between;align-items:start">
            <h3>{{ r.name }}</h3>
            <span class="badge" [class.online]="r.online" [class.offline]="!r.online">
              <span class="dot"></span>{{ r.online ? 'online' : 'offline' }}
            </span>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.25rem">
            <span class="type-pill">{{ r.type }}</span>
            <span class="muted">every {{ r.interval_seconds }}s</span>
          </div>
          <p class="muted" style="margin:0.75rem 0 0">
            Last seen: {{ relative(r.last_seen) }}
          </p>
        </a>
      }
    </div>
  `,
})
export class OverviewComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  resources: Resource[] = [];
  error = '';
  private sub?: Subscription;

  ngOnInit(): void {
    // Poll the list every 10s so online/offline badges stay fresh.
    this.sub = interval(10_000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.listResources())
      )
      .subscribe({
        next: (r) => {
          this.resources = r;
          this.error = '';
        },
        error: (e) => (this.error = e.message ?? 'unknown error'),
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  relative = relativeTime;
}
