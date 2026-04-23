// ═══════════════════════════════════════════════════════════════
// database-webhook-node — Dhruv
//
// Responsibilities:
//   1. Auto-create the `bookings` table in Postgres on startup
//   2. POST /webhook/booking-result  ← receives results from Mohit's worker
//   3. Save each result to Postgres
//   4. Broadcast real-time seat updates to the frontend via Socket.IO
//
// Port: 4000  (matches WEBHOOK_URL in worker-node)
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { Pool }   = require('pg');
const cors       = require('cors');
const client     = require('prom-client');

// Collect default metrics
client.collectDefaultMetrics();

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.WEBHOOK_SERVICE_PORT || 4000;

const pool = new Pool({
  host:     process.env.POSTGRES_HOST     || 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB       || 'postgres',
  user:     process.env.POSTGRES_USER     || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
});

// ─── Express + HTTP + Socket.IO ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ─── Task 2: DB Schema ────────────────────────────────────────────────────────
// Creates the bookings table automatically on first startup
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id          SERIAL PRIMARY KEY,
      idempotency_key VARCHAR(255),
      waitlist_id VARCHAR(255),
      user_id     VARCHAR(255),
      event_id    VARCHAR(255),
      seat_id     VARCHAR(50),
      status      VARCHAR(50),
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS bookings_idempotency_key_uq
    ON bookings (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);
  console.log('[DB] ✅  bookings table ready');
}

function buildIdempotencyKey({ waitlistId, userId, eventId, seatId, status }) {
  return [
    waitlistId || "no_waitlist",
    eventId || "no_event",
    seatId || "no_seat",
    userId || "no_user",
    status || "no_status",
  ].join(":");
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'database-webhook-node', message: 'Database Connected!' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Prometheus Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

// ─── Task 3: Worker Receiver ──────────────────────────────────────────────────
// Mohit's worker sends:
//   POST /webhook/booking-result
//   { status: 'confirmed'|'failed', userId, seatId, eventId, timestamp }
app.post('/webhook/booking-result', async (req, res) => {
  const { status, userId, seatId, eventId, waitlistId, timestamp } = req.body;
  const headerKey = req.get('x-idempotency-key');
  const idempotencyKey = headerKey || buildIdempotencyKey({ waitlistId, userId, eventId, seatId, status });

  // Basic validation
  if (!status || !userId || !seatId || !eventId) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: status, userId, seatId, eventId',
    });
  }

  if (!['confirmed', 'failed'].includes(status)) {
    return res.status(400).json({
      success: false,
      message: "status must be 'confirmed' or 'failed'",
    });
  }

  try {
    // Save to Postgres
    const { rows } = await pool.query(
      `INSERT INTO bookings (idempotency_key, waitlist_id, user_id, event_id, seat_id, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, created_at`,
      [idempotencyKey, waitlistId || null, userId, eventId, seatId, status]
    );

    if (!rows.length) {
      const existing = await pool.query(
        `SELECT id, created_at FROM bookings WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey]
      );
      const booking = existing.rows[0];
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: 'Duplicate webhook ignored',
        bookingId: booking?.id || null,
        createdAt: booking?.created_at || null,
      });
    }

    const booking = rows[0];
    console.log(`[Webhook] 📥  saved  seat=${seatId}  status=${status}  id=${booking.id}`);

    // ─── Task 4: Socket.IO broadcast ─────────────────────────────────────────
    if (status === 'confirmed') {
      // Tell clients in this event room the seat is now sold
      io.to(`event:${eventId}`).emit('seatBooked', { seatId, status: 'sold', bookedBy: userId, eventId });

      // Tell the specific user their booking is confirmed
      io.to(`event:${eventId}`).emit('bookingConfirmed', { waitlistId, seats: [seatId], status: 'confirmed', userId });

      console.log(`[Socket] 📡  seatBooked  → ${seatId}`);
    } else {
      // Seat lock is being released — make it available again on the frontend
      io.to(`event:${eventId}`).emit('seatReleased', { seatId, eventId });
      io.to(`event:${eventId}`).emit('bookingFailed',  { waitlistId, seats: [seatId], status: 'failed', userId });

      console.log(`[Socket] 📡  seatReleased → ${seatId}`);
    }

    res.status(201).json({
      success:   true,
      message:   `Booking ${status} and saved`,
      bookingId: booking.id,
      createdAt: booking.created_at,
    });

  } catch (err) {
    console.error('[Webhook] ❌  DB error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save booking', error: err.message });
  }
});

// Get all bookings (debugging / admin)
app.get('/bookings', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 100');
    res.json({ success: true, count: rows.length, bookings: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Check status of a specific waitlist ID
app.get('/bookings/:waitlistId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE waitlist_id = $1 ORDER BY created_at DESC',
      [req.params.waitlistId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, bookings: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Which seats are confirmed-sold for an event (used by frontend on load)
app.get('/seats/:eventId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT seat_id FROM bookings WHERE event_id = $1 AND status = 'confirmed'`,
      [req.params.eventId]
    );
    res.json({ success: true, soldSeats: rows.map(r => r.seat_id) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Socket.IO connection log ─────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[Socket] 🔌  connected  ${socket.id}`);

  socket.on('joinEvent', ({ eventId }) => {
    socket.join(`event:${eventId}`);
    console.log(`[Socket] ${socket.id} joined room event:${eventId}`);
  });

  socket.on('disconnect', reason =>
    console.log(`[Socket] ❎  disconnected  ${socket.id} (${reason})`)
  );
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await initDatabase();
  server.listen(PORT, () => {
    console.log(`\n══════════════════════════════════════════`);
    console.log(`  Dhruv's DB & Webhook Service`);
    console.log(`  HTTP  → http://localhost:${PORT}`);
    console.log(`  WS    → ws://localhost:${PORT}`);
    console.log(`  Health → GET  /health`);
    console.log(`  Webhook→ POST /webhook/booking-result`);
    console.log(`══════════════════════════════════════════\n`);
  });
}

start().catch(err => {
  console.error('[Fatal] Could not start service:', err.message);
  process.exit(1);
});
