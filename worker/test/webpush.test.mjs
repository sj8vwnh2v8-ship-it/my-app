// Checks our encryption and signing against independent implementations.
import crypto from 'node:crypto';
import ece from 'http_ece';
import assert from 'node:assert/strict';
import { encryptPayload, generateVapidKeys, vapidAuthHeader, b64url, fromB64url } from '../src/webpush.js';

// Pretend to be a phone: make the keys a browser would.
const phone = crypto.createECDH('prime256v1');
phone.generateKeys();
const authSecret = crypto.randomBytes(16);
const subscription = {
  endpoint: 'https://web.push.apple.com/QGuQyavXutnMMS',
  keys: { p256dh: b64url(phone.getPublicKey()), auth: b64url(authSecret) },
};

// 1. Encryption: an independent library must be able to decrypt it.
const message = JSON.stringify({ title: 'Walk the dog', body: 'Reminder', tag: 'x' });
const encrypted = await encryptPayload(subscription, new TextEncoder().encode(message));
const decrypted = ece.decrypt(Buffer.from(encrypted), { version: 'aes128gcm', privateKey: phone, authSecret });
assert.equal(decrypted.toString(), message);
console.log('✓ encryption decrypts correctly with http_ece');

// 2. Signature: the VAPID token must verify with the public key.
const vapid = await generateVapidKeys();
const header = await vapidAuthHeader(subscription.endpoint, vapid, 'https://example.com/');
const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
assert.ok(m, 'header format');
const [h, c, sig] = m[1].split('.');
assert.equal(m[2], vapid.publicKey);
const claims = JSON.parse(Buffer.from(fromB64url(c)).toString());
assert.equal(claims.aud, 'https://web.push.apple.com');
assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(fromB64url(vapid.publicKey).slice(1, 33)), y: b64url(fromB64url(vapid.publicKey).slice(33)) }, format: 'jwk' });
assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(fromB64url(sig))));
console.log('✓ VAPID signature verifies');
