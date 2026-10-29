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
  }
  /** Resolves to a sonic-boom stream. */
  export default function roll(options: RollOptions): Promise<unknown>;
}
