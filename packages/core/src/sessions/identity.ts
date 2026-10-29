/**
 * The idempotency identity of a playback session (okf:architecture/playback-session, okf:architecture/rendition-and-bandwidth): a create with
 * the same key, item, source, requested delivery and requested quality as an
 * open session returns that session. For auto-select, the source includes
 * `preferBingeGroup`, and the request's preferred languages and `profileId`
 * count too, since they change which source is picked. Without a key there is no identity and
 * every create is new.
 */
import { createHash } from 'node:crypto';
import type { DeliveryRequest, SessionItem, SessionQuality, SessionSource } from '@multitap/api';

export interface IdentityParts {
  key: string | undefined;
  item: SessionItem;
  source: SessionSource;
  /** The requested delivery (`auto` and `transcode` stay distinct, as requested). */
  delivery: DeliveryRequest;
  /** After capping at the engine's limits, so a capped and an exact request match. */
  quality: SessionQuality | undefined;
  /**
   * Auto-select only: the request's own preferred languages, normalized (not
   * the instance default, so changing the default doesn't orphan sessions).
   */
  preferredLanguages?: readonly string[] | undefined;
  /** Auto-select only: the request's `profileId` (its languages and last source change the pick). */
  profileId?: string | undefined;
}

/** SHA-256 hex over a canonical encoding; null when there is no key. */
export function sessionIdentity(parts: IdentityParts): string | null {
  if (parts.key === undefined) return null;
  const auto = 'auto' in parts.source;
  let source: Record<string, unknown>;
  if ('auto' in parts.source) {
    source = { auto: true };
    if (parts.source.preferBingeGroup !== undefined) {
      source.preferBingeGroup = parts.source.preferBingeGroup;
    }
  } else {
    source = { key: parts.source.key };
  }
  const fields: unknown[] = [
    parts.key,
    parts.item.type,
    parts.item.id,
    parts.item.videoId ?? null,
    source,
    parts.delivery,
    parts.quality?.maxHeight ?? null,
    parts.quality?.bitrate ?? null,
  ];
  // Appended only when present, so identities stored before it existed still match.
  if (auto && parts.preferredLanguages !== undefined && parts.preferredLanguages.length > 0) {
    fields.push({ preferredLanguages: parts.preferredLanguages });
  }
  if (auto && parts.profileId !== undefined) fields.push({ profileId: parts.profileId });
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
