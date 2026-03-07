require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const db        = require("./db");

// Prevent unhandled promise rejections (e.g. whatsapp-web.js EBUSY on Windows) from crashing the process
process.on("unhandledRejection", (reason) => {
    // Suppress noisy library-internal error from whatsapp-web.js during browser teardown
    if (reason?.message?.includes("Execution context was destroyed")) return;
    console.error("[unhandledRejection] caught — server will NOT crash:", reason);
});

const usersRouter        = require("./routes/users");
const adminsAuthRouter   = require("./routes/admins");
const instanceRoutes     = require("./routes/instance");
const adminDashRouter    = require("./routes/adminDashboard");
const paymentsRouter     = require("./routes/payments");
const superadminRouter   = require("./routes/superadmin");
const { restoreActiveSessions } = require("./controllers/instanceController");

const PORT = process.env.PORT || 3000;
const app  = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));     // large for base64 media
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

/* Health check */
app.get("/", (req, res) => res.json({ status: "ok", service: "Chatterly WhatsApp API" }));

/* Routes */
app.use("/users",      usersRouter);
app.use("/admins",     adminsAuthRouter);
app.use("/instance",   instanceRoutes);
app.use("/dashboard",  adminDashRouter);
app.use("/payments",   paymentsRouter);
app.use("/superadmin", superadminRouter);

/* Global error handler */
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, async () => {
    console.log(`Chatterly API listening on port ${PORT}`);

    // Mark any stale 'ready' DB rows as 'disconnected' — clients aren't running yet
    try {
        await db.query("UPDATE instances SET status='disconnected' WHERE status='ready' AND deleted_at IS NULL");
        console.log("Reset stale 'ready' instances to 'disconnected'");
    } catch (err) {
        console.error("Startup reset error:", err.message);
    }

    // Restore saved WhatsApp sessions from disk so users stay logged in across restarts
    try {
        await restoreActiveSessions();
    } catch (err) {
        console.error("Session restore error:", err.message);
    }
});
