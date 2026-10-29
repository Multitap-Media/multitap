/**
 * A secret value (okf:architecture/secrets-policy (a)). `toString()`, `toJSON()` and Node's
 * inspect all give `[redacted]`, so a secret that ends up in a log field, an
 * error message or a serialized object shows as `[redacted]` under any name and
 * at every log level, `debug` included. The value comes out only through an
 * explicit {@link Secret.reveal} at the point of use.
 */
import { inspect } from 'node:util';

export const SECRET_REDACTED = '[redacted]';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The plaintext. Call it only where the value is sent, never to log or return it. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return SECRET_REDACTED;
  }

  toJSON(): string {
    return SECRET_REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${SECRET_REDACTED})`;
  }

  [Symbol.toPrimitive](): string {
    return SECRET_REDACTED;
  }
}
