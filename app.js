'use strict';

// ============================================================
//  Today — a simple to-do list that lives on your phone.
//  All data is kept in this browser's local storage.
// ============================================================

const APP_VERSION = '1.9.0';
// The reminder service's web address. Reminders are switched off (and hidden
// in the app) while this is empty. To turn them on, install the service in
// worker/ on Cloudflare and put its address here.
const REMINDER_API = '';
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

function repeatMatches(rule, day) {
  if (!rule.active || day < rule.startDate) return false;
  if (rule.kind === 'daily') return true;
  return rule.days.includes(parseKey(day).getDay());
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

function describeRepeat(rule) {
  if (rule.kind === 'daily') return 'Every day';
  const days = [...rule.days].sort((a, b) => a - b);
  if (days.length === 7) return 'Every day';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  return 'Every ' + days.map((d) => DAY_SHORT[d]).join(', ');
}

// ---------- Queries ----------

function itemsForDay(day) {
  return state.items.filter((i) => i.date === day && !i.deleted);
}

function sortedItems(items) {
  const rank = (p) => (p in PRIORITY_RANK ? PRIORITY_RANK[p] : 3);
  const open = items.filter((i) => !i.done).sort((a, b) => rank(a.priority) - rank(b.priority) || a.createdAt - b.createdAt);
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
  state.items.push({
    id: uid(), text, date: extra.date || viewDay(), done: false, doneAt: null,
    priority: guess, prioritySource: guess ? 'guess' : null,
    repeatId: null, createdAt: Date.now(), ...extra,
  });
  save();
  render();
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
  if (item.done) haptic();

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
    if (item.repeatId) {
      const note = document.createElement('span');
      note.className = 'carry-date';
      note.textContent = '↻ Comes back tomorrow';
      text.appendChild(note);
    }
    const btn = document.createElement('button');
    btn.className = 'mini yes';
    btn.textContent = item.repeatId ? 'Skip' : 'Tomorrow';
    btn.addEventListener('click', () => {
      const undo = clearForTonight([item]);
      afterWrapUp(item.repeatId ? 'Skipped for today' : 'Moved to tomorrow', undo);
    });
    li.append(text, btn);
    list.appendChild(li);
  }
}

// Moves one-time to-dos to tomorrow and skips today's repeating ones.
// Returns a function that undoes it.
function clearForTonight(items) {
  const tomorrow = addDays(currentDay, 1);
  const before = items.map((i) => ({ item: i, date: i.date, deleted: i.deleted }));
  for (const i of items) {
    if (i.repeatId) i.deleted = true;
    else { i.date = tomorrow; i.movedFrom = currentDay; }
  }
  save();
  return () => {
    for (const b of before) { b.item.date = b.date; b.item.deleted = b.deleted; delete b.item.movedFrom; }
    save();
    render();
  };
}

function afterWrapUp(message, undo) {
  render();
  const today = itemsForDay(currentDay);
  if (today.length && today.every((i) => i.done)) {
    // Everything left is done now, so the day counts. Celebrate, but keep Undo.
    celebrate();
    setTimeout(() => showToast(`${message} · Day complete! 🔥 ${computeStreak()}`, 'Undo', undo), 350);
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

const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
    if (meta.length) {
      const m = document.createElement('span');
      m.className = 'item-meta';
      m.textContent = meta.join(' · ');
      body.appendChild(m);
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
  $('swipe-hint').hidden = !(items.length > 0 && items.length <= 3);
}

// Swipe left on an item to delete it.
function enableSwipe(row, item) {
  let startX = 0, startY = 0, dx = 0, mode = null; // mode: null | 'swipe' | 'scroll'

  row.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; dx = 0; mode = null;
    delete row.dataset.swiped;
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const mx = t.clientX - startX, my = t.clientY - startY;
    if (!mode) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
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
    note.textContent = editing.days.length ? describeRepeat({ kind: 'weekly', days: editing.days }) + '. It will show up on those days by itself.' : 'Pick at least one day.';
  } else if (editing.repeatKind === 'daily') {
    note.textContent = 'It will show up every day by itself.';
  }
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
  } else if (rule) {
    // Stop repeating; keep today's copy as a normal to-do.
    rule.active = false;
    item.repeatId = null;
  }

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

// Every reminder coming up in the next 2 weeks.
function upcomingReminders() {
  const now = Date.now();
  const out = [];
  for (const i of state.items) {
    if (i.deleted || i.done || !i.time || i.date < currentDay) continue;
    const at = atTime(i.date, i.time);
    if (at > now) out.push({ id: 'i:' + i.id, at, title: i.text, body: `Reminder · ${formatTime(i.time)}` });
  }
  // Repeating to-dos that haven't appeared on the list yet.
  for (const rule of state.repeats) {
    if (!rule.active || !rule.time) continue;
    for (let n = 0; n < 14; n++) {
      const day = addDays(currentDay, n);
      if (!repeatMatches(rule, day) || state.items.some((i) => i.repeatId === rule.id && i.date === day)) continue;
      const at = atTime(day, rule.time);
      if (at > now) out.push({ id: `r:${rule.id}:${day}`, at, title: rule.text, body: `Reminder · ${formatTime(rule.time)}` });
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
    on: 'Reminders are on for this phone. Set a time on any to-do to get a notification.',
    off: 'Get a notification at the time you set on a to-do.',
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

function celebrate() {
  const info = streakInfo();
  const n = info.streak;
  let msg = n > 1 ? `All done! 🔥 ${n}-day streak` : 'All done for today! 🎉';
  if (info.earnedToday) msg += ' · You earned a ❄️ freeze!';
  setTimeout(() => showToast(msg), 300);
  const pill = $('streak');
  pill.classList.remove('bump');
  void pill.offsetWidth;
  pill.classList.add('bump');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !document.body.animate) return;

  const colors = ['#ff8a3d', '#e2622a', '#ffd166', '#ffb347', '#e5484d', '#fff4e6'];
  const box = document.createElement('div');
  box.className = 'confetti';
  box.setAttribute('aria-hidden', 'true');
  document.body.appendChild(box);
  const w = window.innerWidth;
  for (let k = 0; k < 90; k++) {
    const piece = document.createElement('i');
    piece.style.background = colors[k % colors.length];
    piece.style.left = `${w / 2}px`;
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

  // Weekday letters, starting on Sunday like the iPhone calendar.
  const head = document.querySelector('.cal-head');
  head.replaceChildren(...DAY_LETTERS.map((l) => { const s = document.createElement('span'); s.textContent = l; return s; }));

  const cal = $('cal');
  cal.replaceChildren();
  const thisSunday = addDays(currentDay, -parseKey(currentDay).getDay());
  const start = addDays(thisSunday, -28);
  const first = state.meta.firstUseDate || currentDay;
  for (let k = 0; k < 35; k++) {
    const day = addDays(start, k);
    const cell = document.createElement('span');
    cell.textContent = parseKey(day).getDate();
    let cls;
    if (day > currentDay) cls = isRestDay(day) ? 'rest' : 'future';
    else if (day < first) cls = 'before';
    else if (isRestDay(day)) cls = 'rest';
    else if (day === currentDay) cls = dayStatus(day, byDay) === 'complete' ? 'complete' : 'pending';
    else if (info.frozen.has(day)) cls = 'frozen';
    else cls = dayStatus(day, byDay) === 'empty' ? 'missed' : dayStatus(day, byDay);
    if (cls === 'rest' && day > currentDay) cls = 'rest future-rest';
    cell.className = cls + (day === currentDay ? ' today' : '');
    const label = { complete: 'finished everything', partial: 'partly done', missed: 'missed', pending: 'in progress', frozen: 'saved by a freeze', rest: 'rest day', 'rest future-rest': 'rest day', future: '', before: '' }[cls];
    cell.setAttribute('aria-label', parseKey(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (label ? `: ${label}` : ''));
    cal.appendChild(cell);
  }
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
  addItem(input.value);
  input.value = '';
});

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
$('wrapup-later').addEventListener('click', () => { state.meta.wrapUpDismissed = currentDay; save(); render(); });
$('wrapup-all').addEventListener('click', () => {
  const items = wrapUpItems();
  const undo = clearForTonight(items);
  afterWrapUp(`Moved ${items.length} to tomorrow`, undo);
});
$('view-tomorrow').addEventListener('click', () => setView(true));
$('streak').addEventListener('click', () => { renderProgress(); openSheet('progress-sheet'); });
$('progress-close').addEventListener('click', closeSheets);
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

$('open-settings').addEventListener('click', () => { renderRepeatList(); renderProfileSummary(); renderReminderSettings(); openSheet('settings-sheet'); });
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
$('time-section').hidden = !REMINDER_API;
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
