'use strict';

// ============================================================
//  Today — a simple to-do list that lives on your phone.
//  All data is kept in this browser's local storage.
// ============================================================

const APP_VERSION = '1.18.1';
// The reminder service's web address. Reminders are switched off (and hidden
// in the app) while this is empty. To turn them on, install the service in
// worker/ on Cloudflare and put its address here.
const REMINDER_API = 'https://today-reminders.ember-fb3eb2.workers.dev';
const STORE_KEY = 'today-app-data';
const PRIORITY_RANK = { high: 0, med: 1, low: 2 };
const PRIORITY_LABEL = { high: 'High', med: 'Medium', low: 'Low' };
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- Dates (always local time, as "YYYY-MM-DD") ----------

function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}
function friendlyDate(key) {
  const today = dateKey();
  if (key === today) return 'Today';
  if (key === addDays(today, -1)) return 'Yesterday';
  return parseKey(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- Saved data ----------
//
// items:   one entry per to-do on a specific day.
//          { id, text, date, done, doneAt, priority, repeatId, createdAt,
//            deleted, carry: 'moved' | 'dropped' | undefined, carriedFrom }
// repeats: rules that create an item automatically on matching days.
//          { id, text, kind: 'daily' | 'weekly', days: [0-6], priority, startDate, active }
// meta:    { firstUseDate, lastOpenDate, tipDismissed }
// profile: your hobbies and goals (null until you answer or skip the questions).
//          { hobbies: [text], goals: [{ id, text, freq: 'daily' | 'few' | 'weekly' }] }
// suggest: { dismissed: { text: count }, today: { date, handled: [text] } }
//
// Items also remember where their color came from (prioritySource:
// 'user' = you picked it, 'guess' = the app guessed) and, if they came from
// a suggestion, which one (suggestFrom).

function freshState() {
  return upgrade({ version: 1, items: [], repeats: [], meta: { firstUseDate: dateKey(), lastOpenDate: null } });
}

// Fill in anything older saved data is missing.
function upgrade(s) {
  if (!('profile' in s)) s.profile = null;
  if (!s.suggest) s.suggest = { dismissed: {}, today: null };
  if (!s.suggest.dismissed) s.suggest.dismissed = {};
  for (const i of s.items) {
    if (i.priority && !i.prioritySource) i.prioritySource = 'user';
  }
  return s;
}

function isValidState(s) {
  return s && typeof s === 'object' && Array.isArray(s.items) && Array.isArray(s.repeats) && s.meta && typeof s.meta === 'object';
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    return isValidState(parsed) ? upgrade(parsed) : freshState();
  } catch (e) {
    return freshState();
  }
}

let state = load();
let currentDay = dateKey();
let viewTomorrow = false; // the Today | Tomorrow switch

// The day whose list is on screen.
function viewDay() {
  return viewTomorrow ? addDays(currentDay, 1) : currentDay;
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    showToast("Couldn't save. Your phone may be out of storage.");
  }
  scheduleReminderSync();
}

// Ask the phone to keep our data even when storage runs low.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

// ---------- Repeating to-dos ----------

// kind: 'daily' | 'weekly' (days, every 1 or 2 weeks) | 'monthly' (dom = day of month)
function repeatMatches(rule, day) {
  if (!rule.active || day < rule.startDate) return false;
  if (rule.kind === 'daily') return true;
  const d = parseKey(day);
  if (rule.kind === 'monthly') {
    const dom = rule.dom || parseKey(rule.startDate).getDate();
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return d.getDate() === Math.min(dom, lastDay); // the 31st falls back to the month's last day
  }
  if (!rule.days.includes(d.getDay())) return false;
  if ((rule.every || 1) > 1) {
    const weeks = Math.round((dayNumber(weekOf(day)) - dayNumber(weekOf(rule.startDate))) / 7);
    return weeks % rule.every === 0;
  }
  return true;
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + s;
}

function addRepeatItemsFor(day) {
  let changed = false;
  for (const rule of state.repeats) {
    if (!repeatMatches(rule, day)) continue;
    const exists = state.items.some((i) => i.repeatId === rule.id && i.date === day);
    if (exists) continue;
    state.items.push({
      id: uid(), text: rule.text, date: day, done: false, doneAt: null,
      priority: rule.priority || null, prioritySource: rule.priority ? 'user' : null,
      time: rule.time || null, repeatId: rule.id, createdAt: Date.now(),
    });
    changed = true;
  }
  return changed;
}

// Two repeats are the same if they have the same words and the same schedule
// ("Daily" and "Weekly on all 7 days" count as the same).
function scheduleKey(rule) {
  if (rule.kind === 'monthly') return 'm' + (rule.dom || parseKey(rule.startDate).getDate());
  const days = rule.kind === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : [...rule.days].sort((a, b) => a - b);
  const every = rule.kind === 'daily' ? 1 : rule.every || 1;
  return days.length === 7 && every === 1 ? 'd' : `w${days.join()}/${every}`;
}
function sameRepeat(a, b) {
  return normText(a.text) === normText(b.text) && scheduleKey(a) === scheduleKey(b);
}

// If the same repeat got set up twice (say "Gym every day" typed on two
// different days), keep the first one and fold the other into it, so the
// to-do only shows up once. Past days are left as they were.
// Returns true if anything was merged.
function mergeDuplicateRepeats() {
  const kept = [];
  let merged = false;
  for (const rule of state.repeats) {
    if (!rule.active) continue;
    const keep = kept.find((k) => sameRepeat(k, rule));
    if (!keep) { kept.push(rule); continue; }
    rule.active = false;
    merged = true;
    for (const i of state.items) {
      if (i.repeatId !== rule.id || i.deleted || i.date < currentDay) continue;
      const twin = state.items.find((j) => j.repeatId === keep.id && j.date === i.date && !j.deleted);
      if (!twin) i.repeatId = keep.id;
      else if (i.done && !twin.done) { twin.deleted = true; i.repeatId = keep.id; }
      else i.deleted = true;
    }
  }
  return merged;
}

function describeRepeat(rule) {
  if (rule.kind === 'daily') return 'Every day';
  if (rule.kind === 'monthly') return `Monthly on the ${ordinal(rule.dom || parseKey(rule.startDate).getDate())}`;
  const days = [...rule.days].sort((a, b) => a - b);
  const two = (rule.every || 1) > 1;
  if (days.length === 7) return two ? 'Every other week' : 'Every day';
  if (days.join() === '1,2,3,4,5') return two ? 'Every 2 weeks on weekdays' : 'Weekdays';
  if (days.join() === '0,6') return two ? 'Every 2 weeks on weekends' : 'Weekends';
  const list = days.map((d) => DAY_SHORT[d]).join(', ');
  return two ? `Every 2 weeks on ${list}` : `Every ${list}`;
}

// ---------- Queries ----------

function itemsForDay(day) {
  return state.items.filter((i) => i.date === day && !i.deleted);
}

function priorityRank(p) {
  return p in PRIORITY_RANK ? PRIORITY_RANK[p] : 3;
}

// Unfinished first, then finished. If you've dragged things into your own
// order on a day, that order wins; otherwise higher priority goes on top.
function sortedItems(items) {
  const rank = priorityRank;
  const open = items.filter((i) => !i.done);
  const manual = open.some((i) => typeof i.order === 'number');
  const ord = (i) => (typeof i.order === 'number' ? i.order : 1e9);
  open.sort((a, b) => (manual ? ord(a) - ord(b) : 0) || rank(a.priority) - rank(b.priority) || a.createdAt - b.createdAt);
  const done = items.filter((i) => i.done).sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
  return open.concat(done);
}

// Unfinished one-off items from earlier days that you haven't decided on yet.
// Repeating items are left out, since they come back by themselves.
function pendingCarryOver() {
  return state.items
    .filter((i) => i.date < currentDay && !i.done && !i.deleted && !i.carry && !i.repeatId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
}

// How many to-dos each day had, and how many got done.
function dayStats() {
  const byDay = new Map();
  for (const i of state.items) {
    if (i.deleted) continue;
    const s = byDay.get(i.date) || { total: 0, done: 0 };
    s.total++;
    if (i.done) s.done++;
    byDay.set(i.date, s);
  }
  return byDay;
}

// 'complete' = planned something and finished it all; 'partial' = some done;
// 'missed' = nothing done; 'empty' = nothing planned.
function dayStatus(day, byDay) {
  const s = byDay.get(day);
  if (!s || !s.total) return 'empty';
  if (s.done === s.total) return 'complete';
  return s.done > 0 ? 'partial' : 'missed';
}

// Streak = days in a row where you planned something and finished it all.
// Every day counts: a skipped or empty day breaks it.
// Today only counts once it's complete; an unfinished today doesn't break it yet.
//
// Streak savers:
//  😴 Rest days, planned ahead (1 per week), don't break or add to it.
//  ❄️ Freezes: every 7 finished days in a row earns one (hold up to 2).
//     If you miss a day while on a streak, a freeze is used automatically.
const FREEZE_EVERY = 7;
const FREEZE_MAX = 2;
const MAX_REST_PER_WEEK = 1;

function isRestDay(day) {
  return (state.restDays || []).includes(day);
}

// Replays your whole history day by day, so freezes are always worked
// out the same way. Returns the streak, best streak, freezes saved,
// and which days were saved by a freeze.
function streakInfo(byDay = dayStats()) {
  const first = state.meta.firstUseDate || currentDay;
  let run = 0, best = 0, bank = 0, sinceEarn = 0, earnedToday = false;
  const frozen = new Set();
  for (let day = first; day < currentDay; day = addDays(day, 1)) {
    if (isRestDay(day)) continue;
    if (dayStatus(day, byDay) === 'complete') {
      run++;
      best = Math.max(best, run);
      if (++sinceEarn >= FREEZE_EVERY) { bank = Math.min(FREEZE_MAX, bank + 1); sinceEarn = 0; }
    } else if (run > 0 && bank > 0) {
      bank--;
      frozen.add(day);
    } else {
      run = 0;
      sinceEarn = 0;
    }
  }
  // Today only adds once it's complete; an unfinished today doesn't break anything yet.
  if (!isRestDay(currentDay) && dayStatus(currentDay, byDay) === 'complete') {
    run++;
    best = Math.max(best, run);
    if (sinceEarn + 1 >= FREEZE_EVERY && bank < FREEZE_MAX) { bank++; earnedToday = true; }
  }
  return { streak: run, best, freezes: bank, frozen, earnedToday };
}

function computeStreak(byDay = dayStats()) {
  return streakInfo(byDay).streak;
}

function bestStreak(byDay) {
  return streakInfo(byDay).best;
}

function weekOf(day) {
  return addDays(day, -parseKey(day).getDay()); // the Sunday that starts its week
}

function canRestOn(day) {
  const week = weekOf(day);
  return (state.restDays || []).filter((d) => d !== day && weekOf(d) === week).length < MAX_REST_PER_WEEK;
}

function setRestDay(day, on) {
  const list = (state.restDays || []).filter((d) => d !== day);
  if (on) list.push(day);
  state.restDays = list.sort();
  save();
  render();
}

// ---------- Actions ----------

function addItem(text, extra = {}) {
  text = text.trim();
  if (!text) return;
  const guess = guessPriority(state, text, currentDay);
  const item = {
    id: uid(), text, date: extra.date || viewDay(), done: false, doneAt: null,
    priority: guess, prioritySource: guess ? 'guess' : null,
    repeatId: null, createdAt: Date.now(), ...extra,
  };
  placeInManualOrder(item);
  state.items.push(item);
  save();
  render();
}

// On a day you've arranged by hand, slot a new to-do in by its priority
// (above anything less important) instead of dropping it at the bottom.
function placeInManualOrder(item) {
  const open = sortedItems(itemsForDay(item.date)).filter((i) => !i.done);
  if (!open.some((i) => typeof i.order === 'number')) return;
  let at = open.findIndex((i) => priorityRank(i.priority) > priorityRank(item.priority));
  if (at < 0) at = open.length;
  open.splice(at, 0, item);
  open.forEach((i, k) => { i.order = k; });
}

// ---------- Smarter typing ----------
// Understands phrases like "Call mom tomorrow", "Gym every Monday and
// Thursday", "Pay rent monthly on the 1st" or "Standup weekdays", and
// turns them into a day or a repeat. The phrase is removed from the text.

const DAY_WORDS = [
  ['sunday', 'sun'], ['monday', 'mon'], ['tuesday', 'tues', 'tue'], ['wednesday', 'wed'],
  ['thursday', 'thurs', 'thur', 'thu'], ['friday', 'fri'], ['saturday', 'sat'],
];
const DAY_ANY = DAY_WORDS.flat().sort((a, b) => b.length - a.length).join('|');
const DAY_FULL = DAY_WORDS.map((w) => w[0]).join('|');
const DAY_LIST = `(?:${DAY_ANY})(?:(?:\\s*,\\s*and\\s+|\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)(?:${DAY_ANY}))*`;

function dayIndex(word) {
  return DAY_WORDS.findIndex((w) => w.includes(word.toLowerCase()));
}
function daysIn(list) {
  return [...new Set(list.toLowerCase().split(/\s*,\s*and\s+|\s*,\s*|\s+and\s+|\s*&\s*/).map(dayIndex).filter((d) => d >= 0))].sort((a, b) => a - b);
}
// The next date (from `from`, inclusive) that falls on one of `days`.
function nextOn(days, from) {
  for (let k = 0; k < 7; k++) {
    const d = addDays(from, k);
    if (days.includes(parseKey(d).getDay())) return d;
  }
  return from;
}

function parseQuick(input, baseDay) {
  let text = ` ${input} `;
  let repeat = null, date = null;
  const take = (re, fn) => {
    if (repeat || date) return;
    const m = text.match(re);
    if (!m) return;
    if (fn(m) === false) return;
    text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
  };
  const R = (src) => new RegExp(src, 'i');

  // Repeats
  take(R(`\\s(?:every\\s?day|daily)(?=\\s)`), () => { repeat = { kind: 'daily' }; });
  take(R(`\\s(?:every\\s+weekday|(?:on\\s+|every\\s+)?weekdays)(?=\\s)`), () => { repeat = { kind: 'weekly', days: [1, 2, 3, 4, 5], every: 1 }; });
  take(R(`\\s(?:every\\s+weekend|(?:on\\s+|every\\s+)?weekends)(?=\\s)`), () => { repeat = { kind: 'weekly', days: [0, 6], every: 1 }; });
  take(R(`\\s(?:every|each)\\s+month(?:\\s+on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?=\\s)|\\smonthly(?:\\s+on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?=\\s)|\\son\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:every|each)\\s+month(?=\\s)`), (m) => {
    const n = Number(m[1] || m[2] || m[3] || parseKey(baseDay).getDate());
    if (n < 1 || n > 31) return false;
    repeat = { kind: 'monthly', dom: n };
  });
  take(R(`\\s(?:every\\s+(?:other|2nd|second|2)\\s+weeks?|biweekly)(?:\\s+on\\s+(${DAY_LIST}))?(?=\\s)`), (m) => {
    repeat = { kind: 'weekly', days: m[1] ? daysIn(m[1]) : [parseKey(baseDay).getDay()], every: 2 };
  });
  take(R(`\\severy\\s+other\\s+(${DAY_LIST})(?=\\s)`), (m) => { repeat = { kind: 'weekly', days: daysIn(m[1]), every: 2 }; });
  take(R(`\\s(?:every|each)\\s+(${DAY_LIST})(?=\\s)`), (m) => { repeat = { kind: 'weekly', days: daysIn(m[1]), every: 1 }; });
  take(R(`\\s(?:every\\s+week|weekly)(?:\\s+on\\s+(${DAY_LIST}))?(?=\\s)`), (m) => {
    repeat = { kind: 'weekly', days: m[1] ? daysIn(m[1]) : [parseKey(baseDay).getDay()], every: 1 };
  });

  // A single day
  take(R(`\\s(?:today|tonight)(?=\\s)`), () => { date = currentDay; });
  take(R(`\\s(?:tomorrow|tmrw|tmr)(?=\\s)`), () => { date = addDays(currentDay, 1); });
  // Full day names anywhere; short ones ("fri") only after on/next/this.
  take(R(`\\s(?:(?:on|next|this)\\s+(${DAY_ANY})|(${DAY_FULL}))(?=\\s)`), (m) => {
    const word = (m[1] || m[2]).toLowerCase();
    const target = dayIndex(word);
    let d = nextOn([target], currentDay);
    if (/\snext\s/i.test(m[0]) && d === currentDay) d = addDays(d, 7);
    date = d;
  });

  text = text.replace(/\s+/g, ' ').trim().replace(/\s+(?:on|at|by|for)$/i, '').trim();
  if (!text || (!repeat && !date)) return { text: input.trim(), repeat: null, date: null };
  return { text, repeat, date };
}

function describeQuick(q) {
  if (q.repeat) return '↻ ' + describeRepeat({ ...q.repeat, startDate: currentDay });
  if (q.date === currentDay) return '📅 Today';
  if (q.date === addDays(currentDay, 1)) return '📅 Tomorrow';
  return '📅 ' + parseKey(q.date).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

let quickIgnored = false; // you tapped ✕ on the hint for this entry

function renderQuickHint() {
  const value = $('add-input').value;
  const q = value.trim() && !quickIgnored ? parseQuick(value, viewDay()) : null;
  const show = !!(q && (q.repeat || q.date) && !(q.date && !q.repeat && q.date === viewDay()));
  $('quick-hint').hidden = !show;
  if (show) $('quick-hint-text').textContent = `“${q.text}” · ${describeQuick(q)}`;
}

// Adds what you typed, using any day or repeat it understood.
function addFromInput(value) {
  const q = quickIgnored ? { text: value.trim(), repeat: null, date: null } : parseQuick(value, viewDay());
  if (!q.text) return;
  if (q.repeat) {
    const start = q.repeat.kind === 'daily' ? viewDay()
      : q.repeat.kind === 'monthly' ? viewDay()
      : nextOn(q.repeat.days, viewDay());
    const rule = { id: uid(), text: q.text, kind: q.repeat.kind, days: q.repeat.days || [], every: q.repeat.every || 1,
      dom: q.repeat.dom, priority: null, time: null, startDate: start, active: true };
    state.repeats.push(rule);
    const already = mergeDuplicateRepeats();
    addRepeatItemsFor(currentDay);
    if (viewTomorrow) addRepeatItemsFor(addDays(currentDay, 1));
    save();
    render();
    showToast(already ? `Already repeats: ${describeRepeat(rule)}` : `Repeats: ${describeRepeat(rule)}`);
    return;
  }
  const date = q.date || viewDay();
  addItem(q.text, { date });
  if (date !== viewDay()) showToast(date === addDays(currentDay, 1) ? 'Added for tomorrow' : `Added for ${describeQuick({ date }).slice(3)}`);
}

// Checking an item off happens in two steps so it feels like a button:
// first the circle pops and fills right where you tapped, then a moment
// later the list re-sorts and the item glides to its new spot.
let reorderTimer = null;

function toggleDone(id, row) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  item.done = !item.done;
  item.doneAt = item.done ? Date.now() : null;
  save();
  if (item.done) { haptic(); playSound('check'); }

  if (!row) { render(); return; }
  row.classList.toggle('done', item.done);
  row.classList.remove('pop');
  void row.offsetWidth; // restart the pop animation
  if (item.done) row.classList.add('pop');
  row.querySelector('.check').setAttribute('aria-label', item.done ? `Mark "${item.text}" not done` : `Mark "${item.text}" done`);
  renderHeader();
  const items = itemsForDay(viewDay());
  const allDone = items.length > 0 && items.every((i) => i.done);
  $('all-done').hidden = !(allDone && !viewTomorrow);
  if (allDone && item.done && !viewTomorrow) celebrate();

  // Wait until you've stopped tapping for a moment, then re-sort.
  clearTimeout(reorderTimer);
  reorderTimer = setTimeout(() => { reorderTimer = null; renderList({ animate: true }); }, 650);
}

// A tiny vibration on check-off. iPhones don't support the normal web
// vibration feature, but on iOS 18+ toggling a hidden "switch" gives a tap.
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(12); return; }
    if (!isIOS()) return;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.id = 'haptic-switch';
    const label = document.createElement('label');
    label.htmlFor = input.id;
    input.style.display = label.style.display = 'none';
    document.body.append(input, label);
    label.click();
    input.remove();
    label.remove();
  } catch (e) { /* no vibration available; that's fine */ }
}

function deleteItem(id, { stopRepeating = false } = {}) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  item.deleted = true;
  let rule = null;
  if (stopRepeating && item.repeatId) {
    rule = state.repeats.find((r) => r.id === item.repeatId);
    if (rule) rule.active = false;
  }
  save();
  render();
  showToast(stopRepeating ? 'Deleted and stopped repeating' : 'Deleted', 'Undo', () => {
    item.deleted = false;
    if (rule) rule.active = true;
    save();
    render();
  });
}

function carryOver(id, bring) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  if (bring) {
    // Copy it into today. The old day keeps its unfinished item, so the
    // streak stays honest about that day.
    item.carry = 'moved';
    state.items.push({
      id: uid(), text: item.text, date: currentDay, done: false, doneAt: null,
      priority: item.priority || null, prioritySource: item.prioritySource || null,
      time: item.time || null, repeatId: null, createdAt: Date.now(), carriedFrom: item.id, suggestFrom: item.suggestFrom,
      pushes: (item.pushes || 0) + 1,
    });
  } else {
    item.carry = 'dropped';
  }
}

// ---------- Rendering ----------

const $ = (id) => document.getElementById(id);

function render() {
  renderHeader();
  renderInstallTip();
  renderRecap();
  renderBackupNudge();
  renderCarryOver();
  renderSuggestions();
  renderWrapUp();
  renderRestBox();
  renderList();
}

// ---------- Evening wrap-up ----------
// After 8 PM, offer to move what's left to tomorrow (or skip today's copy
// of a repeating to-do, since it comes back tomorrow anyway).
const WRAPUP_HOUR = 20;

function wrapUpItems() {
  return sortedItems(itemsForDay(currentDay)).filter((i) => !i.done);
}

function wrapUpWanted() {
  return !viewTomorrow
    && new Date().getHours() >= WRAPUP_HOUR
    && dateKey() === currentDay
    && !isRestDay(currentDay)
    && state.meta.wrapUpDismissed !== currentDay
    && wrapUpItems().length > 0;
}

function renderWrapUp() {
  const card = $('wrapup');
  const items = wrapUpWanted() ? wrapUpItems() : [];
  card.hidden = items.length === 0;
  if (card.hidden) return;
  $('wrapup-title').textContent = `🌙 ${items.length} left today`;
  const anyDone = itemsForDay(currentDay).some((i) => i.done);
  $('wrapup-sub').textContent = anyDone
    ? 'Finish them for your streak, or move them to tomorrow.'
    : 'Finish at least one thing today to keep your streak going. You can move the rest to tomorrow.';
  const list = $('wrapup-list');
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'carry-text';
    text.textContent = item.text;
    const btn = document.createElement('button');
    btn.className = 'mini yes';
    btn.textContent = 'Tomorrow';
    btn.addEventListener('click', () => {
      const undo = clearForTonight([item]);
      afterWrapUp('Moved to tomorrow', undo);
    });
    li.append(text, btn);
    list.appendChild(li);
  }
}

// Moves what's left to tomorrow. A repeating to-do that already comes back
// tomorrow (like an every-day one) just skips today's copy; any other
// repeating one (say, laundry every Thursday) skips today's copy and gets a
// one-time copy on tomorrow's list.
// Returns a function that undoes it.
function clearForTonight(items) {
  const tomorrow = addDays(currentDay, 1);
  const before = items.map((i) => ({ item: i, date: i.date, deleted: i.deleted, pushes: i.pushes }));
  const copies = [];
  for (const i of items) {
    if (i.repeatId) {
      i.deleted = true;
      const rule = state.repeats.find((r) => r.id === i.repeatId);
      if (rule && repeatMatches(rule, tomorrow)) continue;
      const copy = {
        id: uid(), text: i.text, date: tomorrow, done: false, doneAt: null,
        priority: i.priority || null, prioritySource: i.prioritySource || null,
        repeatId: null, fromRepeat: i.repeatId, movedFrom: currentDay,
        pushes: (i.pushes || 0) + 1, createdAt: Date.now(),
      };
      placeInManualOrder(copy);
      state.items.push(copy);
      copies.push(copy);
    } else {
      i.date = tomorrow; i.movedFrom = currentDay; i.pushes = (i.pushes || 0) + 1;
    }
  }
  save();
  return () => {
    state.items = state.items.filter((i) => !copies.includes(i));
    for (const b of before) {
      b.item.date = b.date; b.item.deleted = b.deleted; b.item.pushes = b.pushes;
      delete b.item.movedFrom;
    }
    save();
    render();
  };
}

function afterWrapUp(message, undo) {
  render();
  const today = itemsForDay(currentDay);
  if (today.length && today.every((i) => i.done)) {
    // Everything left is done now, so the day counts. Celebrate, then offer Undo.
    celebrate(() => showToast(message, 'Undo', undo));
  } else {
    showToast(message, 'Undo', undo);
  }
}

// The 😴 rest-day box: offered on Tomorrow, shown as a banner on a rest day.
function renderRestBox() {
  const box = $('rest-box');
  const day = viewDay();
  const rest = isRestDay(day);
  box.replaceChildren();
  box.hidden = !(viewTomorrow || rest);
  if (box.hidden) return;
  box.classList.toggle('on', rest);
  const text = document.createElement('div');
  text.className = 'rest-text';
  const title = document.createElement('strong');
  const sub = document.createElement('span');
  const btn = document.createElement('button');
  btn.className = 'btn';
  if (rest) {
    title.textContent = viewTomorrow ? '😴 Tomorrow is a rest day' : '😴 Rest day';
    sub.textContent = 'It won’t break or add to your streak. Enjoy it.';
    btn.textContent = 'Cancel';
    btn.classList.add('ghost');
    btn.addEventListener('click', () => setRestDay(day, false));
  } else if (canRestOn(day)) {
    title.textContent = '😴 Need a day off?';
    sub.textContent = 'Make tomorrow a rest day and your streak won’t break. 1 per week.';
    btn.textContent = 'Rest day';
    btn.addEventListener('click', () => { setRestDay(day, true); showToast('Tomorrow is a rest day 😴'); });
  } else {
    title.textContent = '😴 Rest day used';
    sub.textContent = 'You’ve already planned a rest day this week (Sunday to Saturday).';
    btn.hidden = true;
  }
  text.append(title, sub);
  box.append(text, btn);
}

function renderHeader() {
  const d = parseKey(viewDay());
  $('today-label').textContent = d.toLocaleDateString(undefined, { weekday: 'long' });
  const shortDate = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const items = itemsForDay(viewDay());
  const done = items.filter((i) => i.done).length;
  let summary;
  if (!items.length) summary = 'Nothing planned yet';
  else if (viewTomorrow) summary = `${items.length} planned`;
  else summary = `${done} of ${items.length} done`;
  $('progress').textContent = shortDate + ' · ' + summary;
  $('view-today').setAttribute('aria-selected', String(!viewTomorrow));
  $('view-tomorrow').setAttribute('aria-selected', String(viewTomorrow));
  $('add-input').placeholder = viewTomorrow ? 'Add something for tomorrow…' : 'Add something for today…';
  const info = streakInfo();
  const streak = info.streak;
  $('streak-count').textContent = streak;
  $('streak').classList.toggle('zero', streak === 0);
  $('freeze-badge').hidden = info.freezes === 0;
  $('freeze-badge').textContent = '❄️' + info.freezes;
  $('streak').setAttribute('aria-label', `Streak: ${streak} day${streak === 1 ? '' : 's'}` +
    (info.freezes ? `, ${info.freezes} freeze${info.freezes === 1 ? '' : 's'} saved` : ''));
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isInstalled() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function renderInstallTip() {
  $('install-tip').hidden = !(isIOS() && !isInstalled() && !state.meta.tipDismissed);
}

function renderCarryOver() {
  const pending = viewTomorrow ? [] : pendingCarryOver();
  const card = $('carry');
  card.hidden = pending.length === 0;
  if (!pending.length) return;
  $('carry-title').textContent = `${pending.length} unfinished from before`;
  const list = $('carry-list');
  list.replaceChildren();
  for (const item of pending) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'carry-text';
    text.textContent = item.text;
    const when = document.createElement('span');
    when.className = 'carry-date';
    when.textContent = friendlyDate(item.date);
    text.appendChild(when);

    const drop = document.createElement('button');
    drop.className = 'mini';
    drop.textContent = 'Drop';
    drop.addEventListener('click', () => { carryOver(item.id, false); save(); render(); });
    const bring = document.createElement('button');
    bring.className = 'mini yes';
    bring.textContent = 'Bring';
    bring.addEventListener('click', () => { carryOver(item.id, true); save(); render(); });

    li.append(text, drop, bring);
    list.appendChild(li);
  }
}

const NUDGE_AFTER = 2; // pushes before a goal to-do gets a gentle nudge
const NUDGE_CHEERS = ['Even 10 minutes counts.', 'A small step still counts.', 'Maybe a smaller version today?'];

const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ----- Drag to reorder -----

function startDrag(row) {
  const wrap = row.parentElement;
  const list = $('list');
  const all = [...list.children];
  const open = all.filter((w) => !w.querySelector('.item.done'));
  const from = open.indexOf(wrap);
  if (from < 0) return null;
  const tops = open.map((w) => w.getBoundingClientRect().top);
  const step = open.length > 1 ? tops[1] - tops[0] : wrap.offsetHeight + 8;
  haptic();
  wrap.classList.add('lifted');
  list.classList.add('reordering');
  const rowH = wrap.getBoundingClientRect().height;
  return { wrap, open, from, to: from, tops, rowH, height: rowH + 8, step };
}

function moveDrag(d, dy) {
  if (!d) return;
  const { wrap, open, from, tops, height } = d;
  const min = tops[0] - tops[from], max = tops[open.length - 1] - tops[from];
  const y = Math.max(min - 12, Math.min(max + 12, dy));
  wrap.style.transform = `translateY(${y}px) scale(1.03)`;
  // Work out the new spot from where the middle of the lifted row is.
  const mid = tops[from] + y + d.rowH / 2;
  // New position = how many of the other rows now have their middle above it.
  // (A tie goes the way you're dragging.)
  const above = (c) => (y > 0 ? c <= mid : c < mid);
  d.to = open.reduce((n, w, k) => n + (k !== from && above(tops[k] + d.rowH / 2) ? 1 : 0), 0);
  open.forEach((w, k) => {
    if (w === wrap) return;
    let shift = 0;
    if (from < d.to && k > from && k <= d.to) shift = -height;
    if (from > d.to && k < from && k >= d.to) shift = height;
    w.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function endDrag(d) {
  if (!d) return;
  const { wrap, open, from, to } = d;
  const list = $('list');
  wrap.classList.remove('lifted');
  list.classList.remove('reordering');
  open.forEach((w) => { w.style.transform = ''; });
  if (from === to) return;
  const ids = open.map((w) => w.dataset.id);
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  ids.forEach((id, k) => {
    const it = state.items.find((i) => i.id === id);
    if (it) it.order = k;
  });
  save();
  renderList();
}

function renderList({ animate = false } = {}) {
  const items = sortedItems(itemsForDay(viewDay()));
  const list = $('list');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  animate = animate && !reduceMotion;

  // Remember where each item was, so moved items can glide to their new spot.
  const oldTops = new Map();
  if (animate) for (const el of list.children) oldTops.set(el.dataset.id, el.getBoundingClientRect().top);
  list.replaceChildren();

  for (const item of items) {
    const wrap = document.createElement('li');
    wrap.className = 'item-wrap';
    wrap.dataset.id = item.id;
    const label = document.createElement('span');
    label.className = 'swipe-label';
    label.textContent = 'Delete';

    const row = document.createElement('div');
    const guessed = item.priority && item.prioritySource === 'guess';
    row.className = 'item' + (item.priority ? ` p-${item.priority}` : '') + (guessed ? ' guess' : '') + (item.done ? ' done' : '');

    const check = document.createElement('button');
    check.className = 'check';
    check.innerHTML = CHECK_SVG;
    check.setAttribute('aria-label', item.done ? `Mark "${item.text}" not done` : `Mark "${item.text}" done`);
    check.addEventListener('click', () => toggleDone(item.id, row));

    const body = document.createElement('button');
    body.className = 'item-body';
    body.setAttribute('aria-label', `Edit "${item.text}"`);
    const text = document.createElement('span');
    text.className = 'item-text';
    text.textContent = item.text;
    body.appendChild(text);

    const meta = [];
    if (item.time) meta.push('⏰ ' + formatTime(item.time));
    if (item.priority) meta.push((guessed ? 'Guessed: ' : '') + PRIORITY_LABEL[item.priority]);
    if (item.repeatId) {
      const rule = state.repeats.find((r) => r.id === item.repeatId);
      if (rule && rule.active) meta.push('↻ ' + describeRepeat(rule));
    }
    if (item.carriedFrom) meta.push('Carried over');

    // 🎯 Goal tag, or a gentle nudge if a goal to-do keeps getting pushed.
    const goal = goalFor(state, item);
    const pushes = goal && !item.done ? pushCount(state, item, currentDay) : 0;
    if (goal && pushes < NUDGE_AFTER) meta.push('For ' + goal.text);
    if (meta.length) {
      const m = document.createElement('span');
      m.className = 'item-meta';
      m.textContent = meta.join(' · ');
      body.appendChild(m);
    }
    if (goal && pushes >= NUDGE_AFTER) {
      const nudge = document.createElement('span');
      nudge.className = 'item-nudge';
      const what = item.repeatId ? `Skipped ${pushes} times this week` : `Pushed ${pushes} times`;
      const cheer = NUDGE_CHEERS[hashString(item.id + currentDay) % NUDGE_CHEERS.length];
      nudge.textContent = `${what}. It's for ${goal.text}. ${cheer}`;
      body.appendChild(nudge);
      row.classList.add('nudged');
    }
    body.addEventListener('click', () => {
      if (row.dataset.swiped) return;
      openEdit(item.id);
    });

    row.append(check, body);
    wrap.append(label, row);
    enableSwipe(row, item);
    list.appendChild(wrap);
  }

  if (animate && list.animate) {
    for (const el of list.children) {
      const old = oldTops.get(el.dataset.id);
      if (old === undefined) continue;
      const dy = old - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
        { duration: 380, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
    }
  }

  $('empty').hidden = items.length > 0;
  $('all-done').hidden = viewTomorrow || !(items.length > 0 && items.every((i) => i.done));
  $('share-list').hidden = items.length === 0;
  $('swipe-hint').hidden = !(items.length > 0 && items.length <= 3);
}

// Swipe left on an item to delete it.
// Swipe left to delete; press and hold, then drag, to reorder.
const HOLD_MS = 350;

function enableSwipe(row, item) {
  let startX = 0, startY = 0, dx = 0, mode = null; // mode: null | 'swipe' | 'scroll' | 'drag'
  let holdTimer = null, drag = null;

  row.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; dx = 0; mode = null;
    delete row.dataset.swiped;
    clearTimeout(holdTimer);
    if (!item.done && !e.target.closest('.check')) {
      holdTimer = setTimeout(() => { if (!mode) { mode = 'drag'; drag = startDrag(row); } }, HOLD_MS);
    }
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const mx = t.clientX - startX, my = t.clientY - startY;
    if (mode === 'drag') {
      e.preventDefault();
      moveDrag(drag, my);
      return;
    }
    if (!mode) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      clearTimeout(holdTimer);
      mode = Math.abs(mx) > Math.abs(my) && mx < 0 ? 'swipe' : 'scroll';
      if (mode === 'swipe') {
        row.classList.add('dragging');
        row.parentElement.classList.add('swiping');
      }
    }
    if (mode !== 'swipe') return;
    e.preventDefault();
    dx = Math.min(0, mx);
    row.style.transform = `translateX(${dx}px)`;
  }, { passive: false });

  const end = () => {
    clearTimeout(holdTimer);
    if (mode === 'drag') {
      row.dataset.swiped = '1'; // don't also open the edit panel
      endDrag(drag);
      drag = null;
      mode = null;
      return;
    }
    if (mode !== 'swipe') return;
    row.classList.remove('dragging');
    row.dataset.swiped = '1';
    if (dx < -Math.min(110, row.offsetWidth * 0.35)) {
      row.style.transform = 'translateX(-100%)';
      setTimeout(() => deleteItem(item.id), 160);
    } else {
      row.style.transform = '';
      setTimeout(() => row.parentElement.classList.remove('swiping'), 200);
    }
    mode = null;
  };
  row.addEventListener('touchend', end);
  row.addEventListener('touchcancel', end);
}

// ---------- Edit panel ----------

let editing = null; // { id, priority, repeatKind, days }

function setSeg(groupId, value) {
  for (const b of $(groupId).querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.value === (value || '')));
  }
}

function renderDays() {
  const box = $('edit-days');
  box.hidden = editing.repeatKind !== 'weekly';
  $('edit-weekly-extra').hidden = editing.repeatKind !== 'weekly';
  $('edit-monthly').hidden = editing.repeatKind !== 'monthly';
  setSeg('edit-every', String(editing.every));
  $('edit-dom').value = String(editing.dom);
  box.replaceChildren();
  DAY_LETTERS.forEach((letter, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = letter;
    b.setAttribute('aria-label', DAY_SHORT[n]);
    b.setAttribute('aria-pressed', String(editing.days.includes(n)));
    b.addEventListener('click', () => {
      editing.days = editing.days.includes(n) ? editing.days.filter((d) => d !== n) : [...editing.days, n];
      renderDays();
    });
    box.appendChild(b);
  });
  const note = $('repeat-note');
  note.hidden = !editing.repeatKind;
  if (editing.repeatKind === 'weekly') {
    note.textContent = editing.days.length ? describeRepeat({ kind: 'weekly', days: editing.days, every: editing.every }) + '. It will show up on those days by itself.' : 'Pick at least one day.';
  } else if (editing.repeatKind === 'daily') {
    note.textContent = 'It will show up every day by itself.';
  } else if (editing.repeatKind === 'monthly') {
    note.textContent = editing.dom > 28 ? 'In shorter months it shows up on the last day.' : 'It will show up that day each month by itself.';
  }
  const reminds = remindsFor({ active: true, kind: editing.repeatKind, days: editing.days });
  const st = reminderState();
  const line = $('remind-line');
  line.hidden = !reminds || st === 'not-setup';
  line.textContent = st === 'on'
    ? '🔔 You’ll get a reminder at 8 PM the night before and 9 AM on the day.'
    : '🔔 Turn on reminders in ••• to get a heads-up the night before and the morning of.';
}

function openEdit(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const rule = item.repeatId ? state.repeats.find((r) => r.id === item.repeatId && r.active) : null;
  editing = {
    id,
    priority: item.priority || '',
    repeatKind: rule ? rule.kind : '',
    days: rule && rule.kind === 'weekly' ? [...rule.days] : [parseKey(item.date).getDay()],
    every: rule && rule.every ? rule.every : 1,
    dom: rule && rule.kind === 'monthly' ? (rule.dom || parseKey(rule.startDate).getDate()) : parseKey(item.date).getDate(),
  };
  $('edit-text').value = item.text;
  $('edit-time').value = item.time || '';
  renderTimeField();
  setSeg('edit-priority', editing.priority);
  setSeg('edit-repeat', editing.repeatKind);
  renderDays();
  $('delete-choice').hidden = true;
  openSheet('edit-sheet');
}

function saveEdit() {
  const item = state.items.find((i) => i.id === editing.id);
  if (!item) return closeSheets();
  const text = $('edit-text').value.trim();
  if (!text) { showToast('Type something first, or tap Delete.'); return; }
  if (editing.repeatKind === 'weekly' && editing.days.length === 0) { showToast('Pick at least one day to repeat on.'); return; }

  item.text = text;
  item.priority = editing.priority || null;
  // Saving the panel counts as you choosing the color (even if it was guessed).
  item.prioritySource = item.priority ? 'user' : null;
  item.time = $('edit-time').value || null;

  let rule = item.repeatId ? state.repeats.find((r) => r.id === item.repeatId) : null;
  if (editing.repeatKind) {
    if (!rule || !rule.active) {
      // Start a new repeating rule from this item.
      rule = { id: uid(), startDate: item.date, active: true };
      state.repeats.push(rule);
      item.repeatId = rule.id;
    }
    rule.text = text;
    rule.priority = item.priority;
    rule.time = item.time;
    rule.kind = editing.repeatKind;
    rule.days = editing.repeatKind === 'weekly' ? [...editing.days].sort((a, b) => a - b) : [];
    rule.every = editing.repeatKind === 'weekly' ? editing.every : 1;
    rule.dom = editing.repeatKind === 'monthly' ? editing.dom : undefined;
  } else if (rule) {
    // Stop repeating; keep today's copy as a normal to-do.
    rule.active = false;
    item.repeatId = null;
  }
  mergeDuplicateRepeats();

  save();
  closeSheets();
  render();
}

// ---------- Suggestions ----------

// The 💡 button in the header opens and closes the card. After 7 days of
// use the card also opens by itself each day (until you hide it that day).
let suggestOpen = null; // null = decide automatically, true/false = you chose

function suggestCardWanted() {
  if (suggestOpen !== null) return suggestOpen;
  return suggestionsUnlocked(state) && state.suggest.hiddenDay !== currentDay;
}

function setSuggestOpen(open) {
  suggestOpen = open;
  if (!open) { state.suggest.hiddenDay = currentDay; save(); }
  render();
}

function renderSuggestions() {
  const card = $('suggest');
  const list = state.profile ? getSuggestions(state, currentDay) : [];
  const open = suggestCardWanted() && list.length > 0 && !viewTomorrow;
  card.hidden = !open;
  const btn = $('open-suggest');
  btn.setAttribute('aria-pressed', String(open));
  const badge = $('suggest-badge');
  badge.hidden = open || list.length === 0;
  badge.textContent = list.length;
  btn.setAttribute('aria-label', list.length && !open ? `Suggestions (${list.length} new)` : 'Suggestions');
  const ul = $('suggest-list');
  ul.replaceChildren();
  for (const sug of list) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'sug-text';
    text.textContent = sug.text;
    const why = document.createElement('span');
    why.className = 'sug-why';
    why.textContent = sug.reason;
    text.appendChild(why);

    const no = document.createElement('button');
    no.className = 'sug-btn no';
    no.setAttribute('aria-label', `Dismiss "${sug.text}"`);
    no.textContent = '✕';
    no.addEventListener('click', () => handleSuggestion(sug, false));
    const yes = document.createElement('button');
    yes.className = 'sug-btn yes';
    yes.setAttribute('aria-label', `Add "${sug.text}"`);
    yes.textContent = '✓';
    yes.addEventListener('click', () => handleSuggestion(sug, true));

    li.append(text, no, yes);
    ul.appendChild(li);
  }
}

function handleSuggestion(sug, accept) {
  const s = state.suggest;
  if (!s.today || s.today.date !== currentDay) s.today = { date: currentDay, handled: [] };
  s.today.handled.push(sug.key);
  if (accept) {
    addItem(sug.text, { suggestFrom: sug.source, date: currentDay });
    showToast('Added to today');
  } else {
    s.dismissed[sug.key] = (s.dismissed[sug.key] || 0) + 1;
    save();
    render();
  }
}

// ---------- First-time questions (hobbies & goals) ----------

let ob = null; // the answers while you're filling them in

function openOnboarding() {
  const p = state.profile || { hobbies: [], goals: [] };
  ob = {
    step: 0,
    hobbies: [...(p.hobbies || [])],
    goals: (p.goals || []).map((g) => ({ ...g })),
    editing: !!state.profile && !state.profile.skipped,
  };
  $('onboard').hidden = false;
  renderOnboarding();
}

function closeOnboarding() {
  $('onboard').hidden = true;
  ob = null;
  if (document.activeElement) document.activeElement.blur();
}

function finishOnboarding(skipped) {
  const firstTime = !ob.editing;
  if (skipped && !ob.editing) {
    state.profile = { hobbies: [], goals: [], skipped: true };
  } else if (!skipped) {
    state.profile = { hobbies: ob.hobbies, goals: ob.goals, answeredAt: Date.now() };
  }
  save();
  closeOnboarding();
  render();
  if (!skipped) {
    if (getSuggestions(state, currentDay).length) setSuggestOpen(true);
    showToast('Saved! Tap 💡 anytime for ideas.');
  }
  if (firstTime) setTimeout(offerReminders, 700);
}

function chip(label, on, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.setAttribute('aria-pressed', String(on));
  b.addEventListener('click', onClick);
  return b;
}

// A list of tap-to-pick chips plus a box to type your own.
function chipPicker(presets, selected, toggle, placeholder) {
  const wrap = document.createElement('div');
  const chips = document.createElement('div');
  chips.className = 'chips';
  const lower = (t) => t.toLowerCase();
  const all = [...presets];
  for (const t of selected) if (!all.some((p) => lower(p) === lower(t))) all.push(t);
  for (const t of all) {
    const on = selected.some((x) => lower(x) === lower(t));
    chips.appendChild(chip(t, on, () => { toggle(t); renderOnboarding(); }));
  }

  const form = document.createElement('form');
  form.className = 'own-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 60;
  input.placeholder = placeholder;
  input.enterKeyHint = 'done';
  const add = document.createElement('button');
  add.type = 'submit';
  add.className = 'btn';
  add.textContent = 'Add';
  form.append(input, add);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = input.value.trim();
    if (!t) return;
    if (!selected.some((x) => lower(x) === lower(t))) toggle(t);
    renderOnboarding();
  });
  wrap.append(chips, form);
  return wrap;
}

const FREQ_LABEL = { daily: 'Daily', few: 'Few times a week', weekly: 'Weekly' };

function renderOnboarding() {
  const body = $('ob-body');
  body.replaceChildren();
  $('ob-step').textContent = `Step ${ob.step + 1} of 3`;
  $('ob-back').style.visibility = ob.step === 0 ? 'hidden' : 'visible';
  $('ob-next').textContent = ob.step === 2 ? (ob.editing ? 'Save' : 'Finish') : 'Next';
  $('ob-skip').textContent = ob.editing ? 'Cancel' : 'Skip';

  if (ob.step === 0) {
    $('ob-title').textContent = ob.editing ? 'Your hobbies' : 'What do you enjoy?';
    $('ob-sub').textContent = 'Pick any hobbies, or type your own. These help the app suggest things you’ll like.';
    body.appendChild(chipPicker(HOBBY_PRESETS, ob.hobbies, (t) => {
      const i = ob.hobbies.findIndex((x) => x.toLowerCase() === t.toLowerCase());
      if (i >= 0) ob.hobbies.splice(i, 1); else ob.hobbies.push(t);
    }, 'Something else…'));
  } else if (ob.step === 1) {
    $('ob-title').textContent = ob.editing ? 'Your goals' : 'What do you want to accomplish?';
    $('ob-sub').textContent = 'Pick goals, or type your own, like “Run a half marathon” or “Learn Spanish”.';
    const texts = ob.goals.map((g) => g.text);
    body.appendChild(chipPicker(GOAL_PRESETS, texts, (t) => {
      const i = ob.goals.findIndex((g) => g.text.toLowerCase() === t.toLowerCase());
      if (i >= 0) ob.goals.splice(i, 1); else ob.goals.push({ id: uid(), text: t, freq: 'few' });
    }, 'Another goal…'));
  } else {
    $('ob-title').textContent = 'How often?';
    $('ob-sub').textContent = 'How often do you want to work on each goal? This decides how often it shows up in suggestions.';
    if (!ob.goals.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No goals picked. That’s fine. You can add some later in Settings.';
      body.appendChild(p);
    }
    for (const g of ob.goals) {
      const row = document.createElement('div');
      row.className = 'freq-row';
      const name = document.createElement('div');
      name.className = 'freq-name';
      name.textContent = g.text;
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const f of ['daily', 'few', 'weekly']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = FREQ_LABEL[f];
        b.setAttribute('aria-checked', String(g.freq === f));
        b.addEventListener('click', () => { g.freq = f; renderOnboarding(); });
        seg.appendChild(b);
      }
      row.append(name, seg);
      body.appendChild(row);
    }
  }
  body.scrollTop = 0;
}

function renderProfileSummary() {
  const p = state.profile;
  const el = $('profile-summary');
  if (!p || (!p.hobbies.length && !p.goals.length)) {
    el.textContent = 'Not set yet.';
    el.className = 'small muted';
  } else {
    el.className = 'small';
    const parts = [];
    if (p.hobbies.length) parts.push('Hobbies: ' + p.hobbies.join(', '));
    if (p.goals.length) parts.push('Goals: ' + p.goals.map((g) => `${g.text} (${FREQ_LABEL[g.freq].toLowerCase()})`).join(', '));
    el.textContent = parts.join(' · ');
  }
  const days = daysOfUse(state);
  $('suggest-status').textContent = days >= SUGGEST_AFTER_DAYS
    ? 'Tap 💡 at the top of the screen for ideas. They also open by themselves each day.'
    : `Tap 💡 at the top of the screen for ideas anytime. After ${SUGGEST_AFTER_DAYS} days of use (you’re at ${days}), they’ll also learn from your habits and open by themselves.`;
}

// ---------- Reminders ----------
//
// Your phone gets a "push address" from Apple. The app sends the reminder
// service a list of upcoming reminders (text + time) for that address, and
// the service sends each notification when it's due.

let swRegistration = null; // the offline helper, which also shows notifications
let lastSyncedJson = null;
let syncTimer = null;

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function atTime(day, hhmm) {
  const d = parseKey(day);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// Which to-dos get reminders: ones that repeat weekly (on particular days,
// or every 2 weeks) or monthly. Every-day repeats and one-time to-dos don't.
const REMIND_EVENING = '20:00'; // the night before
const REMIND_MORNING = '09:00'; // the day itself

function remindsFor(rule) {
  if (!rule || !rule.active) return false;
  if (rule.kind === 'monthly') return true;
  return rule.kind === 'weekly' && rule.days.length > 0 && rule.days.length < 7;
}

// Every reminder coming up in the next 2 weeks: 8 PM the night before
// and 9 AM on the day. Already done (or skipped) days are left out.
function upcomingReminders() {
  const now = Date.now();
  const out = [];
  for (const rule of state.repeats) {
    if (!remindsFor(rule)) continue;
    for (let n = 0; n < 15; n++) {
      const day = addDays(currentDay, n);
      if (!repeatMatches(rule, day)) continue;
      const item = state.items.find((i) => i.repeatId === rule.id && i.date === day);
      if (item && (item.done || item.deleted)) continue;
      const weekday = parseKey(day).toLocaleDateString(undefined, { weekday: 'long' });
      const eve = atTime(addDays(day, -1), REMIND_EVENING);
      const morning = atTime(day, REMIND_MORNING);
      if (eve > now) out.push({ id: `r:${rule.id}:${day}:eve`, at: eve, title: `Tomorrow: ${rule.text}`, body: `Planned for ${weekday}.` });
      if (morning > now) out.push({ id: `r:${rule.id}:${day}:am`, at: morning, title: `Today: ${rule.text}`, body: 'Tap to open your list.' });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 250);
}

function remindersSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription() {
  if (!swRegistration || !remindersSupported()) return null;
  try { return await swRegistration.pushManager.getSubscription(); } catch (e) { return null; }
}

function scheduleReminderSync() {
  if (!state.meta || !state.meta.remindersOn || !REMINDER_API) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncReminders, 1200);
}

async function syncReminders() {
  const sub = await currentSubscription();
  if (!sub) return;
  const reminders = upcomingReminders();
  const json = JSON.stringify(reminders);
  if (json === lastSyncedJson) return;
  try {
    const res = await fetch(REMINDER_API + '/reminders', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), reminders }),
    });
    if (res.ok) lastSyncedJson = json;
  } catch (e) {
    // Offline. We'll try again next time something changes or the app opens.
  }
}

function urlB64ToBytes(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Fetch the service's public key ahead of time, so turning reminders on can
// happen right inside your tap (iPhones require that).
async function prefetchReminderKey() {
  if (!REMINDER_API || state.meta.vapidKey) return;
  try {
    const res = await fetch(REMINDER_API + '/vapid');
    const data = await res.json();
    if (data.publicKey) { state.meta.vapidKey = data.publicKey; save(); }
  } catch (e) { /* offline; try again later */ }
}

function enableReminders() {
  if (isIOS() && !isInstalled()) {
    showToast('Open the app from your home-screen icon to turn on reminders.');
    return;
  }
  if (!remindersSupported() || !swRegistration) {
    showToast('This phone can’t show reminders from web apps. iPhones need iOS 16.4 or newer.');
    return;
  }
  if (!state.meta.vapidKey) {
    showToast('Couldn’t reach the reminder service. Check your internet and try again.');
    prefetchReminderKey();
    return;
  }
  // This asks for permission to show notifications.
  swRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(state.meta.vapidKey) })
    .then(() => {
      state.meta.remindersOn = true;
      lastSyncedJson = null;
      save();
      syncReminders();
      renderReminderSettings();
      renderTimeField();
      showToast('Reminders are on!');
    })
    .catch(() => {
      renderReminderSettings();
      if (Notification.permission === 'denied') {
        showToast('Notifications are blocked. Turn them on in iPhone Settings → Notifications → Ember.');
      } else {
        showToast('Couldn’t turn on reminders. Please try again.');
      }
    });
}

async function disableReminders() {
  const sub = await currentSubscription();
  if (sub) {
    try {
      await fetch(REMINDER_API + '/reminders', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    } catch (e) { /* offline; the service cleans up on its own later */ }
    try { await sub.unsubscribe(); } catch (e) {}
  }
  state.meta.remindersOn = false;
  save();
  renderReminderSettings();
  showToast('Reminders are off');
}

async function sendTestNotification() {
  const sub = await currentSubscription();
  if (!sub) { renderReminderSettings(); return; }
  try {
    const res = await fetch(REMINDER_API + '/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    const data = await res.json();
    showToast(data.ok ? 'Sent! It should appear in a few seconds.' : 'The test didn’t go through. Try turning reminders off and on.');
  } catch (e) {
    showToast('Couldn’t reach the reminder service. Check your internet.');
  }
}

// If you turned notifications off in iPhone Settings, notice it.
async function checkReminderStatus() {
  if (!state.meta.remindersOn) return;
  const sub = await currentSubscription();
  if (!sub && swRegistration) {
    state.meta.remindersOn = false;
    save();
  } else {
    scheduleReminderSync();
  }
}

function reminderState() {
  if (!REMINDER_API) return 'not-setup';
  if (isIOS() && !isInstalled()) return 'not-installed';
  if (!remindersSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return state.meta.remindersOn ? 'on' : 'off';
}

function renderReminderSettings() {
  const st = reminderState();
  const text = {
    'not-setup': 'Reminders aren’t set up yet. They’re coming soon.',
    'not-installed': 'To get reminders, open this app from its home-screen icon (not from Safari).',
    unsupported: 'This phone can’t show reminders from web apps. iPhones need iOS 16.4 or newer.',
    blocked: 'Notifications are blocked for this app. Turn them on in iPhone Settings → Notifications → Ember.',
    on: 'Reminders are on. To-dos that repeat weekly or monthly remind you at 8 PM the night before and 9 AM on the day.',
    off: 'Get reminded about to-dos that repeat weekly or monthly: 8 PM the night before and 9 AM on the day.',
  }[st];
  $('remind-status').textContent = text;
  $('remind-on').hidden = st !== 'off';
  $('remind-test').hidden = st !== 'on';
  $('remind-off').hidden = st !== 'on';
}

function renderTimeField() {
  const hasTime = !!$('edit-time').value;
  $('edit-time-clear').hidden = !hasTime;
  const st = reminderState();
  $('remind-note').hidden = !(hasTime && st !== 'on' && st !== 'not-setup');
  if (st === 'off') {
    $('remind-note').firstElementChild.textContent = 'Reminders are off on this phone.';
    $('remind-note-on').hidden = false;
  } else {
    $('remind-note').firstElementChild.textContent = {
      'not-installed': 'Open the app from your home screen to get reminders.',
      unsupported: 'This phone can’t show reminders.',
      blocked: 'Notifications are blocked in iPhone Settings.',
    }[st] || '';
    $('remind-note-on').hidden = true;
  }
}

// ---------- Backup nudge ----------

const BACKUP_EVERY_DAYS = 14;

function daysSinceBackup() {
  const last = state.meta.lastBackupAt ? dateKey(new Date(state.meta.lastBackupAt)) : (state.meta.firstUseDate || currentDay);
  return dayNumber(currentDay) - dayNumber(last);
}

function renderBackupNudge() {
  const due = !viewTomorrow
    && state.items.filter((i) => !i.deleted).length >= 5
    && state.meta.backupSnoozeDay !== currentDay
    && daysSinceBackup() >= BACKUP_EVERY_DAYS;
  $('backup-nudge').hidden = !due;
  if (due) {
    $('nudge-title').textContent = state.meta.lastBackupAt
      ? `💾 It's been ${daysSinceBackup()} days since your last backup`
      : '💾 Time to save your first backup';
  }
}

// ---------- Celebration (when you finish the whole day) ----------

// Runs once the day-complete or milestone screen closes (e.g. to offer Undo).
let afterCelebration = null;

function celebrate(after) {
  const info = streakInfo();
  const n = info.streak;
  afterCelebration = after || null;
  playSound('complete');
  const pill = $('streak');
  pill.classList.remove('bump');
  void pill.offsetWidth;
  pill.classList.add('bump');
  if (MILESTONES[n] && state.meta.milestoneShown !== `${currentDay}:${n}`) {
    state.meta.milestoneShown = `${currentDay}:${n}`;
    save();
    showMilestone(n, info.earnedToday);
    return;
  }
  showDayComplete(n, info.earnedToday);
}

function finishCelebration() {
  const after = afterCelebration;
  afterCelebration = null;
  if (after) after();
}

// ---------- Day complete: the flame flares up ----------

const DAYEND_MS = 2600;
let dayEndTimer = null;

function showDayComplete(n, earnedFreeze) {
  const box = $('dayend');
  const num = $('dayend-num');
  const from = Math.max(0, n - 1);
  num.textContent = from;
  $('dayend-unit').textContent = n === 1 ? 'day in a row' : 'days in a row';
  $('dayend-freeze').hidden = !earnedFreeze;
  box.classList.remove('leaving', 'counted');
  box.hidden = false;
  void box.offsetWidth; // restart the animations
  box.classList.add('playing');
  haptic();
  // Count up as the flame peaks.
  setTimeout(() => { num.textContent = n; box.classList.add('counted'); }, 650);
  clearTimeout(dayEndTimer);
  dayEndTimer = setTimeout(closeDayComplete, DAYEND_MS);
}

function closeDayComplete() {
  const box = $('dayend');
  if (box.hidden || box.classList.contains('leaving')) return;
  clearTimeout(dayEndTimer);
  box.classList.add('leaving');
  setTimeout(() => {
    box.hidden = true;
    box.classList.remove('playing', 'leaving', 'counted');
    finishCelebration();
  }, 450);
}

function burstConfetti(count, originY = 0.38) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !document.body.animate) return;
  const colors = ['#ff8a3d', '#e2622a', '#ffd166', '#ffb347', '#e5484d', '#fff4e6'];
  const box = document.createElement('div');
  box.className = 'confetti';
  box.setAttribute('aria-hidden', 'true');
  document.body.appendChild(box);
  const w = window.innerWidth;
  for (let k = 0; k < count; k++) {
    const piece = document.createElement('i');
    piece.style.background = colors[k % colors.length];
    piece.style.left = `${w / 2}px`;
    piece.style.top = `${originY * 100}%`;
    if (k % 3 === 0) piece.style.borderRadius = '50%';
    box.appendChild(piece);
    const angle = (Math.random() * 140 + 200) * (Math.PI / 180); // mostly upward
    const power = 220 + Math.random() * 260;
    const dx = Math.cos(angle) * power;
    const up = Math.sin(angle) * power;
    const fall = window.innerHeight * (0.55 + Math.random() * 0.35);
    piece.animate([
      { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx * 0.8}px, ${up}px) rotate(${Math.random() * 360}deg)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${dx}px, ${fall}px) rotate(${Math.random() * 900}deg)`, opacity: 0 },
    ], { duration: 1600 + Math.random() * 900, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)', fill: 'forwards' });
  }
  setTimeout(() => box.remove(), 2700);
}

// ---------- Milestones (7, 30, 100, 365 days) ----------

const MILESTONES = {
  7: 'A whole week. You’re on fire.',
  30: 'Thirty days! This is a habit now.',
  100: 'One hundred days. Legendary.',
  365: 'A full year. Incredible.',
};

function showMilestone(n, earnedFreeze) {
  $('milestone-num').textContent = `${n}-day streak!`;
  $('milestone-msg').textContent = MILESTONES[n] + (earnedFreeze ? ' You earned a ❄️ freeze too.' : '');
  $('milestone').hidden = false;
  playSound('milestone');
  haptic();
  burstConfetti(110, 0.42);
  setTimeout(() => burstConfetti(90, 0.3), 450);
}

// ---------- Sounds (optional, off by default) ----------

let audioCtx = null;

function playSound(kind) {
  if (!state.meta.sounds) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const tone = (freq, start, length, volume, endFreq) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + start);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + start + length * 0.6);
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(volume, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + length);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + length + 0.02);
    };
    if (kind === 'check') tone(660, 0, 0.13, 0.16, 990);                    // soft pop
    if (kind === 'complete') [1047, 1319, 1568].forEach((f, k) => tone(f, k * 0.09, 0.32, 0.11)); // little chime
    if (kind === 'milestone') [784, 988, 1175, 1568].forEach((f, k) => tone(f, k * 0.11, 0.5, 0.12));
  } catch (e) { /* no sound available */ }
}

// ---------- Weekly recap (Sundays) ----------

function weeklyRecap() {
  const days = Array.from({ length: 7 }, (_, k) => addDays(currentDay, k - 7)); // last Sunday → yesterday
  const byDay = dayStats();
  let finished = 0, completeDays = 0, planned = 0, best = null;
  for (const d of days) {
    const st = byDay.get(d);
    if (!st) continue;
    planned++;
    finished += st.done;
    if (dayStatus(d, byDay) === 'complete') completeDays++;
    if (!best || st.done > best.done) best = { day: d, done: st.done };
  }
  if (planned < 2) return null;
  let lastWeek = 0;
  for (let k = 8; k <= 14; k++) { const st = byDay.get(addDays(currentDay, -k)); if (st) lastWeek += st.done; }
  // Most consistent: the to-do you finished on the most different days.
  const counts = new Map();
  for (const i of state.items) {
    if (!i.done || i.deleted || i.date < days[0] || i.date >= currentDay) continue;
    const key = normText(i.text);
    const e = counts.get(key) || { text: i.text, days: new Set() };
    e.days.add(i.date);
    counts.set(key, e);
  }
  const habit = [...counts.values()].sort((a, b) => b.days.size - a.days.size)[0];
  return {
    finished, lastWeek, completeDays,
    best: best && best.done ? best : null,
    habit: habit && habit.days.size >= 3 ? habit : null,
    streak: computeStreak(byDay),
  };
}

function renderRecap() {
  const card = $('recap');
  const show = !viewTomorrow && parseKey(currentDay).getDay() === 0 && state.meta.recapSeen !== currentDay;
  const r = show ? weeklyRecap() : null;
  card.hidden = !r;
  if (!r) return;
  const lines = [];
  const diff = r.finished - r.lastWeek;
  lines.push([`✅ ${r.finished} to-dos finished`, r.lastWeek ? (diff > 0 ? `${diff} more than last week` : diff < 0 ? `${-diff} fewer than last week` : 'same as last week') : '']);
  lines.push([`🔥 ${r.completeDays} of 7 days complete`, r.streak > 1 ? `streak: ${r.streak} days` : '']);
  if (r.best) lines.push([`⭐ Best day: ${parseKey(r.best.day).toLocaleDateString(undefined, { weekday: 'long' })}`, `${r.best.done} done`]);
  if (r.habit) lines.push([`💪 Most consistent: ${r.habit.text}`, `${r.habit.days.size} days`]);
  const list = $('recap-list');
  list.replaceChildren(...lines.map(([main, sub]) => {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = main;
    li.appendChild(a);
    if (sub) { const b = document.createElement('em'); b.textContent = sub; li.appendChild(b); }
    return li;
  }));
}

// ---------- Share a list ----------

function listAsText() {
  const day = viewDay();
  const items = sortedItems(itemsForDay(day));
  const title = parseKey(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  return `${title}\n\n` + items.map((i) => `${i.done ? '✓' : '○'} ${i.text}`).join('\n');
}

async function shareList() {
  const text = listAsText();
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // you closed the share menu
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('List copied. Paste it anywhere.');
  } catch (e) {
    showToast('Couldn’t share from this browser.');
  }
}

// ---------- Progress panel (tap the streak) ----------

function renderProgress() {
  const byDay = dayStats();
  const info = streakInfo(byDay);
  $('stat-streak').textContent = info.streak;
  $('stat-best').textContent = info.best;
  $('stat-freezes').textContent = `${info.freezes}/${FREEZE_MAX}`;
  $('how-list').hidden = true;
  $('how-streaks').textContent = 'How streaks work';
  $('how-streaks').setAttribute('aria-expanded', 'false');
  let total = 0, done = 0;
  for (let k = 0; k < 7; k++) {
    const s = byDay.get(addDays(currentDay, -k));
    if (s) { total += s.total; done += s.done; }
  }
  $('stat-week').textContent = total ? `${Math.round((done / total) * 100)}%` : '–';

  renderCalendar(byDay, info);
}

// ----- Calendar: one month at a time, tap any day -----

let calMonth = null; // first day of the month on screen, e.g. '2026-10-01'
const CAL_MONTHS_AHEAD = 12;

function monthStart(day) {
  return day.slice(0, 8) + '01';
}
function shiftMonth(key, n) {
  const d = parseKey(key);
  return dateKey(new Date(d.getFullYear(), d.getMonth() + n, 1));
}

function calStatus(day, byDay, info) {
  const first = state.meta.firstUseDate || currentDay;
  if (day > currentDay) return isRestDay(day) ? 'rest future-rest' : 'future';
  if (day < first) return 'before';
  if (isRestDay(day)) return 'rest';
  if (day === currentDay) return dayStatus(day, byDay) === 'complete' ? 'complete' : 'pending';
  if (info.frozen.has(day)) return 'frozen';
  return dayStatus(day, byDay) === 'empty' ? 'missed' : dayStatus(day, byDay);
}

function renderCalendar(byDay = dayStats(), info = streakInfo(byDay)) {
  if (!calMonth) calMonth = monthStart(currentDay);
  const firstMonth = monthStart(state.meta.firstUseDate || currentDay);
  const lastMonth = shiftMonth(monthStart(currentDay), CAL_MONTHS_AHEAD);
  const m = parseKey(calMonth);
  $('cal-title').textContent = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('cal-prev').disabled = calMonth <= firstMonth;
  $('cal-next').disabled = calMonth >= lastMonth;

  // Weekday letters, starting on Sunday like the iPhone calendar.
  const head = document.querySelector('.cal-head');
  head.replaceChildren(...DAY_LETTERS.map((l) => { const s = document.createElement('span'); s.textContent = l; return s; }));

  const cal = $('cal');
  cal.replaceChildren();
  for (let k = 0; k < m.getDay(); k++) cal.appendChild(document.createElement('span'));
  const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  for (let n = 1; n <= days; n++) {
    const day = dateKey(new Date(m.getFullYear(), m.getMonth(), n));
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.textContent = n;
    const cls = calStatus(day, byDay, info);
    cell.className = cls + (day === currentDay ? ' today' : '');
    if (day > currentDay && itemsForDay(day).some((i) => !i.done)) cell.classList.add('planned');
    const label = { complete: 'finished everything', partial: 'partly done', missed: 'missed', pending: 'in progress', frozen: 'saved by a freeze', rest: 'rest day', 'rest future-rest': 'rest day', future: '', before: '' }[cls];
    cell.setAttribute('aria-label', parseKey(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (label ? `: ${label}` : ''));
    cell.addEventListener('click', () => openDay(day));
    cal.appendChild(cell);
  }
}

// ----- One day from the calendar -----
// Past days show what got done. Days ahead let you plan things in advance.
// Today and tomorrow just jump to the main list, which already does it all.

let dayOpen = null;

function openDay(day) {
  if (day === currentDay || day === addDays(currentDay, 1)) {
    closeSheets();
    setView(day !== currentDay);
    render();
    return;
  }
  dayOpen = day;
  $('progress-sheet').hidden = true;
  $('day-input').value = '';
  renderDay();
  openSheet('day-sheet');
}

function dayRow(text, opts = {}) {
  const li = document.createElement('li');
  if (opts.cls) li.className = opts.cls;
  const mark = document.createElement('span');
  mark.className = 'day-mark';
  mark.textContent = opts.mark || '';
  const body = document.createElement('span');
  body.className = 'carry-text';
  body.textContent = text;
  if (opts.note) {
    const note = document.createElement('span');
    note.className = 'carry-date';
    note.textContent = opts.note;
    body.appendChild(note);
  }
  li.append(mark, body);
  if (opts.button) li.appendChild(opts.button);
  return li;
}

function shortDay(day) {
  return parseKey(day).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function renderDay() {
  const day = dayOpen;
  if (!day) return;
  const ahead = day > currentDay;
  const first = state.meta.firstUseDate || currentDay;
  $('day-title').textContent = parseKey(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('day-add').hidden = !ahead;

  const items = sortedItems(itemsForDay(day));
  const list = $('day-list');
  list.replaceChildren();
  let sub;

  if (ahead) {
    // Repeating to-dos aren't on that day's list yet; they show up when the day comes.
    const seen = new Set(items.map((i) => normText(i.text)));
    const repeats = state.repeats.filter((r) => {
      if (!repeatMatches(r, day) || items.some((i) => i.repeatId === r.id) || seen.has(normText(r.text))) return false;
      seen.add(normText(r.text));
      return true;
    });
    for (const i of items) {
      const x = document.createElement('button');
      x.className = 'mini';
      x.textContent = 'Remove';
      x.setAttribute('aria-label', `Remove ${i.text}`);
      x.addEventListener('click', () => {
        i.deleted = true;
        save();
        renderDay();
        render();
        showToast('Removed', 'Undo', () => { i.deleted = false; save(); renderDay(); render(); });
      });
      list.appendChild(dayRow(i.text, { mark: '○', button: x, note: i.repeatId ? '↻ Repeats' : '' }));
    }
    for (const r of repeats) list.appendChild(dayRow(r.text, { mark: '↻', cls: 'repeat', note: describeRepeat(r) }));
    const n = items.length + repeats.length;
    sub = n ? `${n} planned` : 'Nothing planned yet. Add something below.';
    if (isRestDay(day)) sub = '😴 Rest day. ' + sub;
  } else if (day < first) {
    sub = 'This was before you started using Ember.';
  } else {
    const done = items.filter((i) => i.done);
    for (const i of items) {
      list.appendChild(dayRow(i.text, {
        mark: i.done ? '✓' : '○',
        cls: i.done ? 'did' : 'didnt',
        note: i.done && i.doneAt ? 'Done ' + new Date(i.doneAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '',
      }));
    }
    const moved = state.items.filter((i) => !i.deleted && i.movedFrom === day && i.date !== day);
    for (const i of moved) list.appendChild(dayRow(i.text, { mark: '→', cls: 'moved', note: `Moved to ${shortDay(i.date)}` }));
    const info = streakInfo();
    if (isRestDay(day)) sub = '😴 Rest day';
    else if (!items.length) sub = info.frozen.has(day) ? '❄️ Nothing done, but a freeze saved your streak' : 'Nothing was planned';
    else if (done.length === items.length) sub = `Finished everything (${items.length})`;
    else sub = `${done.length} of ${items.length} done` + (info.frozen.has(day) ? ' · ❄️ saved by a freeze' : '');
  }
  $('day-sub').textContent = sub;
}

function addForDay() {
  const text = $('day-input').value.trim();
  if (!text || !dayOpen) return;
  addItem(text, { date: dayOpen });
  $('day-input').value = '';
  renderDay();
  showToast(`Added for ${shortDay(dayOpen)}`);
}

// ---------- Welcome tour ----------

let tourMode = 'first'; // 'first' = new person (leads into the questions), 'replay' = from Settings

function openTour(mode) {
  tourMode = mode;
  $('tour').hidden = false;
  $('tour-track').scrollLeft = 0;
  const dots = $('tour-dots');
  dots.replaceChildren(...[...$('tour-track').children].map(() => document.createElement('i')));
  updateTour();
}

function tourIndex() {
  const track = $('tour-track');
  return Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
}

function updateTour() {
  const i = tourIndex();
  const last = $('tour-track').children.length - 1;
  [...$('tour-dots').children].forEach((d, k) => d.classList.toggle('on', k === i));
  $('tour-back').style.visibility = i === 0 ? 'hidden' : 'visible';
  $('tour-next').textContent = i < last ? 'Next' : tourMode === 'first' ? 'Get started' : 'Done';
  $('tour-skip').style.visibility = i < last ? 'visible' : 'hidden';
}

function goToSlide(i) {
  const track = $('tour-track');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  track.scrollTo({ left: i * track.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
}

function finishTour() {
  $('tour').hidden = true;
  state.meta.tourSeen = true;
  save();
  if (tourMode === 'first' && !state.profile) openOnboarding();
}

// What a brand-new person sees after the splash.
function startFirstRun() {
  if (state.profile) return;
  if (state.meta.tourSeen) { openOnboarding(); return; }
  if (isIOS() && !isInstalled()) $('install-page').hidden = false;
  else openTour('first');
}

// ---------- "Want reminders?" pop-up ----------
// Shown once: to new people right after the first-time questions, and to
// anyone else who hasn't turned reminders on yet. Only where they can work.

function canOfferReminders() {
  return !state.meta.remindPromptSeen && reminderState() === 'off' && !!swRegistration;
}

function offerReminders() {
  if (!canOfferReminders()) return;
  // Don't pop up over the tour, the questions or an open panel.
  const busy = !$('tour').hidden || !$('onboard').hidden || !$('install-page').hidden ||
    !$('edit-sheet').hidden || !$('settings-sheet').hidden || !$('progress-sheet').hidden || !$('milestone').hidden;
  if (busy) return;
  prefetchReminderKey();
  $('remind-prompt').hidden = false;
}

function closeReminderPrompt() {
  $('remind-prompt').hidden = true;
  state.meta.remindPromptSeen = true;
  save();
}

// ---------- Settings panel ----------

function renderRepeatList() {
  const list = $('repeat-list');
  list.replaceChildren();
  const active = state.repeats.filter((r) => r.active);
  if (!active.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'None yet. Open any to-do and choose Daily or Weekly.';
    list.appendChild(li);
    return;
  }
  for (const rule of active) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 'r-text';
    t.textContent = rule.text;
    const when = document.createElement('span');
    when.className = 'r-when';
    when.textContent = describeRepeat(rule);
    t.appendChild(when);
    const stop = document.createElement('button');
    stop.className = 'mini';
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => {
      rule.active = false;
      save();
      renderRepeatList();
      render();
      showToast(`"${rule.text}" won't repeat anymore`, 'Undo', () => {
        rule.active = true; save(); renderRepeatList(); render();
      });
    });
    li.append(t, stop);
    list.appendChild(li);
  }
}

async function exportBackup() {
  const json = JSON.stringify(state, null, 2);
  const name = `ember-backup-${dateKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Ember backup' });
      backupDone();
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // you closed the share menu
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  backupDone();
}

function backupDone() {
  state.meta.lastBackupAt = Date.now();
  save();
  render();
  showToast('Backup saved 👍');
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!isValidState(data)) throw new Error('bad file');
      if (!confirm('Replace everything in the app with this backup?')) return;
      state = upgrade(data);
      save();
      runDailyCheck();
      renderRepeatList();
      showToast('Backup restored');
    } catch (e) {
      showToast("That file isn't a backup from this app.");
    }
  };
  reader.readAsText(file);
}

// ---------- Sheets & toast ----------

function openSheet(id) {
  $('edit-backdrop').hidden = false;
  $(id).hidden = false;
}
function closeSheets() {
  $('edit-backdrop').hidden = true;
  $('edit-sheet').hidden = true;
  $('settings-sheet').hidden = true;
  $('progress-sheet').hidden = true;
  $('day-sheet').hidden = true;
  dayOpen = null;
  editing = null;
  if (document.activeElement) document.activeElement.blur();
}

let toastTimer = null;
function showToast(text, actionLabel, action) {
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = () => { hideToast(); if (action) action(); };
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, actionLabel ? 5000 : 3000);
}
function hideToast() { $('toast').hidden = true; }

// ---------- Daily check (runs on open and when the day changes) ----------

function runDailyCheck() {
  const previousDay = currentDay;
  currentDay = dateKey();
  if (currentDay !== previousDay) viewTomorrow = false;
  if (!state.meta.firstUseDate) state.meta.firstUseDate = currentDay;
  let added = false;
  // Fill in repeating to-dos for days the app wasn't opened, so those days
  // still count (as missed) instead of looking like nothing was planned.
  const last = state.meta.lastOpenDate;
  if (last && last < currentDay) {
    let day = addDays(last, 1);
    const floor = addDays(currentDay, -60);
    if (day < floor) day = floor;
    for (; day < currentDay; day = addDays(day, 1)) if (addRepeatItemsFor(day)) added = true;
  }
  if (mergeDuplicateRepeats()) added = true;
  if (addRepeatItemsFor(currentDay)) added = true;
  if (viewTomorrow && addRepeatItemsFor(addDays(currentDay, 1))) added = true;
  // Let you know if a freeze kept your streak alive since you last looked.
  const frozenDays = [...streakInfo().frozen].sort();
  const newest = frozenDays[frozenDays.length - 1];
  if (newest && newest > (state.meta.freezeNotice || '')) {
    state.meta.freezeNotice = newest;
    added = true;
    setTimeout(() => showToast(`❄️ A freeze saved your streak (${friendlyDate(newest)})`), 2600);
  }
  if (added || state.meta.lastOpenDate !== currentDay) {
    state.meta.lastOpenDate = currentDay;
    save();
  }
  render();
}

// ---------- Wire up buttons ----------

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('add-input');
  addFromInput(input.value);
  input.value = '';
  quickIgnored = false;
  renderQuickHint();
});
$('add-input').addEventListener('input', () => {
  if (!$('add-input').value.trim()) quickIgnored = false;
  renderQuickHint();
});
$('quick-hint-off').addEventListener('click', () => { quickIgnored = true; renderQuickHint(); $('add-input').focus(); });

$('edit-priority').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !editing) return;
  editing.priority = b.dataset.value;
  setSeg('edit-priority', editing.priority);
});
$('edit-repeat').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !editing) return;
  editing.repeatKind = b.dataset.value;
  setSeg('edit-repeat', editing.repeatKind);
  renderDays();
});
$('edit-every').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !editing) return;
  editing.every = Number(b.dataset.value);
  renderDays();
});
$('edit-weekdays').addEventListener('click', () => { if (editing) { editing.days = [1, 2, 3, 4, 5]; renderDays(); } });
$('edit-dom').replaceChildren(...Array.from({ length: 31 }, (_, k) => {
  const o = document.createElement('option'); o.value = String(k + 1); o.textContent = ordinal(k + 1); return o;
}));
$('edit-dom').addEventListener('change', () => { if (editing) { editing.dom = Number($('edit-dom').value); renderDays(); } });
$('edit-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveEdit(); });
$('edit-save').addEventListener('click', saveEdit);
$('edit-cancel').addEventListener('click', closeSheets);
$('edit-backdrop').addEventListener('click', closeSheets);
$('edit-delete').addEventListener('click', () => {
  const item = state.items.find((i) => i.id === editing.id);
  const repeating = item && item.repeatId && state.repeats.some((r) => r.id === item.repeatId && r.active);
  if (repeating) {
    $('delete-choice').hidden = false;
    return;
  }
  const id = editing.id;
  closeSheets();
  deleteItem(id);
});
$('delete-today').addEventListener('click', () => { const id = editing.id; closeSheets(); deleteItem(id); });
$('delete-series').addEventListener('click', () => { const id = editing.id; closeSheets(); deleteItem(id, { stopRepeating: true }); });

$('carry-bring-all').addEventListener('click', () => {
  for (const i of pendingCarryOver()) carryOver(i.id, true);
  save(); render();
});
$('carry-drop-all').addEventListener('click', () => {
  for (const i of pendingCarryOver()) carryOver(i.id, false);
  save(); render();
});

function setView(tomorrow) {
  if (viewTomorrow === tomorrow) return;
  viewTomorrow = tomorrow;
  if (tomorrow && addRepeatItemsFor(addDays(currentDay, 1))) save();
  render();
}
$('view-today').addEventListener('click', () => setView(false));
$('recap-ok').addEventListener('click', () => { state.meta.recapSeen = currentDay; save(); render(); });
$('milestone-ok').addEventListener('click', () => { $('milestone').hidden = true; finishCelebration(); });
$('dayend').addEventListener('click', closeDayComplete);
$('share-list').addEventListener('click', shareList);
$('sound-toggle').addEventListener('change', (e) => {
  state.meta.sounds = e.target.checked;
  save();
  if (state.meta.sounds) playSound('check');
});
$('wrapup-later').addEventListener('click', () => { state.meta.wrapUpDismissed = currentDay; save(); render(); });
$('wrapup-all').addEventListener('click', () => {
  const items = wrapUpItems();
  const undo = clearForTonight(items);
  afterWrapUp(`Moved ${items.length} to tomorrow`, undo);
});
$('view-tomorrow').addEventListener('click', () => setView(true));
$('streak').addEventListener('click', () => { calMonth = null; renderProgress(); openSheet('progress-sheet'); });
$('progress-close').addEventListener('click', closeSheets);
$('cal-prev').addEventListener('click', () => { calMonth = shiftMonth(calMonth, -1); renderCalendar(); });
$('cal-next').addEventListener('click', () => { calMonth = shiftMonth(calMonth, 1); renderCalendar(); });
$('day-close').addEventListener('click', closeSheets);
$('day-back').addEventListener('click', () => {
  $('day-sheet').hidden = true;
  dayOpen = null;
  renderProgress();
  $('progress-sheet').hidden = false;
});
$('day-add').addEventListener('submit', (e) => { e.preventDefault(); addForDay(); });
$('how-streaks').addEventListener('click', () => {
  const open = $('how-list').hidden;
  $('how-list').hidden = !open;
  $('how-streaks').setAttribute('aria-expanded', String(open));
  $('how-streaks').textContent = open ? 'Hide' : 'How streaks work';
  if (open) $('how-list').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
$('nudge-save').addEventListener('click', exportBackup);
$('nudge-later').addEventListener('click', () => { state.meta.backupSnoozeDay = currentDay; save(); render(); });

$('dismiss-tip').addEventListener('click', () => { state.meta.tipDismissed = true; save(); render(); });

$('open-settings').addEventListener('click', () => {
  $('sound-toggle').checked = !!state.meta.sounds; renderRepeatList(); renderProfileSummary(); renderReminderSettings(); openSheet('settings-sheet'); });
$('remind-on').addEventListener('click', enableReminders);
$('remind-note-on').addEventListener('click', enableReminders);
$('remind-off').addEventListener('click', disableReminders);
$('remind-test').addEventListener('click', sendTestNotification);
$('edit-time').addEventListener('input', renderTimeField);
$('edit-time').addEventListener('change', renderTimeField);
$('edit-time-clear').addEventListener('click', () => { $('edit-time').value = ''; renderTimeField(); });
$('edit-profile').addEventListener('click', () => { closeSheets(); openOnboarding(); });
$('open-suggest').addEventListener('click', () => {
  if (viewTomorrow) { viewTomorrow = false; suggestOpen = null; render(); }
  if (suggestCardWanted() && !$('suggest').hidden) { setSuggestOpen(false); return; }
  if (getSuggestions(state, currentDay).length) { setSuggestOpen(true); return; }
  const p = state.profile;
  if (!p || (!p.hobbies.length && !p.goals.length)) {
    showToast('Add some hobbies or goals so there’s something to suggest.');
    openOnboarding();
  } else {
    showToast('That’s all the ideas for today. More tomorrow!');
  }
});
$('suggest-hide').addEventListener('click', () => setSuggestOpen(false));

$('tour-track').addEventListener('scroll', () => requestAnimationFrame(updateTour), { passive: true });
$('tour-next').addEventListener('click', () => {
  const i = tourIndex();
  if (i < $('tour-track').children.length - 1) goToSlide(i + 1); else finishTour();
});
$('tour-back').addEventListener('click', () => goToSlide(Math.max(0, tourIndex() - 1)));
$('tour-skip').addEventListener('click', finishTour);
$('replay-tour').addEventListener('click', () => { closeSheets(); openTour('replay'); });
$('install-continue').addEventListener('click', () => { $('install-page').hidden = true; openTour('first'); });
window.addEventListener('resize', () => { if (!$('tour').hidden) goToSlide(tourIndex()); });

$('remind-prompt-yes').addEventListener('click', () => { closeReminderPrompt(); enableReminders(); });
$('remind-prompt-no').addEventListener('click', () => {
  closeReminderPrompt();
  showToast('No problem. You can turn reminders on anytime in •••.');
});

$('ob-next').addEventListener('click', () => {
  if (ob.step < 2) { ob.step++; renderOnboarding(); } else finishOnboarding(false);
});
$('ob-back').addEventListener('click', () => { if (ob.step > 0) { ob.step--; renderOnboarding(); } });
$('ob-skip').addEventListener('click', () => finishOnboarding(true));
$('settings-close').addEventListener('click', closeSheets);
$('export-btn').addEventListener('click', exportBackup);
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importBackup(f);
  e.target.value = '';
});
$('erase-btn').addEventListener('click', () => {
  if (!confirm('Erase every to-do, repeat and streak? This cannot be undone.')) return;
  if (!confirm('Are you sure? Consider saving a backup first.')) return;
  state = freshState();
  save();
  closeSheets();
  runDailyCheck();
  startFirstRun();
});
$('version').textContent = APP_VERSION;
$('time-section').hidden = true; // one-time to-dos don't send reminders
$('remind-section').hidden = !REMINDER_API;

// Re-check when you come back to the app (it may be a new day).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { runDailyCheck(); checkReminderStatus(); }
});
setInterval(() => {
  if (dateKey() !== currentDay) runDailyCheck();
  else if (wrapUpWanted() === $('wrapup').hidden) render(); // 8 PM arrived while the app was open
}, 60 * 1000);

runDailyCheck();
startFirstRun();
// Offer reminders to people who already use Ember (after the splash).
if (state.profile && 'serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(() => setTimeout(offerReminders, 2600));
}

// ---------- Press-down feel for every button ----------
// Adds a "pressed" look the moment your finger lands, and keeps it long
// enough to see even on a quick tap. Moving your finger (scrolling or
// swiping) cancels it.
(function pressFeel() {
  const SELECTOR = 'button, .chip, label.btn';
  const MIN_MS = 120;
  let current = null, downAt = 0, startX = 0, startY = 0;
  const release = () => {
    if (!current) return;
    const el = current;
    current = null;
    setTimeout(() => el.classList.remove('pressed'), Math.max(0, MIN_MS - (Date.now() - downAt)));
  };
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(SELECTOR);
    if (!el || el.disabled || el.classList.contains('check')) return;
    current = el; downAt = Date.now(); startX = e.clientX; startY = e.clientY;
    el.classList.add('pressed');
  }, { passive: true });
  document.addEventListener('pointermove', (e) => {
    if (current && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
      current.classList.remove('pressed');
      current = null;
    }
  }, { passive: true });
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  // iPhones only show :active styles when a touch listener exists.
  document.addEventListener('touchstart', () => {}, { passive: true });
})();

// ---------- Splash screen ----------
// Shown for about a second when the app opens, then it fades away.
(function hideSplash() {
  const splash = $('splash');
  if (!splash) return;
  const SPLASH_MS = 2000;
  setTimeout(() => {
    splash.classList.add('leaving');
    document.documentElement.classList.remove('booting');
    setTimeout(() => splash.remove(), 650);
  }, Math.max(0, SPLASH_MS - performance.now()));
})();

// ---------- Offline support ----------
if ('serviceWorker' in navigator) {
  // When a new version of the app finishes downloading, reload once so you
  // see it right away instead of on the next launch.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    navigator.serviceWorker.ready.then((reg) => {
      swRegistration = reg;
      prefetchReminderKey();
      checkReminderStatus();
    });
  });
}
