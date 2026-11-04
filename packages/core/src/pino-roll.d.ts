declare module 'pino-roll' {
  export interface RollOptions {
    file: string | (() => string);
    size?: number | string;
    frequency?: 'daily' | 'hourly' | number;
    extension?: string;
    dateFormat?: string;
    mkdir?: boolean;
    symlink?: boolean;
    limit?: { count?: number; removeOtherLogFiles?: boolean };
    /** Passed to sonic-boom: the mode new files are created with. */
    mode?: number;
  }
  /** Resolves to a sonic-boom stream. */
  export default function roll(options: RollOptions): Promise<unknown>;
}
