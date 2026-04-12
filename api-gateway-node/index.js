const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || "http://localhost:8080";

// Health Check
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// Booking API
app.post("/book-ticket", async (req, res) => {
    try {
        const { seats, userId, eventId } = req.body;

        // validation
        if (!Array.isArray(seats) || seats.length === 0) {
            return res.status(400).json({ error: "Seats must be a non-empty array" });
        }

        if (!userId || !eventId) {
            return res.status(400).json({ error: "userId and eventId are required" });
        }

        // Optional: seat format validation (basic)
        const invalidSeats = seats.filter(seat => typeof seat !== "string" || seat.length < 2);
        if (invalidSeats.length > 0) {
            return res.status(400).json({ error: "Invalid seat IDs", invalidSeats });
        }

        // Generate waitlistId BEFORE calling orchestrator so it flows through the entire pipeline
        const waitlistId = "wl_" + Date.now();

        const acceptedSeats = [];
        const failedSeats = [];
        const requests = seats.map(async (seat) => {
            try {
                await axios.post(`${ORCHESTRATOR_URL}/book`, {
                    seat_id: seat,
                    user_id: userId,
                    event_id: eventId,
                    waitlist_id: waitlistId
                });
                acceptedSeats.push(seat);
            } catch (err) {
                failedSeats.push(seat);
            }
        });

        // Wait for all requests
        await Promise.all(requests);

        // RESPONSE
        return res.status(202).json({
            success: true,
            waitlistId,
            requestedSeats: seats,
            acceptedSeats,
            failedSeats
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

const PORT = process.env.API_GATEWAY_PORT || process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);
});