// End-to-end: the local reminder service sends a reminder to a pretend phone.
import crypto from 'node:crypto';
import http from 'node:http';
import ece from 'http_ece';
import assert from 'node:assert/strict';
import { b64url } from '../src/webpush.js';

const API = 'http://127.0.0.1:8787';
const phone = crypto.createECDH('prime256v1'); phone.generateKeys();
const authSecret = crypto.randomBytes(16);
const received = [];
const server = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const text = ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: phone, authSecret }).toString();
    received.push({ at: Date.now(), headers: req.headers, data: JSON.parse(text) });
    res.writeHead(req.url === '/gone' ? 410 : 201); res.end();
  });
}).listen(9911);
const sub = { endpoint: 'http://127.0.0.1:9911/push', keys: { p256dh: b64url(phone.getPublicKey()), auth: b64url(authSecret) } };
const call = (method, path, body, origin = 'https://sj8vwnh2v8-ship-it.github.io') =>
  fetch(API + path, { method, headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });

// Test notification
let r = await (await call('POST', '/test', { subscription: sub })).json();
assert.equal(r.ok, true);
assert.equal(received.at(-1).data.tag, 'test');
assert.equal(received.at(-1).headers['content-encoding'], 'aes128gcm');
assert.match(received.at(-1).headers.authorization, /^vapid t=.+, k=.+/);
console.log('✓ test notification delivered:', received.at(-1).data.title);

// Scheduled reminders: one in 3s, one in 6s, then replace the list so the 6s one is cancelled
const now = Date.now();
r = await (await call('PUT', '/reminders', { subscription: sub, reminders: [
  { id: 'a', at: now + 3000, title: 'Walk the dog', body: 'Reminder' },
  { id: 'b', at: now + 6000, title: 'Should be cancelled', body: '' },
] })).json();
assert.equal(r.saved, 2);
r = await (await call('PUT', '/reminders', { subscription: sub, reminders: [{ id: 'a', at: now + 3000, title: 'Walk the dog', body: 'Reminder' }] })).json();
await new Promise((res) => setTimeout(res, 8000));
const sched = received.filter((x) => x.data.tag !== 'test');
assert.equal(sched.length, 1, 'only the remaining reminder is sent');
assert.equal(sched[0].data.title, 'Walk the dog');
assert.ok(sched[0].at >= now + 3000 - 1000, 'not sent early');
console.log(`✓ scheduled reminder arrived ${((sched[0].at - (now + 3000)) / 1000).toFixed(1)}s after its time; cancelled one did not`);

// A phone that's gone (410) gets cleaned up
const gone = { ...sub, endpoint: 'http://127.0.0.1:9911/gone' };
await call('PUT', '/reminders', { subscription: gone, reminders: [{ id: 'g1', at: Date.now() + 1500, title: 'x', body: '' }, { id: 'g2', at: Date.now() + 1500, title: 'y', body: '' }, { id: 'g3', at: Date.now() + 3000, title: 'z', body: '' }] });
await new Promise((res) => setTimeout(res, 5000));
assert.equal(received.filter((x) => ['g2', 'g3'].includes(x.data.tag)).length, 0, 'stops after phone is gone');
console.log('✓ removed phone is cleaned up after the first failed send');

// Bad input is rejected; CORS header set
r = await call('PUT', '/reminders', { subscription: { endpoint: 'nope' }, reminders: [] });
assert.equal(r.status, 400);
const opt = await fetch(API + '/reminders', { method: 'OPTIONS' });
assert.equal(opt.headers.get('access-control-allow-origin'), 'https://sj8vwnh2v8-ship-it.github.io');
console.log('✓ bad requests rejected, only your website allowed');
server.close();
