import { readFileSync } from 'node:fs';
import { config } from '../config.js';

/**
 * The calendars.json config: one entry per Google calendar. `category` is the
 * life-domain name (1 calendar = 1 category); `tier` groups categories for the
 * Productive-vs-Waste metric. `color` is an optional hex the panel uses to match
 * the calendar's Google colour (fill it once via scripts/sync-calendar-colors.mjs;
 * omitted → the panel falls back to its own palette). Loaded from
 * GOOGLE_CALENDARS_FILE (gitignored; copy calendars.example.json). Placeholder
 * ("FILL_ME…") ids are ignored so an un-configured deploy simply yields an empty
 * list and disables the feature.
 */
export type CalendarTier = 'productive' | 'neutral' | 'waste';

export interface CalendarDef {
  id: string;
  category: string;
  tier: CalendarTier;
  color?: string; // hex, e.g. '#039be5' — the calendar's Google colour
}

let cache: CalendarDef[] | null = null;

export function loadCalendars(): CalendarDef[] {
  if (cache) return cache;
  if (!config.calendar.calendarsFile) {
    cache = [];
    return cache;
  }
  try {
    const raw = JSON.parse(readFileSync(config.calendar.calendarsFile, 'utf8')) as {
      calendars?: CalendarDef[];
    };
    cache = (raw.calendars ?? []).filter(
      (c) => c && c.id && !c.id.startsWith('FILL_ME') && c.category
    );
  } catch (err) {
    console.error(`[calendars] failed to read ${config.calendar.calendarsFile}:`, err);
    cache = [];
  }
  return cache;
}

/** Category names in the given tier (for the analytics productive/waste splits). */
export function categoriesInTier(tier: CalendarTier): string[] {
  return loadCalendars()
    .filter((c) => c.tier === tier)
    .map((c) => c.category);
}

/**
 * Config-order list of {category, tier, color?} — the frontend's stable stacking
 * order, plus each calendar's Google colour when configured.
 */
export function categoryTiers(): { category: string; tier: CalendarTier; color?: string }[] {
  return loadCalendars().map((c) => ({
    category: c.category,
    tier: c.tier,
    ...(c.color ? { color: c.color } : {}),
  }));
}
