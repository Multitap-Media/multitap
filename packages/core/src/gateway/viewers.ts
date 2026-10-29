/**
 * Per-subject media telemetry (okf:architecture/media-gateway-proxy): the last file and video
 * segment each token subject asked for, and the bytes sent to it. In memory
 * only; `GET /v1/sessions/{id}/viewers` reads it. Forgotten when the session
 * is released.
 */
import type { Viewer } from '@multitap/api';
import type { Clock } from '../lib/clock.ts';

/** Most subjects tracked per session; further ones are not recorded. */
export const MAX_VIEWERS_PER_SESSION = 1_000;

/** A video segment (`seg12.ts`); audio-only segments (`a1seg12.ts`) don't count. */
const VIDEO_SEGMENT = /^seg(\d+)\.ts$/;

interface ViewerState {
  lastFile?: string;
  lastSegment?: number;
  lastRequestAt?: number;
  bytes: number;
  requests: number;
}

export class ViewerTelemetry {
  readonly #clock: Clock;
  readonly #sessions = new Map<string, Map<string, ViewerState>>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  #viewer(sessionId: string, subject: string): ViewerState | undefined {
    let viewers = this.#sessions.get(sessionId);
    if (viewers === undefined) {
      viewers = new Map();
      this.#sessions.set(sessionId, viewers);
    }
    let viewer = viewers.get(subject);
    if (viewer === undefined) {
      if (viewers.size >= MAX_VIEWERS_PER_SESSION) return undefined;
      viewer = { bytes: 0, requests: 0 };
      viewers.set(subject, viewer);
    }
    return viewer;
  }

  /** A media request by `subject` for `file` (an allowlisted name). */
  request(sessionId: string, subject: string, file: string): void {
    const viewer = this.#viewer(sessionId, subject);
    if (viewer === undefined) return;
    viewer.requests += 1;
    viewer.lastFile = file;
    viewer.lastRequestAt = this.#clock();
    const segment = VIDEO_SEGMENT.exec(file);
    if (segment !== null) viewer.lastSegment = Number(segment[1]);
  }

  /** Bytes sent to `subject`. */
  bytes(sessionId: string, subject: string, count: number): void {
    const viewer = this.#viewer(sessionId, subject);
    if (viewer !== undefined) viewer.bytes += count;
  }

  list(sessionId: string): Viewer[] {
    const viewers = this.#sessions.get(sessionId);
    if (viewers === undefined) return [];
    return [...viewers].map(([subject, v]) => {
      const out: Viewer = { subject, bytes: v.bytes, requests: v.requests };
      if (v.lastFile !== undefined) out.lastFile = v.lastFile;
      if (v.lastSegment !== undefined) out.lastSegment = v.lastSegment;
      if (v.lastRequestAt !== undefined)
        out.lastRequestAt = new Date(v.lastRequestAt).toISOString();
      return out;
    });
  }

  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }
}
