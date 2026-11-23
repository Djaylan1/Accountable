const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const REMIND_AFTER_MIN = Number(process.env.REMIND_AFTER_MIN || 60);
const DEDUPE_HOURS = 4; // tweede 'wakker' binnen 4 uur (bv. snooze) wordt genegeerd

// Opslag: Supabase (via SUPABASE_URL + SUPABASE_KEY + APP_KEY) of anders een lokaal bestand.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const INVITE = process.env.INVITE_CODE || '';
const db = { users: [] };

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, authorization: 'Bearer ' + SB_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${fn} ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

let saving = false, dirty = false;
async function flush() {
  if (saving) return;
  saving = true;
  try {
    while (dirty) {
      dirty = false;
      await rpc('save_state', { p_secret: db.secret, p_data: { users: db.users } });
    }
  } catch (e) { console.error('opslag fout', e.message); }
  saving = false;
}
function save() {
  if (SB_URL) { dirty = true; flush(); return; }
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

async function init() {
  let saved = {};
  if (SB_URL) {
    if (!process.env.APP_KEY) throw new Error('APP_KEY is verplicht bij Supabase-opslag');
    saved = (await rpc('load_state', { p_secret: process.env.APP_KEY })) || {};
  } else {
    try { saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
  }
  const normTasks = (list) => (list || []).map((t) => {
    const x = { goal: null, unit: '', emoji: '', nextGoal: null, history: [], ...t };
    x.history = x.history.map((e) => ({
      goal: null, logs: e.amount ? [{ at: e.doneAt || e.firedAt, amount: e.amount }] : [], ...e,
      amount: e.amount || 0, ...(e.doneAt && e.met === undefined ? { met: true } : {}),
    }));
    return x;
  });
  db.secret = process.env.APP_KEY || saved.secret || saved.key || crypto.randomBytes(12).toString('hex');
  if (saved.users) db.users = saved.users.map((u) => ({ remindMin: null, subs: [], ...u, tasks: normTasks(u.tasks) }));
  else db.users = [{ id: crypto.randomUUID(), name: 'Djaylan', key: db.secret, remindMin: null, created: Date.now(), tasks: normTasks(saved.tasks), subs: saved.subs || [] }];
  db.vapid = process.env.VAPID_PUBLIC
    ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE }
    : saved.vapid || webpush.generateVAPIDKeys();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', db.vapid.publicKey, db.vapid.privateKey);
  if (!SB_URL || !saved.users) save();
}

async function push(u, payload) {
  const body = JSON.stringify(payload);
  await Promise.all(u.subs.map(async (s) => {
    try { await webpush.sendNotification(s, body); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) u.subs = u.subs.filter((x) => x.endpoint !== s.endpoint);
      else console.error('push fout', e.statusCode, e.body);
    }
  }));
  save();
}

function notify(u, t, reminder) {
  const r = t.history[t.history.length - 1] || {};
  const goal = r.goal, unit = t.unit ? ' ' + t.unit : '';
  const left = goal ? Math.max(0, goal - (r.amount || 0)) : 0;
  return push(u, {
    tag: 'task-' + t.id,
    title: reminder ? 'Nog niet gedaan: ' + t.name : t.name,
    body: reminder
      ? (goal ? `Nog ${left}${unit} te gaan van ${goal}. Tik om te loggen.` : 'Het is alweer een uur geleden. Tik om af te vinken.')
      : (goal ? `Je bent wakker. Doel: ${goal}${unit}.` : 'Je bent wakker. Tijd om het te doen!'),
  });
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const remindMs = (u) => (u.remindMin || REMIND_AFTER_MIN) * 60e3;
const auth = (req, res, next) => {
  const k = req.get('x-key') || req.query.key;
  const u = k && db.users.find((x) => x.key === k);
  if (!u) return res.status(401).json({ error: 'verkeerde sleutel' });
  req.u = u;
  next();
};

// Account aanmaken met uitnodigingscode (max 10 pogingen per uur per IP).
const tries = new Map();
app.post('/api/register', (req, res) => {
  const ip = req.ip, now = Date.now();
  const arr = (tries.get(ip) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= 10) return res.status(429).json({ error: 'te vaak geprobeerd, probeer later opnieuw' });
  tries.set(ip, [...arr, now]);
  const code = String(req.body?.invite || '').trim();
  if (!INVITE || code.toLowerCase() !== INVITE.toLowerCase()) return res.status(403).json({ error: 'onjuiste uitnodigingscode' });
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: 'naam ontbreekt' });
  if (db.users.length >= 1000) return res.status(403).json({ error: 'vol' });
  const u = { id: crypto.randomUUID(), name, key: crypto.randomBytes(12).toString('hex'), remindMin: null, created: now, tasks: [], subs: [] };
  db.users.push(u); save();
  res.json({ key: u.key, name: u.name });
});

app.get('/api/me', auth, (req, res) => res.json({ name: req.u.name, remindMin: req.u.remindMin || REMIND_AFTER_MIN }));
app.patch('/api/me', auth, (req, res) => {
  const n = String(req.body?.name ?? req.u.name).trim().slice(0, 30);
  if (n) req.u.name = n;
  const m = Number(req.body?.remindMin);
  if (m >= 5 && m <= 720) req.u.remindMin = Math.round(m);
  save(); res.json({ name: req.u.name, remindMin: req.u.remindMin || REMIND_AFTER_MIN });
});

app.get('/health', (_, res) => res.send('ok'));
app.get('/api/vapid', (_, res) => res.json({ publicKey: db.vapid.publicKey }));

app.get('/api/tasks', auth, (req, res) => res.json(req.u.tasks));

const cleanFields = (b) => ({
  name: String(b.name || '').trim().slice(0, 80),
  goal: Number(b.goal) > 0 ? Math.min(Number(b.goal), 100000) : null,
  unit: String(b.unit || '').trim().slice(0, 20),
  emoji: String(b.emoji || '').trim().slice(0, 4),
});

app.post('/api/tasks', auth, (req, res) => {
  const f = cleanFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'naam ontbreekt' });
  const t = { id: crypto.randomUUID(), ...f, status: 'done', firedAt: null, remindAt: null, reminded: false, history: [] };
  req.u.tasks.push(t); save(); res.json(t);
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  const t = req.u.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'onbekend' });
  const f = cleanFields({ ...t, ...req.body });
  if (!f.name) return res.status(400).json({ error: 'naam ontbreekt' });
  Object.assign(t, f); save(); res.json(t);
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  req.u.tasks = req.u.tasks.filter((t) => t.id !== req.params.id); save(); res.json({ ok: true });
});

// Doel voor de volgende ronde (bv. "morgen 40 push-ups"). Leeg = standaarddoel.
app.post('/api/tasks/:id/next-goal', auth, (req, res) => {
  const t = req.u.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'onbekend' });
  const g = Number(req.body?.goal);
  t.nextGoal = g > 0 ? Math.min(g, 100000) : null;
  save(); res.json(t);
});

// Loggen: telt op bij de lopende ronde (ook deelaantallen, bv. 7 nu en 23 later).
// De ronde sluit zodra het doel gehaald is, of als je zelf afrondt (finish).
app.post('/api/tasks/:id/log', auth, (req, res) => {
  const t = req.u.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'onbekend' });
  const now = Date.now();
  const amt = Number(req.body?.amount) > 0 ? Math.min(Number(req.body.amount), 100000) : 0;
  let r = t.history[t.history.length - 1];
  if (!(t.status === 'open' && r && !r.doneAt)) {
    r = { firedAt: now, doneAt: null, amount: 0, goal: t.nextGoal || t.goal || null, logs: [], manual: true };
    t.nextGoal = null;
    t.history.push(r);
    if (t.history.length > 200) t.history.shift();
    Object.assign(t, { status: 'open', remindAt: null });
  }
  if (amt) { r.logs.push({ at: now, amount: amt }); r.amount = r.logs.reduce((a, l) => a + l.amount, 0); }
  if (req.body?.finish || !r.goal || r.amount >= r.goal) {
    Object.assign(r, { doneAt: now, met: !r.goal || r.amount >= r.goal });
    Object.assign(t, { status: 'done', remindAt: null });
  }
  save(); res.json(t);
});

// Vergissing? Haal de laatste log (of de afronding) terug.
app.post('/api/tasks/:id/undo', auth, (req, res) => {
  const t = req.u.tasks.find((x) => x.id === req.params.id);
  const r = t && t.history[t.history.length - 1];
  if (!r || (!r.doneAt && !r.logs.length)) return res.status(400).json({ error: 'niets om terug te zetten' });
  if (r.logs.length) r.logs.pop();
  r.amount = r.logs.reduce((a, l) => a + l.amount, 0);
  if (r.manual && !r.logs.length) {
    t.history.pop();
    Object.assign(t, { status: 'done', remindAt: null });
  } else {
    r.doneAt = null; delete r.met;
    Object.assign(t, { status: 'open', remindAt: r.manual ? null : Date.now() + remindMs(req.u), reminded: false });
  }
  save(); res.json(t);
});

app.post('/api/test', auth, async (req, res) => {
  await push(req.u, { tag: 'test', title: 'Testmelding', body: 'Meldingen werken. Je bent klaar voor de volgende wake-up.' });
  res.json({ ok: true, apparaten: req.u.subs.length });
});

app.post('/api/subscribe', auth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'ongeldig' });
  req.u.subs = req.u.subs.filter((s) => s.endpoint !== sub.endpoint).concat(sub);
  save(); res.json({ ok: true });
});

// Wordt aangeroepen door de iOS Opdrachten-automatisering (wekker gestopt).
async function wakker(req, res) {
  const u = req.u, now = Date.now(), force = req.query.force === '1';
  const fired = [];
  for (const t of u.tasks) {
    if (!force && t.firedAt && now - t.firedAt < DEDUPE_HOURS * 3600e3) continue;
    const last = t.history[t.history.length - 1];
    const next = t.nextGoal || null;
    t.nextGoal = null;
    if (t.status === 'open' && last && !last.doneAt && last.manual) {
      // Je had al gelogd vóór je wekker: die ronde wordt de ronde van vandaag.
      Object.assign(last, { manual: false, firedAt: now, goal: next ?? last.goal });
    } else {
      t.history.push({ firedAt: now, doneAt: null, amount: 0, goal: next ?? t.goal ?? null, logs: [] });
      if (t.history.length > 200) t.history.shift();
    }
    Object.assign(t, { status: 'open', firedAt: now, remindAt: now + remindMs(u), reminded: false });
    fired.push(t);
  }
  save();
  await Promise.all(fired.map((t) => notify(u, t, false)));
  res.json({ verstuurd: fired.map((t) => t.name) });
}
app.get('/wakker', auth, wakker);
app.post('/wakker', auth, wakker);

// Herinnering na X minuten als de taak nog open staat.
setInterval(async () => {
  const now = Date.now();
  for (const u of db.users) for (const t of u.tasks) {
    if (t.status === 'open' && !t.reminded && t.remindAt && now >= t.remindAt) {
      t.reminded = true; save();
      await notify(u, t, true);
    }
  }
}, 20e3);

app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => {
  console.log(`Draait op http://localhost:${port}`);
  if (!SB_URL) console.log(`Sleutel: ${db.users[0].key}`);
})).catch((e) => { console.error(e); process.exit(1); });
