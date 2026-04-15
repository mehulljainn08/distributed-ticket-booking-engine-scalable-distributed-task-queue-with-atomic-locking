package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

type BookingRequest struct {
	UserID     string `json:"user_id"`
	SeatID     string `json:"seat_id"`
	EventID    string `json:"event_id"`
	WaitlistID string `json:"waitlist_id,omitempty"`
	Timestamp  int64  `json:"timestamp"`
}

func lockAndEnqueue(ctx context.Context, client *redis.Client, req BookingRequest) (bool, error) {
	script := `
		if redis.call("setnx", KEYS[1], ARGV[1]) == 1 then
			redis.call("expire", KEYS[1], 30)
			redis.call("rpush", "queue:pending_bookings", ARGV[2])
			return 1
		else
			return 0
		end
		`
	JSON_req, err := json.Marshal(req)
	if err != nil {
		return false, err
	}
	result, err := client.Eval(ctx, script, []string{"lock:event:" + req.EventID + ":seat:" + req.SeatID}, req.UserID, string(JSON_req)).Result()
	if err != nil {
		return false, err
	}
	val, ok := result.(int64)
	if !ok {
		return false, fmt.Errorf("lock not found or unauthorized to release")
	}
	if val == 1 {
		return true, nil
	} else {
		return false, nil
	}
}

func releaseLock(ctx context.Context, client *redis.Client, seatID string, userID string, eventID string) error {
	key := "lock:event:" + eventID + ":seat:" + seatID

	script := `
        if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
        else
            return 0
        end
    `

	result, err := client.Eval(ctx, script, []string{key}, userID).Result()
	if err != nil {
		return err
	}

	val, ok := result.(int64)
	if !ok || val == 0 {
		return fmt.Errorf("lock not found or unauthorized to release")
	}

	return nil
}

func main() {

	env := godotenv.Load()
	if env != nil {
		fmt.Println("Error loading .env file")
	}
	Addr := os.Getenv("REDIS_ADDR")
	Password := os.Getenv("REDIS_PASSWORD")
	if Addr == "" {
		Addr = "localhost:6379"
	}
	if Password == "" {
		Password = ""
	}
	client := redis.NewClient(&redis.Options{
		Addr:         Addr,
		Password:     Password,
		DB:           0,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     50,
		MinIdleConns: 10,
	})

	router := gin.Default()

	router.POST("/book", func(c *gin.Context) {
		var req BookingRequest

		err := c.ShouldBindJSON(&req)

		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		ctx := c.Request.Context()

		lockAcquired, err := lockAndEnqueue(ctx, client, req)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to acquire lock: %v", err)})
			return
		}
		if !lockAcquired {
			c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("Seat %s for event %s is already booked", req.SeatID, req.EventID)})
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"message": fmt.Sprintf("Booking request for seat %s for event %s enqueued successfully", req.SeatID, req.EventID)})

	})

	router.POST("/release", func(c *gin.Context) {
		var req BookingRequest

		err := c.ShouldBindJSON(&req)

		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		ctx := c.Request.Context()

		err = releaseLock(ctx, client, req.SeatID, req.UserID, req.EventID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to release lock: %v", err)})
			return
		}

		c.JSON(http.StatusOK, gin.H{"message": fmt.Sprintf("Booking request for seat %s for event %s released successfully", req.SeatID, req.EventID)})

	})

	port := os.Getenv("ORCHESTRATOR_PORT")

	if port == "" {
		port = "8080"
	}

	router.GET("/metrics", gin.WrapH(promhttp.Handler()))

	fmt.Println("Go Orchestrator running on http://localhost:" + port)
	router.Run(":" + port)

}
