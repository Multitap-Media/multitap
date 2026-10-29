/**
 * `selection/ranking-settings`: the operator's ranking settings (see
 * okf:concept/ranking-settings), behind `/v1/admin/ranking`.
 *
 * Only overrides are stored (`settings` row `ranking`), so a later release's
 * better defaults still reach every value nobody changed. They are loaded at
 * startup (or on first use), merged over {@link DEFAULT_RANKING_SETTINGS} and
 * cached in memory; each write replaces the cache and emits
 * `settings.changed`. A write is validated as a whole before anything is
 * stored. A value set back to its default is no longer an override.
 */
import {
  DEFAULT_RANKING_SETTINGS,
  RankingSettingsPatchSchema,
  RankingSettingsSchema,
  mergeRankingSettings,
  type RankingSettings,
  type RankingSettingsInput,
  type RankingSettingsPatch,
  type RankingSettingsView,
} from '@multitap/api';
import type { Clock } from '../auth/keys.ts';
import type { Db } from '../db/index.ts';
import type { EventBus } from '../events/bus.ts';
import type { Logger } from '../log.ts';

/** The `settings` key for ranking. */
export const RANKING_SETTINGS_KEY = 'ranking';

export interface RankingSettingsStoreDeps {
  db: Db;
  clock: Clock;
  logger?: Logger | undefined;
  /** Where `settings.changed` goes; none until the event bus exists. */
  events?: Pick<EventBus, 'publish'> | undefined;
}

/** A write that fails validation; nothing was stored. */
export class RankingSettingsError extends Error {
  override name = 'RankingSettingsError';
  readonly issues: { path: string; message: string }[];

  constructor(issues: { path: string; message: string }[]) {
    super('Invalid ranking settings.');
    this.issues = issues;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The parts of `value` that differ from `base`, as a nested partial (undefined when none). */
export function diffSettings(base: unknown, value: unknown): unknown {
  if (isObject(base) && isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const d = diffSettings(base[key], v);
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  // Lists (the safety patterns) are values: equal content is no override.
  if (Array.isArray(base) && Array.isArray(value)) {
    return JSON.stringify(base) === JSON.stringify(value) ? undefined : value;
  }
  return Object.is(base, value) ? undefined : value;
}

function validate(settings: RankingSettings): RankingSettings {
  const result = RankingSettingsSchema.safeParse(settings);
  if (!result.success) {
    throw new RankingSettingsError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export class RankingSettingsStore {
  readonly #deps: RankingSettingsStoreDeps;
  #overrides: RankingSettingsPatch = {};
  #effective: RankingSettings = DEFAULT_RANKING_SETTINGS;
  #loading: Promise<void> | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(deps: RankingSettingsStoreDeps) {
    this.#deps = deps;
  }

  /** Reads the stored overrides. Called at startup; later calls are no-ops. */
  load(): Promise<void> {
    this.#loading ??= this.#load();
    return this.#loading;
  }

  async #load(): Promise<void> {
    const row = await this.#deps.db
      .selectFrom('settings')
      .select('value_json')
      .where('key', '=', RANKING_SETTINGS_KEY)
      .executeTakeFirst();
    if (row === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      parsed = undefined;
    }
    const patch = RankingSettingsPatchSchema.safeParse(parsed);
    const effective = patch.success
      ? RankingSettingsSchema.safeParse(mergeRankingSettings(DEFAULT_RANKING_SETTINGS, patch.data))
      : undefined;
    if (!patch.success || effective?.success !== true) {
      // A row from a newer or broken version: rank with the defaults, keep the row.
      this.#deps.logger?.warn(
        { key: RANKING_SETTINGS_KEY },
        'stored ranking settings are invalid; using the defaults',
      );
      return;
    }
    this.#set(patch.data, effective.data);
  }

  #set(overrides: RankingSettingsPatch, effective: RankingSettings): void {
    this.#overrides = overrides;
    this.#effective = effective;
  }

  /** The effective settings, for ranking. Loads the overrides on first use. */
  async effective(): Promise<RankingSettings> {
    await this.load();
    return this.#effective;
  }

  /** Effective, defaults and overrides: the `GET` body. */
  async view(): Promise<RankingSettingsView> {
    await this.load();
    return {
      effective: this.#effective,
      defaults: DEFAULT_RANKING_SETTINGS,
      overrides: this.#overrides,
    };
  }

  /** `PATCH`: merges `patch` over the effective settings. */
  patch(patch: RankingSettingsPatch): Promise<RankingSettingsView> {
    return this.#write(async () => mergeRankingSettings(await this.effective(), patch));
  }

  /**
   * `PUT`: a complete document replaces the settings. Groups added after the
   * first presets (`RANKING_LATER_GROUPS`) may be missing and take the defaults.
   */
  replace(settings: RankingSettingsInput): Promise<RankingSettingsView> {
    return this.#write(() =>
      Promise.resolve(mergeRankingSettings(DEFAULT_RANKING_SETTINGS, settings)),
    );
  }

  /** `DELETE`: back to the defaults. */
  reset(): Promise<RankingSettingsView> {
    return this.#write(() => Promise.resolve(DEFAULT_RANKING_SETTINGS));
  }

  /** Writes run one at a time, so a patch always merges over the previous write. */
  #write(next: () => Promise<RankingSettings>): Promise<RankingSettingsView> {
    const run = this.#writes.then(async () => {
      await this.load();
      const effective = validate(await next());
      const overrides = (diffSettings(DEFAULT_RANKING_SETTINGS, effective) ??
        {}) as RankingSettingsPatch;
      const { db, clock } = this.#deps;
      if (Object.keys(overrides).length === 0) {
        await db.deleteFrom('settings').where('key', '=', RANKING_SETTINGS_KEY).execute();
      } else {
        const row = {
          key: RANKING_SETTINGS_KEY,
          value_json: JSON.stringify(overrides),
          updated_at: clock(),
        };
        await db
          .insertInto('settings')
          .values(row)
          .onConflict((oc) =>
            oc
              .column('key')
              .doUpdateSet({ value_json: row.value_json, updated_at: row.updated_at }),
          )
          .execute();
      }
      this.#set(overrides, effective);
      try {
        this.#deps.events?.publish({
          type: 'settings.changed',
          data: { key: RANKING_SETTINGS_KEY },
        });
      } catch (err) {
        // Stored either way; a broken bus must not turn the write into an error.
        this.#deps.logger?.error({ err }, 'publishing settings.changed failed');
      }
      return this.view();
    });
    this.#writes = run.catch(() => undefined);
    return run;
  }
}
