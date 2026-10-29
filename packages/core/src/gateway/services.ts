/**
 * The gateway's in-memory services, shared by the `/v1` token, viewer and
 * subtitle routes and the media listener (okf:concept/media-tokens, okf:architecture/media-gateway): one token
 * service, one viewer telemetry, one session-subtitle index per Multitap instance.
 */
import type { Config } from '../config.ts';
import type { Clock } from '../lib/clock.ts';
import type { Logger } from '../log.ts';
import type { SessionRepository } from '../sessions/repository.ts';
import type { SessionService } from '../sessions/service.ts';
import type { SubtitleService } from '../subtitles/index.ts';
import { SessionSubtitles } from './subtitles.ts';
import { JoseTokenService } from './tokens.ts';
import { ViewerTelemetry } from './viewers.ts';

export interface GatewayServices {
  tokens: JoseTokenService;
  viewers: ViewerTelemetry;
  subtitles: SessionSubtitles;
}

export interface GatewayServicesDeps {
  config: Pick<Config, 'media'>;
  sessions: Pick<SessionService, 'getRecord' | 'bumpTokenEpoch' | 'onChange'>;
  repo: Pick<
    SessionRepository,
    'revokeSubject' | 'listRevocations' | 'listSubtitleOffsets' | 'setSubtitleOffset'
  >;
  subtitles: Pick<SubtitleService, 'list' | 'file'>;
  clock: Clock;
  logger: Logger;
}

/** Builds the services and keeps them current from session changes. */
export function createGatewayServices(deps: GatewayServicesDeps): GatewayServices {
  const tokens = new JoseTokenService({
    secret: deps.config.media.tokenSecret,
    previousSecret: deps.config.media.previousTokenSecret,
    maxTtlMs: deps.config.media.tokenMaxTtlMs,
    repo: deps.repo,
    sessions: deps.sessions,
    clock: deps.clock,
    logger: deps.logger,
  });
  const viewers = new ViewerTelemetry(deps.clock);
  deps.sessions.onChange((record) => {
    tokens.observe(record);
    if (record.status === 'released') viewers.forget(record.id);
  });
  return {
    tokens,
    viewers,
    subtitles: new SessionSubtitles({
      subtitles: deps.subtitles,
      repo: deps.repo,
      clock: deps.clock,
    }),
  };
}
