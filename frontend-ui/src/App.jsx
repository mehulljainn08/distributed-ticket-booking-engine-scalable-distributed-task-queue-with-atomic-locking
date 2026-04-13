import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Header from './components/Header';
import EventBanner from './components/EventBanner';
import LiveTraffic from './components/LiveTraffic';
import SeatMap from './components/SeatMap';
import BookingSummary from './components/BookingSummary';
import WaitlistModal from './components/WaitlistModal';
import { generateSeats, getSeatStats, MAX_SELECTABLE } from './data/seatData';
import { submitBookingRequest, fetchEventSeats } from './api/bookingService';
import { initSocket, onSeatUpdate, disconnectSocket, emitSeatLockRequest, joinEventRoom } from './socket/seatSocket';
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

    const unsub = onSeatUpdate(({ seatId, status }) => {
      setSeats(prev => {
        if (!prev[seatId] || prev[seatId].status === status) return prev;
        return { ...prev, [seatId]: { ...prev[seatId], status } };
      });

      if (status === 'sold') {
        // If user had selected this seat, deselect and notify
        setSeats(prev => {
          if (prev[seatId]?.status === 'selected') {
            addToast(`Seat ${seatId} was just taken by another user!`, 'warn');
          }
          return prev; // already updated above
        });

        setFlashSeat(seatId);
        setTimeout(() => setFlashSeat(null), 1000);
      }
    });

    return () => {
      unsub();
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

    // Emit optimistic lock request to Redis layer
    emitSeatLockRequest(seatIds, `USR-${Date.now().toString(36).toUpperCase()}`);

    setPhase(PHASE.SUBMITTING);

    const payload = {
      eventId:   EVENT.id,
      userId:    `USR-${Date.now().toString(36).toUpperCase()}`,
      seats:     seatIds,
      timestamp: Date.now(),
    };

    try {
      const result = await submitBookingRequest(payload);

      // Optimistically mark seats as sold (backend confirmed receipt)
      setSeats(prev => {
        const updated = { ...prev };
        seatIds.forEach(id => {
          if (updated[id]) updated[id] = { ...updated[id], status: 'sold' };
        });
        return updated;
      });

      setWaitlistInfo(result);
      setPhase(PHASE.WAITLISTED);

    } catch (err) {
      console.error('[Booking] Failed:', err.message);
      setErrorMsg(err.message || 'An unexpected error occurred.');
      setPhase(PHASE.ERROR);

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
