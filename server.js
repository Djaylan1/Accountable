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
const db = { tasks: [], subs: [] };

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
      await rpc('save_state', { p_secret: db.key, p_data: { tasks: db.tasks, subs: db.subs } });
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
  db.tasks = saved.tasks || [];
  db.subs = saved.subs || [];
  db.key = process.env.APP_KEY || saved.key || crypto.randomBytes(12).toString('hex');
  db.vapid = process.env.VAPID_PUBLIC
    ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE }
    : saved.vapid || webpush.generateVAPIDKeys();
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', db.vapid.publicKey, db.vapid.privateKey);
  if (!SB_URL) save();
}

async function push(payload) {
  const body = JSON.stringify(payload);
  await Promise.all(db.subs.map(async (s) => {
    try { await webpush.sendNotification(s, body); }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) db.subs = db.subs.filter((x) => x.endpoint !== s.endpoint);
      else console.error('push fout', e.statusCode, e.body);
    }
  }));
  save();
}

const notify = (t, reminder) => push({
  tag: 'task-' + t.id,
  title: reminder ? 'Nog niet gedaan: ' + t.name : t.name,
  body: reminder ? 'Het is alweer een uur geleden. Tik om af te vinken.' : 'Je bent wakker. Tijd om het te doen!',
});

const app = express();
app.use(express.json());

const auth = (req, res, next) => {
  const k = req.get('x-key') || req.query.key;
  if (k !== db.key) return res.status(401).json({ error: 'verkeerde sleutel' });
  next();
};

app.get('/health', (_, res) => res.send('ok'));
app.get('/api/vapid', (_, res) => res.json({ publicKey: db.vapid.publicKey }));

app.get('/api/tasks', auth, (_, res) => res.json(db.tasks));

app.post('/api/tasks', auth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'naam ontbreekt' });
  const t = { id: crypto.randomUUID(), name, status: 'done', firedAt: null, remindAt: null, reminded: false };
  db.tasks.push(t); save(); res.json(t);
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  db.tasks = db.tasks.filter((t) => t.id !== req.params.id); save(); res.json({ ok: true });
});

app.post('/api/tasks/:id/done', auth, (req, res) => {
  const t = db.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'onbekend' });
  Object.assign(t, { status: 'done', remindAt: null });
  save(); res.json(t);
});

app.post('/api/subscribe', auth, (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'ongeldig' });
  db.subs = db.subs.filter((s) => s.endpoint !== sub.endpoint).concat(sub);
  save(); res.json({ ok: true });
});

// Wordt aangeroepen door de iOS Opdrachten-automatisering (wekker gestopt).
async function wakker(req, res) {
  const now = Date.now();
  const fired = [];
  for (const t of db.tasks) {
    if (t.firedAt && now - t.firedAt < DEDUPE_HOURS * 3600e3) continue;
    Object.assign(t, { status: 'open', firedAt: now, remindAt: now + REMIND_AFTER_MIN * 60e3, reminded: false });
    fired.push(t);
  }
  save();
  await Promise.all(fired.map((t) => notify(t, false)));
  res.json({ verstuurd: fired.map((t) => t.name) });
}
app.get('/wakker', auth, wakker);
app.post('/wakker', auth, wakker);

// Herinnering na X minuten als de taak nog open staat.
setInterval(async () => {
  const now = Date.now();
  for (const t of db.tasks) {
    if (t.status === 'open' && !t.reminded && t.remindAt && now >= t.remindAt) {
      t.reminded = true; save();
      await notify(t, true);
    }
  }
}, 20e3);

app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => {
  console.log(`Draait op http://localhost:${port}`);
  if (!SB_URL) console.log(`Sleutel: ${db.key}`);
})).catch((e) => { console.error(e); process.exit(1); });
