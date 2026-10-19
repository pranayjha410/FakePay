import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'fakepay.db');
const DELAY_MS = Number(process.env.PAYMENT_DELAY_MS || 10000);
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const COLS = 8;
const MAX_SEATS = 6;

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS shows (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, venue TEXT NOT NULL,
    starts_at TEXT NOT NULL, price INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,          -- duplicate protection
    show_id INTEGER NOT NULL REFERENCES shows(id),
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',        -- PENDING | CONFIRMED
    ticket_code TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS booked_seats (
    show_id INTEGER NOT NULL,
    seat TEXT NOT NULL,
    booking_id TEXT NOT NULL REFERENCES bookings(id),
    PRIMARY KEY (show_id, seat)                    -- a seat can only belong to one booking
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',        -- PENDING | SUCCESS
    created_at INTEGER NOT NULL,
    complete_at INTEGER NOT NULL,                  -- absolute deadline
    completed_at INTEGER
  );
`);

if (db.prepare('SELECT COUNT(*) c FROM shows').get().c === 0) {
  const ins = db.prepare('INSERT INTO shows (title, venue, starts_at, price) VALUES (?,?,?,?)');
  ins.run('Midnight Express (Sci-Fi)', 'Screen 1, PVR Pune', '2026-11-02 19:30', 250);
  ins.run('Laugh Riot Live (Comedy)', 'Auditorium, Mumbai', '2026-11-05 20:00', 400);
  ins.run('Rock Night 2026 (Concert)', 'Open Arena, Bengaluru', '2026-11-08 18:00', 600);
}

const q = {
  shows:        db.prepare('SELECT * FROM shows'),
  show:         db.prepare('SELECT * FROM shows WHERE id = ?'),
  taken:        db.prepare('SELECT seat FROM booked_seats WHERE show_id = ?'),
  seatsOf:      db.prepare('SELECT seat FROM booked_seats WHERE booking_id = ? ORDER BY seat'),
  bookingById:  db.prepare('SELECT * FROM bookings WHERE id = ?'),
  bookingByKey: db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?'),
  payByBooking: db.prepare('SELECT * FROM payments WHERE booking_id = ?'),
  payById:      db.prepare('SELECT * FROM payments WHERE id = ?'),
  insBooking:   db.prepare('INSERT INTO bookings (id, idempotency_key, show_id, amount, created_at) VALUES (?,?,?,?,?)'),
  insSeat:      db.prepare('INSERT INTO booked_seats (show_id, seat, booking_id) VALUES (?,?,?)'),
  insPayment:   db.prepare('INSERT INTO payments (id, booking_id, amount, created_at, complete_at) VALUES (?,?,?,?,?)'),
  markPaid:     db.prepare(`UPDATE payments SET status='SUCCESS', completed_at=? WHERE id=? AND status='PENDING'`),
  confirm:      db.prepare(`UPDATE bookings SET status='CONFIRMED', ticket_code=? WHERE id=?`),
  pending:      db.prepare(`SELECT id, complete_at FROM payments WHERE status='PENDING'`),
};

// ---------- Transactions ----------
const createBooking = db.transaction((b) => {
  q.insBooking.run(b.id, b.key, b.showId, b.amount, b.now);
  for (const seat of b.seats) q.insSeat.run(b.showId, seat, b.id); // throws if seat taken -> whole thing rolls back
  q.insPayment.run(b.paymentId, b.id, b.amount, b.now, b.now + DELAY_MS);
});

const completePayment = db.transaction((paymentId) => {
  const r = q.markPaid.run(Date.now(), paymentId);   // WHERE status='PENDING' -> only one caller wins
  if (r.changes === 0) return;                        // already completed, do nothing
  const p = q.payById.get(paymentId);
  q.confirm.run('TKT-' + randomBytes(3).toString('hex').toUpperCase(), p.booking_id);
});

// ---------- Processing + restart recovery ----------
function schedule(paymentId, completeAt) {
  setTimeout(() => {
    try { completePayment(paymentId); } catch (e) { console.error('complete failed', e); }
  }, Math.max(0, completeAt - Date.now()));
}
for (const p of q.pending.all()) schedule(p.id, p.complete_at); // on startup, re-schedule unfinished payments

// ---------- View helper ----------
function bookingView(id) {
  const b = q.bookingById.get(id);
  if (!b) return null;
  let pay = q.payByBooking.get(id);
  if (pay.status === 'PENDING' && Date.now() >= pay.complete_at) { // self-heal if timer was lost
    completePayment(pay.id);
    return bookingView(id);
  }
  const show = q.show.get(b.show_id);
  return {
    id: b.id, status: b.status, ticketCode: b.ticket_code, amount: b.amount, createdAt: b.created_at,
    show: { id: show.id, title: show.title, venue: show.venue, startsAt: show.starts_at },
    seats: q.seatsOf.all(id).map((r) => r.seat),
    payment: {
      id: pay.id, status: pay.status, completeAt: pay.complete_at, completedAt: pay.completed_at,
      remainingMs: Math.max(0, pay.complete_at - Date.now()),
    },
  };
}

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/shows', (req, res) => res.json(q.shows.all()));

app.get('/api/shows/:id', (req, res) => {
  const show = q.show.get(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });
  res.json({ ...show, rows: ROWS, cols: COLS, takenSeats: q.taken.all(show.id).map((r) => r.seat) });
});

app.post('/api/bookings', (req, res) => {
  try {
    const key = req.get('Idempotency-Key');
    if (!key || key.length > 100) return res.status(400).json({ error: 'Idempotency-Key header required' });

    // duplicate request -> return the same booking
    const dup = q.bookingByKey.get(key);
    if (dup) return res.status(200).json(bookingView(dup.id));

    const showId = Number(req.body?.showId);
    const seats = req.body?.seats;
    const show = Number.isInteger(showId) ? q.show.get(showId) : null;
    if (!show) return res.status(404).json({ error: 'Show not found' });

    const valid = (s) => typeof s === 'string' && /^[A-Z]\d{1,2}$/.test(s)
      && ROWS.includes(s[0]) && Number(s.slice(1)) >= 1 && Number(s.slice(1)) <= COLS;
    if (!Array.isArray(seats) || seats.length < 1 || seats.length > MAX_SEATS
        || !seats.every(valid) || new Set(seats).size !== seats.length) {
      return res.status(400).json({ error: `Choose 1-${MAX_SEATS} valid, distinct seats` });
    }

    // amount is computed on the server; the client never decides the price
    const id = randomUUID();
    try {
      createBooking({ id, key, showId, seats, amount: show.price * seats.length, paymentId: randomUUID(), now: Date.now() });
    } catch (e) {
      if (String(e.code).startsWith('SQLITE_CONSTRAINT')) {
        const again = q.bookingByKey.get(key); // same key raced in -> return that booking
        if (again) return res.status(200).json(bookingView(again.id));
        return res.status(409).json({ error: 'One or more seats were just taken. Please choose different seats.' });
      }
      throw e;
    }
    const pay = q.payByBooking.get(id);
    schedule(pay.id, pay.complete_at);
    res.status(202).json(bookingView(id));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/bookings/:id', (req, res) => {
  try {
    const v = bookingView(req.params.id);
    if (!v) return res.status(404).json({ error: 'Booking not found' });
    res.json(v);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------- Serve built React app (deployment) ----------
const dist = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res) => res.sendFile(path.join(dist, 'index.html'))); // /booking/:id survives refresh
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`FakeTix (SIMULATION) on port ${PORT}`));