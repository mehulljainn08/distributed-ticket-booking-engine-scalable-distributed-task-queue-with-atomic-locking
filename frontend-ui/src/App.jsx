import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Header from './components/Header';
import EventBanner from './components/EventBanner';
import LiveTraffic from './components/LiveTraffic';
import SeatMap from './components/SeatMap';
import BookingSummary from './components/BookingSummary';
import WaitlistModal from './components/WaitlistModal';
import { generateSeats, getSeatStats, MAX_SELECTABLE } from './data/seatData';
import { submitBookingRequest, fetchEventSeats } from './api/bookingService';
import { initSocket, onSeatUpdate, onBookingConfirmed, onBookingFailed, disconnectSocket, emitSeatLockRequest, joinEventRoom } from './socket/seatSocket';
import './App.css';

// ── Event metadata (future: fetch from GET /events/:id) ──────────
const EVENT = {
  id:       'EVT-2025-COLDPLAY-MUM-01',
  name:     'Coldplay',
  subtitle: 'Music of the Spheres World Tour',
  venue:    'DY Patil Sports Stadium',
  city:     'Mumbai, India',
  date:     'Saturday, 19 January 2025',
  time:     '7:30 PM IST',
  duration: '3 hrs 15 mins',
  ageLimit: 'All ages',
  tags:     ['Live Music', 'Rock', 'Pop', 'Concert'],
  totalCapacity: 120,
};

// ── Booking phase state machine ───────────────────────────────────
// 'idle' → 'submitting' → 'waitlisted'
//                       ↘ 'error'
const PHASE = {
  IDLE:        'idle',
  SUBMITTING:  'submitting',
  WAITLISTED:  'waitlisted',
  ERROR:       'error',
};

export default function App() {
  const [seats, setSeats] = useState(generateSeats);
  const [phase, setPhase] = useState(PHASE.IDLE);
  const [waitlistInfo, setWaitlistInfo] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [toasts, setToasts] = useState([]);
  const [flashSeat, setFlashSeat] = useState(null);
  const toastIdRef = useRef(0);
  const activeWaitlistRef = useRef(null);
  const activeUserIdRef = useRef(null);
  const bookingTrackerRef = useRef(null);

  // ── Derived state ─────────────────────────────────────────────
  const selectedSeats = useMemo(
    () => Object.values(seats).filter(s => s.status === 'selected'),
    [seats]
  );

  const totalAmount = useMemo(
    () => selectedSeats.reduce((sum, s) => sum + s.price, 0),
    [selectedSeats]
  );

  const seatStats = useMemo(() => getSeatStats(seats), [seats]);

  // ── Socket & API: real-time seat updates and initial seat load ──
  useEffect(() => {
    initSocket();
    joinEventRoom(EVENT.id);

    fetchEventSeats(EVENT.id).then(soldSeats => {
      if (soldSeats && soldSeats.length > 0) {
        setSeats(prev => {
          const updated = { ...prev };
          soldSeats.forEach(id => {
            if (updated[id]) updated[id].status = 'sold';
          });
          return updated;
        });
      }
    });

    const unsubSeat = onSeatUpdate(({ seatId, status, bookedBy }) => {
      let wasSelected = false;
      setSeats(prev => {
        if (!prev[seatId] || prev[seatId].status === status) return prev;
        wasSelected = prev[seatId].status === 'selected' && status === 'sold';
        return { ...prev, [seatId]: { ...prev[seatId], status } };
      });

      if (status === 'sold' && wasSelected) {
        if (bookedBy && activeUserIdRef.current && bookedBy === activeUserIdRef.current) {
          return;
        }
        addToast(`Seat ${seatId} was just taken by another user!`, 'warn');
        setFlashSeat(seatId);
        setTimeout(() => setFlashSeat(null), 1000);
      }
    });

    const unsubConfirmed = onBookingConfirmed(({ waitlistId, seats: confirmedSeats = [] }) => {
      if (!waitlistId || activeWaitlistRef.current !== waitlistId) return;

      setSeats(prev => {
        const updated = { ...prev };
        confirmedSeats.forEach(id => {
          if (updated[id]) updated[id] = { ...updated[id], status: 'sold' };
        });
        return updated;
      });

      const tracker = bookingTrackerRef.current;
      if (tracker && tracker.waitlistId === waitlistId) {
        confirmedSeats.forEach(id => {
          tracker.pending.delete(id);
          tracker.confirmed.add(id);
        });

        if (tracker.pending.size === 0) {
          if (tracker.failed.size === 0) {
            addToast(`Booking confirmed for ${Array.from(tracker.confirmed).join(', ')}.`, 'info');
            setPhase(PHASE.IDLE);
          } else if (tracker.confirmed.size === 0) {
            setErrorMsg('Booking failed for all seats during payment processing.');
            setPhase(PHASE.ERROR);
          } else {
            addToast(
              `Partial booking: confirmed ${Array.from(tracker.confirmed).join(', ')}, failed ${Array.from(tracker.failed).join(', ')}.`,
              'warn'
            );
            setPhase(PHASE.IDLE);
          }
          setWaitlistInfo(null);
          activeWaitlistRef.current = null;
          activeUserIdRef.current = null;
          bookingTrackerRef.current = null;
        }
      }
    });

    const unsubFailed = onBookingFailed(({ waitlistId, seats: failedSeats = [] }) => {
      if (!waitlistId || activeWaitlistRef.current !== waitlistId) return;

      setSeats(prev => {
        const updated = { ...prev };
        failedSeats.forEach(id => {
          if (updated[id]) updated[id] = { ...updated[id], status: 'available' };
        });
        return updated;
      });

      const tracker = bookingTrackerRef.current;
      if (tracker && tracker.waitlistId === waitlistId) {
        failedSeats.forEach(id => {
          tracker.pending.delete(id);
          tracker.failed.add(id);
        });

        if (tracker.pending.size === 0) {
          if (tracker.confirmed.size === 0) {
            setErrorMsg('Booking failed for all seats during payment processing.');
            setPhase(PHASE.ERROR);
          } else {
            addToast(
              `Partial booking: confirmed ${Array.from(tracker.confirmed).join(', ')}, failed ${Array.from(tracker.failed).join(', ')}.`,
              'warn'
            );
            setPhase(PHASE.IDLE);
          }
          setWaitlistInfo(null);
          activeWaitlistRef.current = null;
          activeUserIdRef.current = null;
          bookingTrackerRef.current = null;
        }
      }
    });

    return () => {
      unsubSeat();
      unsubConfirmed();
      unsubFailed();
      disconnectSocket();
    };
  }, []);

  // ── Toast notification helper ─────────────────────────────────
  const addToast = useCallback((message, type = 'info') => {
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  // ── Seat click handler ────────────────────────────────────────
  const handleSeatClick = useCallback((seatId) => {
    setSeats(prev => {
      const seat = prev[seatId];
      if (!seat || seat.status === 'sold') return prev;

      const currentlySelected = Object.values(prev).filter(s => s.status === 'selected').length;

      // Enforce max selection limit
      if (seat.status === 'available' && currentlySelected >= MAX_SELECTABLE) {
        addToast(`You can select up to ${MAX_SELECTABLE} seats at a time.`, 'warn');
        return prev;
      }

      const newStatus = seat.status === 'selected' ? 'available' : 'selected';
      return { ...prev, [seatId]: { ...seat, status: newStatus } };
    });
  }, [addToast]);

  // ── Book tickets handler ──────────────────────────────────────
  const handleBookTickets = async () => {
    if (selectedSeats.length === 0 || phase === PHASE.SUBMITTING) return;

    const seatIds = selectedSeats.map(s => s.id);
    const userId = `USR-${Date.now().toString(36).toUpperCase()}`;

    // Emit optimistic lock request to Redis layer
    emitSeatLockRequest(seatIds, userId);

    setPhase(PHASE.SUBMITTING);

    const payload = {
      eventId:   EVENT.id,
      userId,
      seats:     seatIds,
      timestamp: Date.now(),
    };

    try {
      const result = await submitBookingRequest(payload);
      const accepted = result.acceptedSeats || [];
      const failed = result.failedSeats || [];

      if (failed.length > 0) {
        setSeats(prev => {
          const updated = { ...prev };
          failed.forEach(id => {
            if (updated[id]) updated[id] = { ...updated[id], status: 'available' };
          });
          return updated;
        });
        addToast(`Unavailable seats: ${failed.join(', ')}`, 'warn');
      }

      if (accepted.length === 0) {
        setErrorMsg('All requested seats were unavailable. Please choose different seats.');
        setPhase(PHASE.ERROR);
        return;
      }

      setWaitlistInfo(result);
      activeWaitlistRef.current = result.waitlistId;
      activeUserIdRef.current = userId;
      bookingTrackerRef.current = {
        waitlistId: result.waitlistId,
        pending: new Set(accepted),
        confirmed: new Set(),
        failed: new Set(failed),
      };
      setPhase(PHASE.WAITLISTED);

    } catch (err) {
      console.error('[Booking] Failed:', err.message);
      setErrorMsg(err.message || 'An unexpected error occurred.');
      setPhase(PHASE.ERROR);
      activeWaitlistRef.current = null;
      activeUserIdRef.current = null;
      bookingTrackerRef.current = null;

      // Auto-recover after 4s
      setTimeout(() => {
        setPhase(PHASE.IDLE);
        setErrorMsg('');
      }, 4000);
    }
  };

  // ── Close waitlist modal ──────────────────────────────────────
  const handleCloseModal = useCallback(() => {
    setPhase(PHASE.IDLE);
    setWaitlistInfo(null);
    setErrorMsg('');
    activeWaitlistRef.current = null;
    activeUserIdRef.current = null;
    bookingTrackerRef.current = null;
  }, []);

  // ── Remove toast ──────────────────────────────────────────────
  const dismissToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <div className="app">
      {/* Grain overlay for texture */}
      <div className="app__grain" aria-hidden="true" />

      <Header event={EVENT} seatStats={seatStats} />

      <main className="app__main">
        <div className="app__layout">
          {/* ── Left column: map + event info ── */}
          <section className="app__left">
            <EventBanner event={EVENT} seatStats={seatStats} />
            <LiveTraffic soldCount={seatStats.sold} totalCount={seatStats.total} />
            <SeatMap
              seats={seats}
              flashSeat={flashSeat}
              onSeatClick={handleSeatClick}
            />
          </section>

          {/* ── Right column: sticky booking summary ── */}
          <aside className="app__right">
            <BookingSummary
              seats={seats}
              selectedSeats={selectedSeats}
              totalAmount={totalAmount}
              phase={phase}
              errorMsg={errorMsg}
              onBook={handleBookTickets}
              onDeselect={handleSeatClick}
            />
          </aside>
        </div>
      </main>

      {/* ── Waitlist modal ── */}
      {(phase === PHASE.WAITLISTED || phase === PHASE.ERROR) && (
        <WaitlistModal
          phase={phase}
          waitlistInfo={waitlistInfo}
          errorMsg={errorMsg}
          onClose={handleCloseModal}
        />
      )}

      {/* ── Toast notifications ── */}
      <div className="app__toasts" aria-live="polite">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`toast toast--${toast.type}`}
            onClick={() => dismissToast(toast.id)}
          >
            <span className="toast__icon">
              {toast.type === 'warn' ? '⚡' : toast.type === 'error' ? '✕' : 'ℹ'}
            </span>
            <span className="toast__msg">{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
