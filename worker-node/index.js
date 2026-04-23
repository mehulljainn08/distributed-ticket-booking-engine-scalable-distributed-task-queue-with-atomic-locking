const Redis = require("ioredis");
const axios = require("axios");
const express = require("express");
const client = require("prom-client");

// Collect default metrics
client.collectDefaultMetrics();

// Custom metrics
const processedJobsCounter = new client.Counter({
  name: "worker_processed_jobs_total",
  help: "Total number of jobs processed by the worker",
});

const successfulJobsCounter = new client.Counter({
  name: "worker_successful_jobs_total",
  help: "Total number of successful jobs processed by the worker",
});

const failedJobsCounter = new client.Counter({
  name: "worker_failed_jobs_total",
  help: "Total number of failed jobs processed by the worker",
});

// ---------------------------------------------------------------------------
// ENV CONFIGURATION
// ---------------------------------------------------------------------------
// Docker-compose passes REDIS_ADDR as "redis:6379" (host:port combined).
// We parse it so ioredis gets separate host & port values.


const CONCURRENCY = 10;

const REDIS_ADDR = process.env.REDIS_ADDR || "localhost:6379";
const [REDIS_HOST, REDIS_PORT] = REDIS_ADDR.includes(":")
  ? [REDIS_ADDR.split(":")[0], parseInt(REDIS_ADDR.split(":")[1], 10)]
  : [REDIS_ADDR, 6379];

const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

const WEBHOOK_URL =
  process.env.WEBHOOK_URL || "http://localhost:4000/webhook/booking-result";

// Orchestrator URL — needed to release seat locks on payment failure
const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL || "http://orchestrator:8080";

const WORKER_PORT = process.env.WORKER_PORT || 5000;

// ---------------------------------------------------------------------------
// REDIS CLIENT
// ---------------------------------------------------------------------------
const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    console.log(`[Redis] Reconnecting in ${delay}ms... (attempt ${times})`);
    return delay;
  },
});

redis.on("connect", () =>
  console.log(`[Redis] Connected to ${REDIS_HOST}:${REDIS_PORT}`)
);
redis.on("error", (err) =>
  console.error("[Redis] Connection error:", err.message)
);


// HEALTH CHECK SERVER
const app = express();
app.use(express.json());

let processedCount = 0;
let successCount = 0;
let failureCount = 0;

app.get("/health", (req, res) => {
  res.json({
    status: "Worker is running",
    stats: {
      processed: processedCount,
      confirmed: successCount,
      failed: failureCount,
    },
  });
});

app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

app.listen(WORKER_PORT, () => {
  console.log(
    `[Worker] 🔧 Health server on http://localhost:${WORKER_PORT}/health`
  );
});


// PAYMENT SIMULATION
function simulatePayment() {
  return new Promise((resolve) => {
    const delayMs = Math.floor(Math.random() * 4000) + 1000;
    const isSuccess = true; // 100% success rate for reliable multi-seat booking testing

    console.log(
      `[Worker] Processing payment (${(delayMs / 1000).toFixed(1)}s delay)...`
    );

    setTimeout(() => resolve(isSuccess), delayMs);
  });
}


// RELEASE LOCK — called when payment fails so the seat is freed immediately
// instead of waiting for the 10s Redis TTL to expire.

async function releaseSeatLock(userId, seatId, eventId) {
  try {
    await axios.post(`${ORCHESTRATOR_URL}/release`, {
      user_id: userId,
      seat_id: seatId,
      event_id: eventId,
    });
    console.log(
      `[Worker] Lock released: Seat ${seatId} for event ${eventId}`
    );
  } catch (err) {
    // Non-fatal: the lock will still auto-expire after TTL
    console.warn(
      `[Worker] Failed to release lock (will auto-expire): ${err.message}`
    );
  }
}


// WEBHOOK NOTIFICATION
function buildIdempotencyKey(payload) {
  return [
    payload.waitlistId || "no_waitlist",
    payload.eventId || "no_event",
    payload.seatId || "no_seat",
    payload.userId || "no_user",
    payload.status || "no_status",
  ].join(":");
}

async function notifyWebhook(payload, retries = 3) {
  const idempotencyKey = buildIdempotencyKey(payload);

  for (let i = 0; i < retries; i++) {
    try {
      await axios.post(WEBHOOK_URL, payload, {
        headers: {
          "X-Idempotency-Key": idempotencyKey,
        },
      });
      console.log(`[Worker] Webhook notified → ${payload.status}`);
      return;
    } catch (err) {
      if (i === retries - 1) {
        console.error(`[Worker] Webhook failed after ${retries} attempts: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// GRACEFUL SHUTDOWN
let shuttingDown = false;

process.on('SIGTERM', () => {
  console.log('[Worker] 🛑 SIGTERM received, finishing current jobs...');
  shuttingDown = true;
});
process.on('SIGINT', () => {
  console.log('[Worker] 🛑 SIGINT received, finishing current jobs...');
  shuttingDown = true;
});

// MAIN QUEUE CONSUMER

async function consumeQueue() {
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => workerLoop(i));
  await Promise.all(workers);
}

async function workerLoop(workerId) {
  while (!shuttingDown) {
    // brpop → process → repeat (each worker independently)
    try {
      // 2-second timeout allows loop to check if shuttingDown is true
      const result = await redis.brpop("queue:pending_bookings", 2);

      if (!result) continue;

      const raw = result[1];
      let job;

      try {
        job = JSON.parse(raw);
      } catch (parseErr) {
        console.error("[Worker] ❌ Bad JSON in queue, skipping:", raw);
        continue;
      }

      processedCount++;
      processedJobsCounter.inc();

      const seatId = job.seatId || job.seat_id || "unknown";
      const userId = job.userId || job.user_id || "unknown";
      const eventId = job.eventId || job.event_id || "unknown";
      const waitlistId = job.waitlistId || job.waitlist_id || null;

      console.log(
        `[Worker ${workerId}] Processing booking: ${userId} → ${eventId}/${seatId}`
      );

      const isSuccess = await simulatePayment();

      if (isSuccess) {
        successCount++;
        successfulJobsCounter.inc();
        console.log(
          `[Worker ${workerId}] Payment success → ${eventId}/${seatId}`
        );
        await notifyWebhook({
          status: "confirmed",
          userId,
          seatId,
          eventId,
          waitlistId,
          timestamp: Date.now(),
        });
      } else {
        failureCount++;
        failedJobsCounter.inc();
        console.log(
          `[Worker ${workerId}] Payment failed → ${eventId}/${seatId}`
        );

        await releaseSeatLock(userId, seatId, eventId);

        await notifyWebhook({
          status: "failed",
          userId,
          seatId,
          eventId,
          waitlistId,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.error("[Worker] Error in loop:", err.message);
    }
  }
}

consumeQueue();
