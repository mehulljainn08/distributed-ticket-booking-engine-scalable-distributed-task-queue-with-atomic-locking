// ═══════════════════════════════════════════════════════════════
// bookingService.js — API Layer
//
// PURPOSE: Single source of truth for all HTTP interactions.
// Currently uses mock implementations for frontend-only sprint.
//
// FUTURE INTEGRATION:
//   Set VITE_API_BASE_URL in .env.local when backend is ready.
//   Swap mock* functions for real fetch() calls.
//   This file is the ONLY place that needs to change.
// ═══════════════════════════════════════════════════════════════

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Submit a ticket booking request to the API Gateway.
 *
 * Backend contract (once your teammate's Express gateway is ready):
 *   POST /book-ticket
 *   Body: { eventId, userId, seats: string[], timestamp: number }
 *
 *   Response (immediate — does NOT wait for worker to process):
 *   { waitlistId: "WL12345", position: 47, estimatedTime: 15, timestamp: ISO }
 *
 *   Notes:
 *   - The gateway immediately returns a waitlist ID (async pattern).
 *   - The actual booking is processed by worker nodes.
 *   - Redis atomic lock prevents double-booking same seat.
 *   - Final confirmation arrives via socket event (see seatSocket.js).
 *
 * @param {{ eventId: string, userId: string, seats: string[], timestamp: number }} payload
 * @returns {Promise<{ waitlistId: string, position: number, estimatedTime: number, timestamp: string }>}
 */
export async function submitBookingRequest(payload) {
  const { eventId, userId, seats, timestamp } = payload;
  
  const res = await fetch(`${API_BASE_URL}/book-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': crypto.randomUUID(),          // Idempotency key
      'X-Client-Version': '1.0.0',
    },
    body: JSON.stringify({ eventId, userId, seats, timestamp }),
    signal: AbortSignal.timeout(10_000),             // 10s timeout
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new APIError(res.status, err.message || 'Booking Request failed');
  }

  const data = await res.json();

  // Map Gateway response to what the UI expects
  return {
    waitlistId: data.waitlistId || 'unknown',
    acceptedSeats: data.acceptedSeats || [],
    failedSeats: data.failedSeats || [],
    position: 0,
    estimatedTime: 0,
    workerNode: 'distributed',
    redisLockAcquired: (data.acceptedSeats?.length || 0) > 0,
  };
}


/**
 * Poll booking status by waitlist ID.
 *
 * Future endpoint: GET /booking-status/:waitlistId
 * Response: { waitlistId, status: 'PENDING'|'PROCESSING'|'CONFIRMED'|'FAILED', updatedAt }
 *
 * @param {string} waitlistId
 * @returns {Promise<{ waitlistId: string, status: string, updatedAt: string }>}
 */
export async function getBookingStatus(waitlistId) {
  try {
    const response = await fetch(`${SOCKET_URL}/bookings/${waitlistId}`, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new APIError(response.status, 'Status check failed');
    
    const data = await response.json();
    if (data.success && data.bookings && data.bookings.length > 0) {
      // Find if any seat is failed, otherwise return first seat's status
      const failed = data.bookings.find(b => b.status === 'failed');
      const confirmed = data.bookings.find(b => b.status === 'confirmed');
      
      const status = failed ? 'FAILED' : (confirmed ? 'CONFIRMED' : 'PENDING');
      return {
        waitlistId,
        status,
        updatedAt: data.bookings[0].created_at
      };
    }
  } catch (err) {
    console.error('Failed to get booking status:', err);
  }
  
  return {
    waitlistId,
    status: 'PENDING',
    updatedAt: new Date().toISOString()
  };
}

export async function fetchEventSeats(eventId) {
  try {
    const response = await fetch(`${SOCKET_URL}/seats/${eventId}`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.soldSeats || [];
  } catch (err) {
    console.error('Failed to fetch event seats:', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM ERROR CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class APIError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'APIError';
    this.status = status;
  }
}
