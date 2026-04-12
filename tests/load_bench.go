package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// GatewayBookingRequest matches the API Gateway's /book-ticket endpoint
type GatewayBookingRequest struct {
	UserID  string   `json:"userId"`
	EventID string   `json:"eventId"`
	Seats   []string `json:"seats"`
}

const (
	// Gateway is exposed via Nginx on port 3000
	baseURL = "http://localhost:3000"
	vus     = 50 // Virtual Users
	iters   = 20 // Iterations per VU
)

func main() {
	var wg sync.WaitGroup
	var successCount, conflictCount, errorCount int64
	var mu sync.Mutex

	fmt.Printf("🚀 Starting Load Test with %d VUs and %d Iterations per VU...\n", vus, iters)
	start := time.Now()

	for i := 0; i < vus; i++ {
		wg.Add(1)
		go func(vuID int) {
			defer wg.Done()
			for j := 0; j < iters; j++ {
				// ── Scenario: Contention on seat_VIP_01 ──
				userID := fmt.Sprintf("vu_%d_user_%d", vuID, j)

				// ── Try to Book via Gateway ──
				status := attemptBook(userID, "seat_VIP_01", "concert_2026")

				mu.Lock()
				switch {
				case status == 202:
					successCount++
				case status == 409 || status == 400:
					conflictCount++
				default:
					errorCount++
				}
				mu.Unlock()
			}
		}(i)
	}

	wg.Wait()
	duration := time.Since(start)

	fmt.Println("\n📊 Performance Results:")
	fmt.Printf("  ✅ Successful Bookings (Enqueued): %d\n", successCount)
	fmt.Printf("  🥊 Conflicts / Rejected: %d\n", conflictCount)
	fmt.Printf("  ❌ Errors: %d\n", errorCount)
	fmt.Printf("  ⏱️ Total Duration: %v\n", duration)
	fmt.Printf("  ⚡ Requests Per Second: %.2f req/s\n", float64(vus*iters)/duration.Seconds())
}

func attemptBook(userID, seatID, eventID string) int {
	reqBody, _ := json.Marshal(GatewayBookingRequest{
		UserID:  userID,
		EventID: eventID,
		Seats:   []string{seatID},
	})

	resp, err := http.Post(baseURL+"/book-ticket", "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		fmt.Printf("error: %v\n", err)
		return 500
	}
	defer resp.Body.Close()
	return resp.StatusCode
}
