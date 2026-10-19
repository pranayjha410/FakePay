import { useEffect, useState } from 'react';
import "./App.css";
const ROWS = ['A', 'B', 'C', 'D', 'E'];
const COLS = [1, 2, 3, 4, 5, 6, 7, 8];
const idFromUrl = () => window.location.pathname.match(/^\/booking\/([\w-]+)$/)?.[1] ?? null;

async function api(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Request failed'), { status: r.status });
  return d;
}

export default function App() {
  const [bookingId, setBookingId] = useState(idFromUrl());
  return (
    <div style={{ maxWidth: 560, margin: '40px auto', fontFamily: 'sans-serif', padding: 12 }}>
      <h2>FakeTix <small style={{ color: '#c00' }}>(SIMULATION, no real money)</small></h2>
      {bookingId ? (
        <Status
          id={bookingId}
          onReset={() => { sessionStorage.clear(); window.history.pushState({}, '', '/'); setBookingId(null); }}
        />
      ) : (
        <Browse onBooked={(b) => { window.history.pushState({}, '', `/booking/${b.id}`); setBookingId(b.id); }} />
      )}
    </div>
  );
}

function Browse({ onBooked }) {
  const [shows, setShows] = useState([]);
  const [show, setShow] = useState(null);
  const [taken, setTaken] = useState([]);
  const [sel, setSel] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api('/api/shows').then(setShows).catch((e) => setError(e.message)); }, []);

  const loadTaken = (s) => api(`/api/shows/${s.id}`).then((d) => setTaken(d.takenSeats)).catch((e) => setError(e.message));
  function openShow(s) { setShow(s); setSel([]); setError(''); loadTaken(s); }
  const toggle = (seat) => setSel((p) => p.includes(seat) ? p.filter((x) => x !== seat) : p.length < 6 ? [...p, seat] : p);

  async function pay() {
    setBusy(true); setError('');
    // key is tied to this exact selection and saved BEFORE the request, so refresh + retry reuses it
    const sig = `idem:${show.id}:${[...sel].sort().join(',')}`;
    let key = sessionStorage.getItem(sig);
    if (!key) { key = crypto.randomUUID(); sessionStorage.setItem(sig, key); }
    try {
      const b = await api('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ showId: show.id, seats: sel }),
      });
      onBooked(b);
    } catch (e) {
      setError(e.message);
      if (e.status === 409) { sessionStorage.removeItem(sig); setSel([]); loadTaken(show); }
    } finally { setBusy(false); }
  }

  return (
    <>
      <h3>Choose a show</h3>
      {shows.map((s) => (
        <div key={s.id} style={{ border: '1px solid #ccc', padding: 8, marginBottom: 6, background: show?.id === s.id ? '#eef' : '#fff' }}>
          <b>{s.title}</b><br />{s.venue} · {s.starts_at} · ₹{s.price}/seat{' '}
          <button onClick={() => openShow(s)}>Select</button>
        </div>
      ))}

      {show && (
        <>
          <h3>Pick seats (max 6)</h3>
          <div style={{ textAlign: 'center', background: '#ddd', marginBottom: 8 }}>SCREEN</div>
          {ROWS.map((r) => (
            <div key={r} style={{ display: 'flex', gap: 4, marginBottom: 4, justifyContent: 'center' }}>
              {COLS.map((c) => {
                const seat = r + c, isTaken = taken.includes(seat), isSel = sel.includes(seat);
                return (
                  <button key={seat} disabled={isTaken} onClick={() => toggle(seat)}
                    style={{ width: 44, background: isTaken ? '#999' : isSel ? '#4a4' : '#fff' }}>
                    {seat}
                  </button>
                );
              })}
            </div>
          ))}
          <p>Selected: {sel.join(', ') || 'none'} · Total: ₹{sel.length * show.price}</p>
          <button disabled={!sel.length || busy} onClick={pay}>
            {busy ? 'Starting payment...' : `Pay ₹${sel.length * show.price}`}
          </button>
        </>
      )}
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </>
  );
}

function Status({ id, onReset }) {
  const [b, setB] = useState(null);
  const [error, setError] = useState('');

  // Poll the backend (the source of truth). Restarts automatically after every refresh.
  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const d = await api(`/api/bookings/${id}`);
        setB(d); setError('');
        if (d.payment.status !== 'PENDING') stop = true;
      } catch (e) {
        if (e.status === 404) { setError('Booking not found'); stop = true; }
        else setError('Connection problem, retrying...');
      }
    }
    poll();
    const t = setInterval(() => (stop ? clearInterval(t) : poll()), 1500);
    return () => { stop = true; clearInterval(t); };
  }, [id]);

  if (error === 'Booking not found') return <><p style={{ color: 'red' }}>{error}</p><button onClick={onReset}>Start over</button></>;
  if (!b) return <p>Loading... {error}</p>;

  return (
    <>
      <p>Booking ID: <code>{b.id}</code></p>
      <p><b>{b.show.title}</b><br />{b.show.venue} · {b.show.startsAt}<br />
        Seats: {b.seats.join(', ')} · Amount: ₹{b.amount}</p>
      <h3>Payment: {b.payment.status}</h3>

      {b.payment.status === 'PENDING' && (
        <p>Processing payment (~{Math.ceil(b.payment.remainingMs / 1000)}s left). You can safely refresh this page.</p>
      )}
      {b.status === 'CONFIRMED' && (
        <div style={{ border: '2px dashed green', padding: 12 }}>
          ✅ Booking confirmed (simulated)<br />
          <b>Ticket: {b.ticketCode}</b>
        </div>
      )}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {b.status === 'CONFIRMED' && <p><button onClick={onReset}>Book another</button></p>}
    </>
  );
}