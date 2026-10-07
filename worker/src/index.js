// Today reminder service.
//
// The app sends the list of upcoming reminders (text + time) for your phone.
// This service keeps them and, at the right moment, sends a notification.
// It never sees anything else from your to-do list.

import { DurableObject } from 'cloudflare:workers';
import { generateVapidKeys, sendPush } from './webpush.js';

const MAX_REMINDERS = 300;
const MAX_TEXT = 200;
const LATE_LIMIT_MS = 6 * 3600 * 1000; // don't send reminders more than 6 hours late
// Only these push services are allowed, so nobody can use this service to call other websites.
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.notify\.windows\.com$/, /\.push\.services\.mozilla\.com$/];

// ---------- Storage + scheduling (one shared store) ----------

export class ReminderStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, sub TEXT NOT NULL, updated INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reminders (
      sub_id TEXT NOT NULL, rid TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (sub_id, rid))`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS reminders_at ON reminders (at)`);
  }

  async vapid() {
    let keys = await this.ctx.storage.get('vapid');
    if (!keys) {
      keys = await generateVapidKeys();
      await this.ctx.storage.put('vapid', keys);
    }
    return keys;
  }

  async publicKey() {
    return (await this.vapid()).publicKey;
  }

  async setReminders(sub, reminders) {
    const id = await subId(sub.endpoint);
    this.sql.exec(`INSERT OR REPLACE INTO subs (id, sub, updated) VALUES (?, ?, ?)`, id, JSON.stringify(sub), Date.now());
    this.sql.exec(`DELETE FROM reminders WHERE sub_id = ?`, id);
    for (const r of reminders) {
      this.sql.exec(`INSERT OR REPLACE INTO reminders (sub_id, rid, at, title, body) VALUES (?, ?, ?, ?, ?)`, id, r.id, r.at, r.title, r.body);
    }
    await this.schedule();
    return reminders.length;
  }

  async removeSub(endpoint) {
    const id = await subId(endpoint);
    this.sql.exec(`DELETE FROM reminders WHERE sub_id = ?`, id);
    this.sql.exec(`DELETE FROM subs WHERE id = ?`, id);
    await this.schedule();
  }

  async sendTest(sub) {
    return this.push(sub, { title: 'Reminders are on 🎉', body: 'This is what a reminder from Today looks like.', tag: 'test' });
  }

  async push(sub, data) {
    return sendPush(sub, data, await this.vapid(), this.env.VAPID_SUBJECT);
  }

  // Wake up exactly when the next reminder is due.
  async schedule() {
    const row = this.sql.exec(`SELECT MIN(at) AS next FROM reminders`).one();
    if (row.next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(row.next, Date.now() + 500));
  }

  async alarm() {
    const now = Date.now();
    const due = this.sql.exec(
      `SELECT r.sub_id, r.rid, r.at, r.title, r.body, s.sub FROM reminders r JOIN subs s ON s.id = r.sub_id WHERE r.at <= ?`,
      now + 1000,
    ).toArray();

    const gone = new Set();
    for (const r of due) {
      this.sql.exec(`DELETE FROM reminders WHERE sub_id = ? AND rid = ?`, r.sub_id, r.rid);
      if (gone.has(r.sub_id) || now - r.at > LATE_LIMIT_MS) continue;
      try {
        const status = await this.push(JSON.parse(r.sub), { title: r.title, body: r.body, tag: r.rid });
        if (status === 404 || status === 410) {
          // The phone turned off notifications or removed the app.
          gone.add(r.sub_id);
          this.sql.exec(`DELETE FROM reminders WHERE sub_id = ?`, r.sub_id);
          this.sql.exec(`DELETE FROM subs WHERE id = ?`, r.sub_id);
        }
      } catch (e) {
        console.log('push failed', e && e.message);
      }
    }
    // Clean up reminders that belong to nobody.
    this.sql.exec(`DELETE FROM reminders WHERE sub_id NOT IN (SELECT id FROM subs)`);
    await this.schedule();
  }
}

async function subId(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Checking what the app sends ----------

function validSubscription(sub, env) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || !sub.keys) return null;
  let url;
  try { url = new URL(sub.endpoint); } catch { return null; }
  const allowAny = env.ALLOW_ANY_PUSH_HOST === 'true'; // local testing only
  if (!allowAny && (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname)))) return null;
  const { p256dh, auth } = sub.keys;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) return null;
  return { endpoint: sub.endpoint, keys: { p256dh, auth } };
}

function validReminders(list) {
  if (!Array.isArray(list) || list.length > MAX_REMINDERS) return null;
  const now = Date.now();
  const out = [];
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || r.id.length > 120 || typeof r.at !== 'number') return null;
    if (r.at < now - 3600 * 1000 || r.at > now + 31 * 86400 * 1000) continue;
    out.push({
      id: r.id,
      at: Math.round(r.at),
      title: String(r.title || 'Reminder').slice(0, MAX_TEXT),
      body: String(r.body || '').slice(0, MAX_TEXT),
    });
  }
  return out;
}

// ---------- Web requests from the app ----------

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    const store = env.REMINDERS.get(env.REMINDERS.idFromName('main'));

    if (request.method === 'GET' && url.pathname === '/') {
      return json(env, { ok: true, service: 'Today reminders' });
    }
    if (request.method === 'GET' && url.pathname === '/vapid') {
      return json(env, { publicKey: await store.publicKey() });
    }

    let body;
    try {
      const text = await request.text();
      if (text.length > 200000) return json(env, { error: 'too big' }, 413);
      body = JSON.parse(text || '{}');
    } catch {
      return json(env, { error: 'bad json' }, 400);
    }
    const sub = validSubscription(body.subscription, env);
    if (!sub) return json(env, { error: 'bad subscription' }, 400);

    if (request.method === 'PUT' && url.pathname === '/reminders') {
      const reminders = validReminders(body.reminders);
      if (!reminders) return json(env, { error: 'bad reminders' }, 400);
      return json(env, { ok: true, saved: await store.setReminders(sub, reminders) });
    }
    if (request.method === 'DELETE' && url.pathname === '/reminders') {
      await store.removeSub(sub.endpoint);
      return json(env, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/test') {
      const status = await store.sendTest(sub);
      return json(env, { ok: status >= 200 && status < 300, status });
    }
    return json(env, { error: 'not found' }, 404);
  },
};
