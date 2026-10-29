/**
 * Port of stremio-core's `stremio-watched-bitfield` crate
 * (`ref/stremio-core/stremio-watched-bitfield/src/`): which videos of a meta
 * item have been watched, serialized as `{anchorVideoId}:{anchorLength}:{zlib+base64}`
 * so a library item stays readable by Stremio.
 */
import { deflateSync, inflateSync } from 'node:zlib';

/** `BitField8`: bit `i` is bit `i % 8` of byte `i / 8`. */
export class BitField8 {
  length: number;
  values: Uint8Array;

  constructor(length: number, values?: Uint8Array) {
    const bytes = Math.ceil(length / 8);
    if (values === undefined) {
      this.values = new Uint8Array(bytes);
    } else if (values.length < bytes) {
      // `new_with_values`: pad with zeroes, never truncate.
      this.values = new Uint8Array(bytes);
      this.values.set(values);
    } else {
      this.values = Uint8Array.from(values);
    }
    this.length = length;
  }

  /** `new_with_values(values, None)`: the length is every bit of the bytes. */
  static fromValues(values: Uint8Array, length?: number): BitField8 {
    return new BitField8(length ?? values.length * 8, values);
  }

  /** `TryFrom<(String, Option<usize>)>`: base64 of zlib-compressed bytes. */
  static decode(encoded: string, length?: number): BitField8 {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw new Error('Invalid base64 in watched bitfield');
    }
    const values = inflateSync(Buffer.from(encoded, 'base64'));
    return BitField8.fromValues(new Uint8Array(values), length);
  }

  get(i: number): boolean {
    const index = Math.floor(i / 8);
    if (index >= this.values.length) return false;
    return (((this.values[index] ?? 0) >> (i % 8)) & 1) !== 0;
  }

  set(i: number, val: boolean): void {
    const index = Math.floor(i / 8);
    const mask = 1 << (i % 8);
    if (index >= this.values.length) {
      const grown = new Uint8Array(index + 1);
      grown.set(this.values);
      this.values = grown;
      this.length = this.values.length * 8;
    }
    const byte = this.values[index] ?? 0;
    this.values[index] = val ? byte | mask : byte & ~mask & 0xff;
  }

  lastIndexOf(val: boolean): number | undefined {
    for (let i = this.length - 1; i >= 0; i--) if (this.get(i) === val) return i;
    return undefined;
  }

  /** zlib at level 6, then standard base64 with padding, like the crate. */
  encode(): string {
    return deflateSync(this.values, { level: 6 }).toString('base64');
  }
}

/** `WatchedField`: the serialized form, before it is aligned to a video list. */
export interface WatchedField {
  anchorVideo: string;
  anchorLength: number;
  bitfield: BitField8;
}

/** `WatchedField::from_str`. Video ids may contain `:`; the last two parts are the length and data. */
export function parseWatchedField(serialized: string): WatchedField {
  const components = serialized.split(':');
  if (components.length < 3) throw new Error('Not enough components');
  const data = components.pop() ?? '';
  const lengthText = components.pop() ?? '';
  if (!/^\+?\d+$/.test(lengthText)) throw new Error('Invalid anchor length');
  return {
    anchorVideo: components.join(':'),
    anchorLength: Number.parseInt(lengthText, 10),
    bitfield: BitField8.decode(data),
  };
}

export class WatchedBitField {
  bitfield: BitField8;
  readonly videoIds: readonly string[];

  constructor(bitfield: BitField8, videoIds: readonly string[]) {
    this.bitfield = bitfield;
    this.videoIds = videoIds;
  }

  static constructFromArray(arr: readonly boolean[], videoIds: readonly string[]): WatchedBitField {
    const bitfield = new BitField8(videoIds.length);
    arr.forEach((val, i) => {
      bitfield.set(i, val);
    });
    return new WatchedBitField(bitfield, videoIds);
  }

  /**
   * `construct_with_videos`: aligns a stored field to the current video list
   * by its anchor video, so episodes added or removed before it keep their
   * marks. An anchor no longer in the list gives an empty field.
   */
  static constructWithVideos(field: WatchedField, videoIds: readonly string[]): WatchedBitField {
    const anchorIdx = videoIds.indexOf(field.anchorVideo);
    if (anchorIdx === -1) return new WatchedBitField(new BitField8(videoIds.length), videoIds);
    const offset = field.anchorLength - anchorIdx - 1;
    const bitfield = BitField8.fromValues(field.bitfield.values, videoIds.length);
    if (offset === 0) return new WatchedBitField(bitfield, videoIds);
    const resized = new WatchedBitField(new BitField8(videoIds.length), videoIds);
    for (let i = 0; i < videoIds.length; i++) {
      const prev = i + offset;
      if (prev >= 0 && prev < bitfield.length) resized.set(i, bitfield.get(prev));
    }
    return resized;
  }

  static constructAndResize(serialized: string, videoIds: readonly string[]): WatchedBitField {
    return WatchedBitField.constructWithVideos(parseWatchedField(serialized), videoIds);
  }

  get(idx: number): boolean {
    return this.bitfield.get(idx);
  }

  getVideo(videoId: string): boolean {
    const pos = this.videoIds.indexOf(videoId);
    return pos === -1 ? false : this.bitfield.get(pos);
  }

  set(idx: number, v: boolean): void {
    this.bitfield.set(idx, v);
  }

  setVideo(videoId: string, v: boolean): void {
    const pos = this.videoIds.indexOf(videoId);
    if (pos !== -1) this.bitfield.set(pos, v);
  }

  clone(): WatchedBitField {
    return new WatchedBitField(
      new BitField8(this.bitfield.length, this.bitfield.values),
      this.videoIds,
    );
  }

  /** `Display`: anchored at the last watched video (`undefined` when there are no videos). */
  toString(): string {
    const lastId = this.bitfield.lastIndexOf(true) ?? 0;
    const lastVideoId = this.videoIds[lastId] ?? 'undefined';
    return `${lastVideoId}:${String(lastId + 1)}:${this.bitfield.encode()}`;
  }
}
