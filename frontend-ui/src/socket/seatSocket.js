// ═══════════════════════════════════════════════════════════════
// seatSocket.js — Real-Time Seat Update Service
//
// PURPOSE: Abstracts all WebSocket / Socket.IO interactions.
// Connects to your teammate's DB + webhook/socket update system.
//
// ARCHITECTURE:
//   Backend emits 'seatBooked' → Frontend marks seat as sold.
//   Redis atomic lock ensures no two users book the same seat.
//
// FUTURE INTEGRATION:
//   npm install socket.io-client
//   Set VITE_SOCKET_URL in .env.local
//   Uncomment the socket.io block below.
// ═══════════════════════════════════════════════════════════════

import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

let _socket = null;
let _seatUpdateHandlers  = [];
let _connectionHandlers  = [];
let _bookingConfirmHandlers = [];
let _mockTimers = [];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the socket connection.
 * Call once on app mount.
 */
export function initSocket() {
  _socket = io(SOCKET_URL, {
    transports: ['websocket'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
    auth: { token: localStorage.getItem('auth_token') },
  });

  _socket.on('connect', () => {
    console.log('[Socket] Connected:', _socket.id);
    _connectionHandlers.forEach(h => h({ connected: true, id: _socket.id }));
  });

  _socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected:', reason);
    _connectionHandlers.forEach(h => h({ connected: false }));
  });

  // Teammate's backend emits this event when a seat is booked by any user
  _socket.on('seatBooked', ({ seatId, status, bookedBy }) => {
    _seatUpdateHandlers.forEach(h => h({ seatId, status: 'sold' }));
  });

  // Teammate's backend emits this when Redis lock expires + seat is released
  _socket.on('seatReleased', ({ seatId }) => {
    _seatUpdateHandlers.forEach(h => h({ seatId, status: 'available' }));
  });

  // Worker node emits when YOUR waitlisted booking is confirmed
  _socket.on('bookingConfirmed', ({ waitlistId, seats, status }) => {
    _bookingConfirmHandlers.forEach(h => h({ waitlistId, seats, status }));
  });
}

/**
 * Subscribe to real-time seat status changes.
 * Fires whenever another user books a seat.
 *
 * @param {function({ seatId: string, status: 'sold'|'available' }): void} handler
 * @returns {function} unsubscribe function
 */
export function onSeatUpdate(handler) {
  _seatUpdateHandlers.push(handler);
  return () => {
    _seatUpdateHandlers = _seatUpdateHandlers.filter(h => h !== handler);
  };
}

/**
 * Subscribe to your booking confirmation events (from worker node).
 * Fires when your waitlisted booking is processed.
 *
 * @param {function({ waitlistId: string, seats: string[], status: string }): void} handler
 * @returns {function} unsubscribe function
 */
export function onBookingConfirmed(handler) {
  _bookingConfirmHandlers.push(handler);
  return () => {
    _bookingConfirmHandlers = _bookingConfirmHandlers.filter(h => h !== handler);
  };
}

/**
 * Subscribe to connection status changes.
 * @param {function({ connected: boolean, id?: string }): void} handler
 * @returns {function} unsubscribe function
 */
export function onConnectionChange(handler) {
  _connectionHandlers.push(handler);
  return () => {
    _connectionHandlers = _connectionHandlers.filter(h => h !== handler);
  };
}

/**
 * Request optimistic seat lock before booking.
 * Informs Redis layer that this client is about to attempt booking.
 *
 * Future: socket.emit('lockSeats', { seatIds, userId, ttlMs: 30000 });
 *
 * @param {string[]} seatIds
 * @param {string} userId
 */
export function emitSeatLockRequest(seatIds, userId) {
    _socket.emit('lockSeats', { seatIds, userId, ttlMs: 30000 });
  console.debug('[Socket] Lock request (stub):', seatIds);
}

/**
 * Join an event's socket room to receive its seat updates.
 * Future: socket.emit('joinEvent', { eventId });
 *
 * @param {string} eventId
 */
export function joinEventRoom(eventId) {
  if (_socket) {
    _socket.emit('joinEvent', { eventId });
  }
}

export function disconnectSocket() {
  if (_socket) {
    _socket.disconnect();
  }
}

