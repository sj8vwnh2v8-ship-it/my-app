'use strict';

// ============================================================
//  The "smart" parts: daily suggestions and guessed priority colors.
//  Everything here runs on the phone, using only your own history.
// ============================================================

const SUGGEST_AFTER_DAYS = 7;   // days of use before suggestions start
const SUGGESTIONS_PER_DAY = 3;
const DISMISS_LIMIT = 3;        // dismiss something this many times and it stops coming back

const HOBBY_PRESETS = [
  'Fitness', 'Running', 'Reading', 'Cooking', 'Music', 'Art & drawing', 'Gaming',
  'Gardening', 'Photography', 'Writing', 'Hiking', 'Yoga', 'Languages', 'Movies & TV', 'Sports',
];
const GOAL_PRESETS = [
  'Get fit', 'Run a 5K', 'Read more books', 'Save money', 'Learn a language', 'Eat healthier',
  'Sleep better', 'Learn to cook', 'Less screen time', 'Meditate', 'Drink more water', 'Learn an instrument',
];

// Ideas for common hobbies and goals. The first group whose words match is used.
const IDEA_LIBRARY = [
  { match: /\b(run|5k|10k|marathon|jog)/, ideas: ['Go for a 20-minute run', 'Easy 2-mile jog', 'Stretch after your run', 'Interval run: 1 min fast, 2 min easy ×6', 'Plan this week’s runs'] },
  { match: /\b(fit|gym|workout|exercise|strength|lift|muscle|weight)/, ideas: ['30-minute workout', 'Do 3 sets of push-ups', 'Go for a brisk walk', 'Stretch for 10 minutes', 'Plan this week’s workouts'] },
  { match: /\b(read|book)/, ideas: ['Read 20 pages', 'Read for 15 minutes before bed', 'Pick your next book', 'Read during lunch'] },
  { match: /\b(cook|bak|recipe|chef|meal)/, ideas: ['Try a new recipe', 'Plan this week’s meals', 'Cook dinner at home', 'Prep tomorrow’s lunch'] },
  { match: /\b(music|guitar|piano|instrument|sing|drum|violin|ukulele)/, ideas: ['Practice your instrument for 20 minutes', 'Learn a new song', 'Practice scales for 10 minutes', 'Listen to a new album'] },
  { match: /\b(art|draw|paint|sketch|illustrat)/, ideas: ['Sketch for 15 minutes', 'Draw something you see today', 'Try a new art technique'] },
  { match: /\b(garden|plant)/, ideas: ['Water the plants', 'Weed the garden for 15 minutes', 'Check on your plants'] },
  { match: /\b(photo|camera)/, ideas: ['Take 10 photos on a walk', 'Edit last week’s photos', 'Try a new photo angle'] },
  { match: /\b(writ|journal|blog|poem|novel)/, ideas: ['Write 300 words', 'Journal for 10 minutes', 'Jot down 3 ideas'] },
  { match: /\b(hik|outdoor|nature|walk)/, ideas: ['Plan a weekend hike', 'Take a walk in a park', 'Spend 20 minutes outside'] },
  { match: /\b(yoga|stretch|mobility|pilates)/, ideas: ['15-minute yoga session', 'Morning stretch routine'] },
  { match: /\b(language|spanish|french|german|italian|japanese|chinese|korean|portuguese|duolingo)/, ideas: ['15-minute language lesson', 'Learn 10 new words', 'Review your flashcards', 'Listen to a podcast in your new language'] },
  { match: /\b(sav|money|budget|financ|debt|spend)/, ideas: ['Check this week’s spending', 'Move money into savings', 'Review your subscriptions', 'Make lunch instead of buying it'] },
  { match: /\b(eat|health|diet|nutrition|vegetable|veggie)/, ideas: ['Eat a vegetable with every meal', 'Pack a healthy snack', 'Plan healthy meals for the week', 'Cook a healthy dinner'] },
  { match: /\b(sleep|bedtime|rest)/, ideas: ['In bed by 10:30pm', 'No screens 30 minutes before bed', 'Wind down with a book tonight'] },
  { match: /\b(screen|phone|social media|scroll)/, ideas: ['One hour phone-free', 'No social media before noon', 'Phone in another room during dinner'] },
  { match: /\b(meditat|mindful|calm|stress|breath)/, ideas: ['Meditate for 10 minutes', '5 minutes of deep breathing', 'Take a mindful walk'] },
  { match: /\b(water|hydrat)/, ideas: ['Drink 8 glasses of water', 'Refill your water bottle twice'] },
  { match: /\b(gam)/, ideas: ['Play a game for an hour', 'Try a new game'] },
  { match: /\b(movie|film|tv|show)/, ideas: ['Watch a movie tonight', 'Pick a new show to try'] },
  { match: /\b(sport|basketball|soccer|football|tennis|golf|baseball|swim|bike|biking|cycl|climb|skat)/, ideas: ['Practice your sport for 30 minutes', 'Get a game in with friends', 'Work on one skill for 15 minutes'] },
];

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'about', 'some', 'this', 'that', 'today', 'tomorrow', 'minutes', 'minute', 'min', 'mins']);

// "Buy Groceries!" and "buy groceries" count as the same thing.
function normText(text) {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function wordsOf(text) {
  return normText(text).split(' ').filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function dayNumber(key) {
  return Math.round(parseKey(key).getTime() / 86400000);
}

// ---------- Suggestions ----------

function daysOfUse(state) {
  const days = new Set();
  for (const i of state.items) if (!i.deleted && !i.repeatId) days.add(i.date);
  return days.size;
}

function suggestionsUnlocked(state) {
  return daysOfUse(state) >= SUGGEST_AFTER_DAYS;
}

function ideasFor(text) {
  const t = normText(text);
  const group = IDEA_LIBRARY.find((g) => g.match.test(t));
  return group ? group.ideas : null;
}

// Things you add on the same weekday, or most days, become suggestions.
function patternCandidates(state, day) {
  const since = addDays(day, -56);
  const first = state.meta.firstUseDate || day;
  const repeating = new Set(state.repeats.filter((r) => r.active).map((r) => normText(r.text)));
  const byKey = new Map();
  for (const i of state.items) {
    if (i.deleted || i.repeatId || i.carriedFrom || i.date >= day || i.date < since) continue;
    const key = normText(i.text);
    if (!key || repeating.has(key)) continue;
    const entry = byKey.get(key) || { dates: new Set(), text: i.text, last: '' };
    entry.dates.add(i.date);
    if (i.date >= entry.last) { entry.last = i.date; entry.text = i.text; }
    byKey.set(key, entry);
  }

  const weekday = parseKey(day).toLocaleDateString(undefined, { weekday: 'long' });
  const out = [];
  for (const [key, e] of byKey) {
    // Same weekday over the last 8 weeks
    let n = 0, hits = 0;
    for (let k = 1; k <= 8; k++) {
      const d = addDays(day, -7 * k);
      if (d < first) break;
      n++;
      if (e.dates.has(d)) hits++;
    }
    if (n >= 2 && hits >= 2 && hits / n >= 0.5) {
      out.push({ key, text: e.text, source: 'pattern', score: 0.7 + 0.3 * (hits / n),
        reason: `You added this on ${hits} of the last ${n} ${weekday}s` });
      continue;
    }
    // Most days in the last week
    let recent = 0;
    for (let k = 1; k <= 7; k++) if (e.dates.has(addDays(day, -k))) recent++;
    if (recent >= 4) {
      out.push({ key, text: e.text, source: 'pattern', score: 0.6 + 0.05 * recent,
        reason: `You added this ${recent} of the last 7 days` });
    }
  }
  return out;
}

// Pick an idea from the library, rotating day to day so it doesn't repeat.
function pickIdea(ideas, seed, isBlocked) {
  for (let k = 0; k < ideas.length; k++) {
    const idea = ideas[(seed + k) % ideas.length];
    if (!isBlocked(normText(idea))) return idea;
  }
  return null;
}

function hashString(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function goalCandidates(state, day, isBlocked) {
  const profile = state.profile;
  if (!profile) return [];
  const out = [];
  const today = dayNumber(day);
  const lastFromSource = (src) => {
    let last = null;
    for (const i of state.items) {
      if (i.suggestFrom === src && !i.deleted && i.date < day && (!last || i.date > last)) last = i.date;
    }
    return last;
  };

  for (const goal of profile.goals || []) {
    const src = 'goal:' + goal.id;
    const last = lastFromSource(src);
    const gap = last ? today - dayNumber(last) : Infinity;
    if (goal.freq === 'few' && gap < 2) continue;
    if (goal.freq === 'weekly' && gap < 7) continue;
    const ideas = ideasFor(goal.text);
    const text = ideas ? pickIdea(ideas, today + hashString(goal.id), isBlocked) : `Work on: ${goal.text}`;
    if (!text) continue;
    const score = goal.freq === 'daily' ? 0.65 : goal.freq === 'few' ? 0.55 : 0.5;
    out.push({ key: normText(text), text, source: src, score, reason: `For your goal: ${goal.text}` });
  }

  const hobbies = profile.hobbies || [];
  if (hobbies.length) {
    // One hobby a day, taking turns.
    const hobby = hobbies[today % hobbies.length];
    const ideas = ideasFor(hobby);
    const text = ideas ? pickIdea(ideas, today, isBlocked) : `Make time for ${hobby.toLowerCase()}`;
    if (text) out.push({ key: normText(text), text, source: 'hobby:' + hobby, score: 0.3, reason: `You enjoy ${hobby.toLowerCase()}` });
  }
  return out;
}

// Returns the suggestions to show today (already-handled ones removed).
function getSuggestions(state, day) {
  const s = state.suggest;
  const todayLog = s.today && s.today.date === day ? s.today : { date: day, handled: [] };
  const slots = SUGGESTIONS_PER_DAY - todayLog.handled.length;
  if (slots <= 0) return [];

  const onList = new Set(state.items.filter((i) => i.date === day && !i.deleted).map((i) => normText(i.text)));
  const isBlocked = (key) => onList.has(key) || todayLog.handled.includes(key) || (s.dismissed[key] || 0) >= DISMISS_LIMIT;

  const all = patternCandidates(state, day).concat(goalCandidates(state, day, isBlocked))
    .filter((c) => !isBlocked(c.key))
    .sort((a, b) => b.score - a.score);

  const picked = [];
  const seen = new Set();
  const caps = { pattern: 2, goal: 2, hobby: 1 };
  const used = { pattern: 0, goal: 0, hobby: 0 };
  for (const c of all) {
    const kind = c.source.split(':')[0];
    if (seen.has(c.key) || used[kind] >= caps[kind]) continue;
    seen.add(c.key);
    used[kind]++;
    picked.push(c);
    if (picked.length >= slots) break;
  }
  return picked;
}

// ---------- Guessed priority colors ----------

function guessPriority(state, text, today) {
  const key = normText(text);
  if (!key) return null;
  const labeled = state.items
    .filter((i) => !i.deleted && i.priority && i.prioritySource === 'user')
    .sort((a, b) => b.createdAt - a.createdAt);

  // 1. You've given this exact to-do a color before.
  const exact = labeled.find((i) => normText(i.text) === key);
  if (exact) return exact.priority;

  // 2. It shares words with things you've colored ("Pay rent" → "Pay electric bill").
  if (labeled.length >= 5) {
    const words = new Set(wordsOf(text));
    const votes = { high: 0, med: 0, low: 0 };
    for (const i of labeled) {
      const shared = wordsOf(i.text).filter((w) => words.has(w)).length;
      if (shared) votes[i.priority] += shared;
    }
    const total = votes.high + votes.med + votes.low;
    const best = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
    if (total >= 1 && votes[best] / total >= 0.67) return best;
  }

  // 3. How you've treated it before: always done first, or always put off.
  const past = state.items.filter((i) => !i.deleted && i.date < today && normText(i.text) === key);
  if (past.length >= 3) {
    const putOff = past.filter((i) => !i.done).length / past.length;
    if (putOff >= 0.5) return 'low';
    let firsts = 0, busyDays = 0;
    for (const i of past) {
      const sameDay = state.items.filter((o) => o.date === i.date && !o.deleted && o.done);
      if (sameDay.length < 3) continue;
      busyDays++;
      const first = sameDay.reduce((a, b) => (a.doneAt <= b.doneAt ? a : b));
      if (first.id === i.id) firsts++;
    }
    if (busyDays >= 3 && firsts / busyDays >= 0.6) return 'high';
  }
  return null;
}
