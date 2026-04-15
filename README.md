# Distributed Ticket Booking Engine

A microservices MVP for high-concurrency seat booking using asynchronous processing and Redis-based atomic locking.

## What This MVP Implements

- `POST /book-ticket` accepts booking requests and returns `202` with a waitlist ID.
- Go orchestrator uses Redis `SETNX` lock + queue push atomically.
- Worker pulls queued jobs, simulates payment, and reports outcome by webhook.
- Database webhook service persists booking outcomes in Postgres.
- Socket.IO broadcasts seat updates in real time to the frontend.
- Prometheus metrics endpoints are exposed by core services.

## Architecture

1. `api-gateway-node` (Node.js/Express)
2. `orchestrator-go` (Go + Redis lock/queue)
3. `worker-node` (Node.js consumer)
4. `database-webhook-node` (Node.js + Postgres + Socket.IO)
5. `frontend-ui` (React + Vite)

## Local Setup

### Prerequisites

- Docker + Docker Compose
- Node.js 18+
- Go 1.22+ (optional, for local Go tooling)

### 1. Configure environment

`.env` is already included for local defaults. Update credentials/ports if needed.

### 2. Start backend services

```bash
docker-compose up -d --build
```

### 3. Start frontend

```bash
cd frontend-ui
npm install
npm run dev
```

Frontend: `http://localhost:5173`

## Core APIs

- Gateway health: `GET http://localhost:3000/health`
- Book ticket: `POST http://localhost:3000/book-ticket`
- Orchestrator lock+enqueue: `POST http://localhost:8080/book`
- Worker health: `GET http://localhost:5000/health`
- Webhook receiver: `POST http://localhost:4000/webhook/booking-result`
- Booking lookup: `GET http://localhost:4000/bookings/:waitlistId`
- Event sold seats: `GET http://localhost:4000/seats/:eventId`

## Testing

### Integration test (Gateway -> Orchestrator -> Redis -> Worker -> DB/Webhook)

```bash
node tests/integration_test.js
```

### k6 load test (direct orchestrator contention/throughput)

```bash
k6 run tests/load_test.js
```

### Go load bench (via Gateway)

```bash
go run tests/load_bench.go
```

## Notes

- Lock TTL is 30 seconds in orchestrator.
- Worker posts idempotent webhook events using `X-Idempotency-Key`.
- Current orchestrator MVP does not include heartbeat-based worker requeue logic.
