const db   = require("../db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

/* ------------------------------------------------------------------ */
/*  System overview stats                                               */
/* ------------------------------------------------------------------ */
exports.getStats = async (req, res) => {
    try {
        const [[totalAdmins]]    = await db.query("SELECT COUNT(*) AS c FROM admins WHERE role='admin'");
        const [[totalInstances]] = await db.query("SELECT COUNT(*) AS c FROM instances WHERE deleted_at IS NULL");
        const [[activeInstances]]= await db.query("SELECT COUNT(*) AS c FROM instances WHERE status='ready' AND deleted_at IS NULL");
        const [[pendingPayments]]= await db.query("SELECT COUNT(*) AS c FROM payments WHERE status='pending'");
        const [[revenueResult]]  = await db.query("SELECT SUM(amount) AS total FROM payments WHERE status='approved'");

        const [statusBreakdown] = await db.query(
            "SELECT status, COUNT(*) AS count FROM instances WHERE deleted_at IS NULL GROUP BY status"
        );

        const statusMap = { pending: 0, ready: 0, disconnected: 0, error: 0 };
        statusBreakdown.forEach(r => { statusMap[r.status] = r.count; });

        return res.json({
            success: true,
            data: {
                totalAdmins: totalAdmins.c,
                totalInstances: totalInstances.c,
                activeInstances: activeInstances.c,
                pendingPayments: pendingPayments.c,
                totalRevenue: parseFloat(revenueResult.total || 0).toFixed(2),
                instanceStatusBreakdown: statusMap,
            },
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  All admins                                                          */
/* ------------------------------------------------------------------ */
exports.getAllAdmins = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, username, name, email, phone, role, token,
                    created_at, updated_at,
                    (SELECT COUNT(*) FROM instances WHERE admin_id=admins.id AND deleted_at IS NULL) AS instance_count
             FROM admins
             WHERE role != 'superadmin'
             ORDER BY id DESC`
        );
        return res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  All instances (across all admins)                                   */
/* ------------------------------------------------------------------ */
exports.getAllInstances = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT i.id, i.name, i.token, i.status, i.uuid,
                    i.trial_ends_at, i.plan, i.plan_expires_at, i.webhook_url,
                    i.last_seen, i.created_at,
                    a.username AS admin_username, a.email AS admin_email, a.id AS admin_id
             FROM instances i
             JOIN admins a ON a.id = i.admin_id
             WHERE i.deleted_at IS NULL
             ORDER BY i.id DESC`
        );
        return res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  All payments (with instance + admin info)                           */
/* ------------------------------------------------------------------ */
exports.getAllPayments = async (req, res) => {
    try {
        const { status } = req.query; // optional filter: pending|approved|rejected
        const conditions = status ? "WHERE p.status = ?" : "";
        const params     = status ? [status] : [];

        const [rows] = await db.query(
            `SELECT p.*,
                    i.name AS instance_name,
                    a.username AS admin_username, a.email AS admin_email
             FROM payments p
             JOIN instances i ON i.id = p.instance_id
             JOIN admins a    ON a.id = p.admin_id
             ${conditions}
             ORDER BY p.created_at DESC`,
            params
        );
        return res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  Approve a payment → unlock the instance for duration_days          */
/* ------------------------------------------------------------------ */
exports.approvePayment = async (req, res) => {
    try {
        const { id } = req.params;
        const superAdminId = req.user.id;

        const [rows] = await db.query(
            "SELECT * FROM payments WHERE id=? AND status='pending'",
            [id]
        );
        if (!rows.length) return res.status(404).json({ error: "Pending payment not found" });

        const payment = rows[0];

        // Approve payment
        await db.query(
            "UPDATE payments SET status='approved', approved_by=?, approved_at=NOW() WHERE id=?",
            [superAdminId, id]
        );

        // Extend / activate the instance plan
        await db.query(
            `UPDATE instances
             SET plan='active',
                 plan_expires_at = DATE_ADD(GREATEST(COALESCE(plan_expires_at, NOW()), NOW()), INTERVAL ? DAY)
             WHERE id=?`,
            [payment.duration_days, payment.instance_id]
        );

        return res.json({ success: true, message: `Instance unlocked for ${payment.duration_days} days.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  Reject a payment                                                    */
/* ------------------------------------------------------------------ */
exports.rejectPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body;

        const [rows] = await db.query("SELECT * FROM payments WHERE id=?", [id]);
        if (!rows.length) return res.status(404).json({ error: "Payment not found" });

        await db.query(
            "UPDATE payments SET status='rejected', notes=CONCAT(COALESCE(notes,''), ' | Rejected: ', ?) WHERE id=?",
            [reason || "No reason provided", id]
        );

        return res.json({ success: true, message: "Payment rejected." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  Manually lock / unlock an instance                                  */
/* ------------------------------------------------------------------ */
exports.lockInstance = async (req, res) => {
    try {
        const { id } = req.params;
        await db.query("UPDATE instances SET plan='expired', plan_expires_at=NULL WHERE id=?", [id]);
        return res.json({ success: true, message: "Instance locked." });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.unlockInstance = async (req, res) => {
    try {
        const { id } = req.params;
        const { days = 30 } = req.body;
        await db.query(
            `UPDATE instances SET plan='active',
             plan_expires_at=DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id=?`,
            [days, id]
        );
        return res.json({ success: true, message: `Instance unlocked for ${days} days.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  Delete an admin account                                             */
/* ------------------------------------------------------------------ */
exports.deleteAdmin = async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting another superadmin
        const [rows] = await db.query("SELECT role FROM admins WHERE id=?", [id]);
        if (!rows.length) return res.status(404).json({ error: "Admin not found" });
        if (rows[0].role === "superadmin") return res.status(403).json({ error: "Cannot delete superadmin" });

        await db.query("DELETE FROM admins WHERE id=?", [id]);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ------------------------------------------------------------------ */
/*  Create a super admin account (seeding)                              */
/* ------------------------------------------------------------------ */
exports.createSuperAdmin = async (req, res) => {
    try {
        const { username, password, name, email } = req.body;
        if (!username || !password || !name) return res.status(400).json({ error: "username, password, name required" });

        // Prevent creating a second superadmin via this public endpoint
        const [[existing]] = await db.query("SELECT COUNT(*) AS c FROM admins WHERE role='superadmin'");
        if (existing.c > 0) return res.status(403).json({ error: "A super admin already exists. Use the Super Admin panel to manage accounts." });

        const hash  = await bcrypt.hash(password, 10);
        const token = crypto.randomBytes(30).toString("hex");

        const [result] = await db.query(
            "INSERT INTO admins (username,password,name,email,role,token) VALUES (?,?,?,?,'superadmin',?)",
            [username, hash, name, email || null, token]
        );

        return res.status(201).json({ success: true, superAdminId: result.insertId });
    } catch (err) {
        if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Username already exists" });
        return res.status(500).json({ error: err.message });
    }
};
