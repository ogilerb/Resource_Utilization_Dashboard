import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="top">
      <h1>📡 Telemetry Dashboard</h1>
      <nav>
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">Overview</a>
        <a routerLink="/register" routerLinkActive="active">Register Resource</a>
      </nav>
    </header>
    <main class="container">
      <router-outlet />
    </main>
  `,
})
export class AppComponent {}
