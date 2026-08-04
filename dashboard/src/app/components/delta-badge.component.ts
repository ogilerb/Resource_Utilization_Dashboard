import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PeriodDelta } from '../models';

/**
 * Compact period-over-period delta indicator (e.g. "▲12% wk").
 * Coloring convention (see styles.css .delta.up/.down): increase = green,
 * decrease = red — this is a utilization dashboard, so using MORE of a resource
 * than the previous period reads as "good".
 */
@Component({
  selector: 'app-delta-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (delta?.delta_pct == null) {
      <span class="delta none" [title]="tooltip">—{{ label ? ' ' + label : '' }}</span>
    } @else {
      <span
        class="delta"
        [class.down]="delta!.delta_pct! < 0"
        [class.up]="delta!.delta_pct! > 0"
        [title]="tooltip"
      >
        {{ delta!.delta_pct! < 0 ? '▼' : delta!.delta_pct! > 0 ? '▲' : '■' }}{{ abs(delta!.delta_pct!).toFixed(0) }}%{{ label ? ' ' + label : '' }}
      </span>
    }
  `,
})
export class DeltaBadgeComponent {
  @Input() delta: PeriodDelta | null | undefined;
  @Input() label = ''; // short period suffix, e.g. 'wk' / 'mo'
  @Input() tooltip = '';
  abs = Math.abs;
}
