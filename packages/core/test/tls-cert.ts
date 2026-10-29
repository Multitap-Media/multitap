import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/*
 * Throwaway self-signed certificates for TLS tests, made offline with
 * node:crypto (which can sign but has no certificate builder), so no key is
 * ever checked in. A minimal DER encoder writes an X.509 v3 certificate for
 * CN=localhost with subjectAltName localhost and 127.0.0.1, an EC P-256 key,
 * signed ecdsa-with-SHA256, valid from a day ago to a day ahead.
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...content: Buffer[]) => {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...items: Buffer[]) => tlv(0x30, ...items);
const oid = (...bytes: number[]) => tlv(0x06, Buffer.from(bytes));

const ECDSA_WITH_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const COMMON_NAME = oid(0x55, 0x04, 0x03);
const SUBJECT_ALT_NAME = oid(0x55, 0x1d, 0x11);

function utcTime(date: Date): Buffer {
  const iso = date.toISOString(); // 2026-09-30T12:34:56.789Z
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface TestCertificate {
  cert: string;
  key: string;
}

export function selfSignedCertificate(now = new Date()): TestCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const name = seq(tlv(0x31, seq(COMMON_NAME, tlv(0x0c, Buffer.from('localhost')))));
  const serial = randomBytes(8);
  // Positive and minimally encoded: DER rejects a leading 0x00 byte followed by
  // one below 0x80 ("illegal padding"), so the top byte is kept in 0x40–0x7f.
  serial[0] = 0x40 | ((serial[0] ?? 0) & 0x3f);
  const altNames = seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1])));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial),
    seq(ECDSA_WITH_SHA256),
    name,
    seq(
      utcTime(new Date(now.getTime() - 86_400_000)),
      utcTime(new Date(now.getTime() + 86_400_000)),
    ),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(seq(SUBJECT_ALT_NAME, tlv(0x04, altNames)))),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, seq(ECDSA_WITH_SHA256), tlv(0x03, Buffer.from([0]), signature));
  return {
    cert: pem('CERTIFICATE', der),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}
