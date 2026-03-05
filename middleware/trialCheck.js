const db = require("../db");

/**
 * Middleware: checks if the instance (by name, from req.params.id) is
 * within its trial period OR has an active paid plan.
 * If locked, returns HTTP 402 with code SUBSCRIPTION_REQUIRED.
 *
 * Token is read from req.body.token (admin API token, not JWT).
 */
async function trialCheck(req, res, next) {
    const instanceId = req.params.id;
    if (!instanceId) return next();

    try {
        const [rows] = await db.query(
            `SELECT trial_ends_at, plan, plan_expires_at, deleted_at
             FROM instances WHERE name = ? AND deleted_at IS NULL`,
            [instanceId]
        );

        if (!rows.length) return next(); // instance not found, let controller handle

        const { trial_ends_at, plan, plan_expires_at } = rows[0];
        const now = new Date();

        // Active paid plan
        if (plan === "active" && plan_expires_at && new Date(plan_expires_at) > now) {
            return next();
        }

        // Still within trial
        if (trial_ends_at && new Date(trial_ends_at) > now) {
            return next();
        }

        // Expired
        return res.status(402).json({
            error: "Trial expired or subscription required",
            code: "SUBSCRIPTION_REQUIRED",
            trialEndsAt: trial_ends_at,
            plan,
        });
    } catch (err) {
        console.error("trialCheck error:", err);
        next(); // don't block on middleware error
    }
}

module.exports = { trialCheck };
