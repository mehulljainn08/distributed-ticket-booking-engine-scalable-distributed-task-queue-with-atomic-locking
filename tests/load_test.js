import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    // 1. Contention Scenario: Many users hitting the SAME seat
    scenarios: {
        contention: {
            executor: 'constant-vus',
            vus: 50,
            duration: '10s',
            gracefulStop: '5s',
        },
        // 2. High Throughput: Many users hitting UNIQUE seats
        ramp_up: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: '30s', target: 100 },
                { duration: '1m', target: 100 },
                { duration: '30s', target: 0 },
            ],
            startTime: '10s',
        },
    },
    thresholds: {
        http_req_failed: ['rate<0.01'], // <1% actual server errors (500s)
        http_req_duration: ['p(95)<200'], // 95% of requests < 200ms
    },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';

export default function () {
    const scenario = __ITER % 2 === 0 ? 'contention' : 'throughput';
    
    // For contention, all users try the same seatID
    const seatID = scenario === 'contention' ? 'seat_VIP_01' : `seat_${__VU}_${__ITER}`;
    const userID = `user_${__VU}_${__ITER}`;
    const eventID = 'concert_2026';

    const payload = JSON.stringify({
        user_id: userID,
        seat_id: seatID,
        event_id: eventID,
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    // ── Attempt to Book ──
    const res = http.post(`${BASE_URL}/book`, payload, params);

    check(res, {
        'status is 202 (Accepted) or 409 (Conflict)': (r) => [202, 409].includes(r.status),
        'status is not 500': (r) => r.status !== 500,
    });

    // If we won the lock, simulation release after a small delay
    if (res.status === 202) {
        sleep(0.5); // Simulation processing
        const relRes = http.post(`${BASE_URL}/release`, payload, params);
        check(relRes, {
            'release status is 200': (r) => r.status === 200,
        });
    }

    sleep(0.1);
}
