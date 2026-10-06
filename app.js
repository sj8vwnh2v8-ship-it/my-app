'use strict';

// ============================================================
//  Today — a simple to-do list that lives on your phone.
//  All data is kept in this browser's local storage.
// ============================================================

const APP_VERSION = '1.0.2';
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

function freshState() {
  return { version: 1, items: [], repeats: [], meta: { firstUseDate: dateKey(), lastOpenDate: null } };
}

function isValidState(s) {
  return s && typeof s === 'object' && Array.isArray(s.items) && Array.isArray(s.repeats) && s.meta && typeof s.meta === 'object';
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw);
    return isValidState(parsed) ? parsed : freshState();
  } catch (e) {
    return freshState();
  }
}

let state = load();
let currentDay = dateKey();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    showToast("Couldn't save. Your phone may be out of storage.");
  }
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
      priority: rule.priority || null, repeatId: rule.id, createdAt: Date.now(),
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

// Streak = days in a row where every to-do got done.
// Days with no to-dos are skipped (they don't break it or add to it).
// Today only counts once it's complete; an unfinished today doesn't break it yet.
function computeStreak() {
  const byDay = new Map();
  for (const i of state.items) {
    if (i.deleted) continue;
    const s = byDay.get(i.date) || { total: 0, done: 0 };
    s.total++;
    if (i.done) s.done++;
    byDay.set(i.date, s);
  }
  const status = (day) => {
    const s = byDay.get(day);
    if (!s) return 'empty';
    return s.done === s.total ? 'complete' : 'incomplete';
  };

  let streak = status(currentDay) === 'complete' ? 1 : 0;
  const earliest = [...byDay.keys()].sort()[0] || currentDay;
  for (let day = addDays(currentDay, -1); day >= earliest; day = addDays(day, -1)) {
    const s = status(day);
    if (s === 'incomplete') break;
    if (s === 'complete') streak++;
  }
  return streak;
}

// ---------- Actions ----------

function addItem(text) {
  text = text.trim();
  if (!text) return;
  state.items.push({
    id: uid(), text, date: currentDay, done: false, doneAt: null,
    priority: null, repeatId: null, createdAt: Date.now(),
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
  const items = itemsForDay(currentDay);
  $('all-done').hidden = !(items.length > 0 && items.every((i) => i.done));

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
      priority: item.priority || null, repeatId: null, createdAt: Date.now(), carriedFrom: item.id,
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
  renderCarryOver();
  renderList();
}

function renderHeader() {
  const d = parseKey(currentDay);
  $('today-label').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const items = itemsForDay(currentDay);
  const done = items.filter((i) => i.done).length;
  $('progress').textContent = items.length ? `${done} of ${items.length} done` : 'Nothing planned yet';
  const streak = computeStreak();
  $('streak-count').textContent = streak;
  $('streak').classList.toggle('zero', streak === 0);
  $('streak').setAttribute('aria-label', `Streak: ${streak} day${streak === 1 ? '' : 's'}`);
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
  const pending = pendingCarryOver();
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
  const items = sortedItems(itemsForDay(currentDay));
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
    row.className = 'item' + (item.priority ? ` p-${item.priority}` : '') + (item.done ? ' done' : '');

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
    if (item.priority) meta.push(PRIORITY_LABEL[item.priority]);
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
  $('all-done').hidden = !(items.length > 0 && items.every((i) => i.done));
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
    days: rule && rule.kind === 'weekly' ? [...rule.days] : [parseKey(currentDay).getDay()],
  };
  $('edit-text').value = item.text;
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

  let rule = item.repeatId ? state.repeats.find((r) => r.id === item.repeatId) : null;
  if (editing.repeatKind) {
    if (!rule || !rule.active) {
      // Start a new repeating rule from this item.
      rule = { id: uid(), startDate: currentDay, active: true };
      state.repeats.push(rule);
      item.repeatId = rule.id;
    }
    rule.text = text;
    rule.priority = item.priority;
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
  const name = `today-backup-${dateKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Today backup' });
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
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!isValidState(data)) throw new Error('bad file');
      if (!confirm('Replace everything in the app with this backup?')) return;
      state = data;
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
  currentDay = dateKey();
  if (!state.meta.firstUseDate) state.meta.firstUseDate = currentDay;
  const added = addRepeatItemsFor(currentDay);
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

$('dismiss-tip').addEventListener('click', () => { state.meta.tipDismissed = true; save(); render(); });

$('open-settings').addEventListener('click', () => { renderRepeatList(); openSheet('settings-sheet'); });
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
});
$('version').textContent = APP_VERSION;

// Re-check when you come back to the app (it may be a new day).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') runDailyCheck();
});
setInterval(() => { if (dateKey() !== currentDay) runDailyCheck(); }, 60 * 1000);

runDailyCheck();

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
  });
}
