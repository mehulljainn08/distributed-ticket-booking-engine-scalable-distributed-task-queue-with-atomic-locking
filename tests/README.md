# 🚀 Orchestrator Load Testing Suite

This directory contains scripts to stress-test the Orchestrator's handling of atomic locks and high-concurrency booking requests.

---

## 🛠️ Option 1: k6 (Recommended for Metrics)

**k6** provides detailed performance reports, including P95 latency and error rates.

### 1. Install k6
- **macOS**: `brew install k6`
- **Docker**: `docker pull grafana/k6`
- **Other**: [k6 Installation Guide](https://k6.io/docs/getting-started/installation/)

### 2. Run the Test
```bash
# Run with default options
k6 run tests/load_test.js

# Override the Base URL (e.g., if running in Docker)
k6 run -e BASE_URL=http://localhost:8080 tests/load_test.js
```

---

## ⚡ Option 2: Go (High-Performance / Zero-Dependency)

A lightweight Go script using goroutines to fire concurrent requests. 

### 1. Run the Test
```bash
go run tests/load_bench.go
```

---

## 🧪 What These Tests Do

### 🥊 The Contention Test
50 virtual users simultaneously attempt to book **the exact same seat** (`seat_VIP_01`).
- **Expected Result**: Exactly **one user** should get a `202 Accepted`. All others should receive a `409 Conflict`.
- **Validation**: If multiple users get a `202` for the same seat without release flow, there's a race condition in the locking logic.

### 🚀 The Throughput Test (k6 only)
Ramps up to 100 concurrent users booking **unique seats**.
- **Expected Result**: High success rate and low latency as requests are enqueued into Redis.
