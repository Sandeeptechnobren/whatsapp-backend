require("dotenv").config();
const express   = require("express");
const cors      = require("cors");

const usersRouter        = require("./routes/users");
const adminsAuthRouter   = require("./routes/admins");
const instanceRoutes     = require("./routes/instance");
const adminDashRouter    = require("./routes/adminDashboard");
const paymentsRouter     = require("./routes/payments");
const superadminRouter   = require("./routes/superadmin");

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

app.listen(PORT, () => console.log(`Chatterly API listening on port ${PORT}`));
