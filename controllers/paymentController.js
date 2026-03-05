const db = require("../db");

/* ------------------------------------------------------------------ */
/*  Admin: create a payment request for an instance                     */
/* ------------------------------------------------------------------ */
exports.requestPayment = async (req, res) => {
    try {
        const adminId = req.user.id;
        const { instanceId, amount = 9.99, currency = "USD", durationDays = 30,
                paymentMethod = "manual", transactionId, notes } = req.body;

        // Verify the instance belongs to this admin
        const [inst] = await db.query(
            "SELECT id, name FROM instances WHERE id=? AND admin_id=? AND deleted_at IS NULL",
            [instanceId, adminId]
        );
        if (!inst.length) return res.status(404).json({ error: "Instance not found" });

        const [result] = await db.query(
            `INSERT INTO payments (instance_id, admin_id, amount, currency, duration_days,
                                   payment_method, transaction_id, notes, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
            [instanceId, adminId, amount, currency, durationDays,
             paymentMethod, transactionId || null, notes || null]
        );

        return res.status(201).json({
            success: true,
            message: "Payment request submitted. Super admin will approve shortly.",
            paymentId: result.insertId,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  Admin: list own payment requests                                    */
/* ------------------------------------------------------------------ */
exports.myPayments = async (req, res) => {
    try {
        const adminId = req.user.id;
        const [rows] = await db.query(
            `SELECT p.*, i.name AS instance_name
             FROM payments p
             JOIN instances i ON i.id = p.instance_id
             WHERE p.admin_id = ?
             ORDER BY p.created_at DESC`,
            [adminId]
        );
        return res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  Admin: get payment status for a specific instance                   */
/* ------------------------------------------------------------------ */
exports.instancePayments = async (req, res) => {
    try {
        const adminId = req.user.id;
        const { instanceId } = req.params;

        const [rows] = await db.query(
            `SELECT * FROM payments WHERE instance_id=? AND admin_id=? ORDER BY created_at DESC`,
            [instanceId, adminId]
        );
        return res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
