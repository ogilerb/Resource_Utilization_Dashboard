import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiService } from '../services/api.service';
import { RegisterResponse, ResourceType } from '../models';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  template: `
    <p><a routerLink="/">← Overview</a></p>
    <h2>Register Resource</h2>
    <p class="muted">
      Registering a resource mints an ingest API key and auto-renders a dashboard
      panel — no backend or frontend changes needed.
    </p>

    <div class="card" style="max-width:520px">
      <label>Name</label>
      <input [(ngModel)]="name" placeholder="e.g. MacBook Air, Claude API" />

      <label>Type</label>
      <select [(ngModel)]="type">
        <option value="compute">compute — a machine reporting CPU/RAM</option>
        <option value="api">api — an LLM/API usage + cost source</option>
        <option value="usage">usage — a subscription limit gauge (e.g. Claude Pro)</option>
      </select>

      @if (type === 'compute') {
        <label>Reporting interval (seconds)</label>
        <input type="number" [(ngModel)]="intervalSeconds" min="1" max="3600" />
      }

      <div style="margin-top:1rem">
        <button (click)="submit()" [disabled]="!name || loading">
          {{ loading ? 'Registering…' : 'Register' }}
        </button>
      </div>

      @if (error) { <p class="muted" style="color:var(--offline)">{{ error }}</p> }

      @if (result) {
        <div style="margin-top:1rem">
          <p><b>{{ result.resource.name }}</b> registered (id {{ result.resource.id }}).</p>
          <p class="muted">Copy this API key into the agent/extension config — it is shown only once:</p>
          <div class="key-box">{{ result.api_key }}</div>
          <div style="margin-top:0.75rem;display:flex;gap:0.5rem">
            <button class="secondary" (click)="copyKey()">Copy key</button>
            <a class="btn" [routerLink]="['/resource', result.resource.id]">Open panel</a>
          </div>
        </div>
      }
    </div>
  `,
})
export class RegisterComponent {
  private api = inject(ApiService);

  name = '';
  type: ResourceType = 'compute';
  intervalSeconds = 15;
  loading = false;
  error = '';
  result?: RegisterResponse;

  submit(): void {
    this.loading = true;
    this.error = '';
    this.result = undefined;
    this.api
      .registerResource({
        name: this.name.trim(),
        type: this.type,
        interval_seconds:
          this.type === 'compute'
            ? Number(this.intervalSeconds)
            : this.type === 'usage'
              ? 900 // usage collectors sample every ~15 min
              : undefined,
      })
      .subscribe({
        next: (r) => {
          this.result = r;
          this.loading = false;
          this.name = '';
        },
        error: (e) => {
          this.error = e.error?.error ?? e.message ?? 'Registration failed';
          this.loading = false;
        },
      });
  }

  copyKey(): void {
    if (this.result) void navigator.clipboard?.writeText(this.result.api_key);
  }
}
