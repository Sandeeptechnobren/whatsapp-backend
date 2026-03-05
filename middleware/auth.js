const jwt = require("jsonwebtoken");

function auth(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) return res.status(401).json({ error: "No token provided" });

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}

function verifyAdmin(req, res, next) {
    auth(req, res, () => {
        if (req.user) next();
        else res.status(403).json({ error: "Access denied" });
    });
}

function superAdmin(req, res, next) {
    auth(req, res, () => {
        if (req.user && req.user.role === "superadmin") next();
        else res.status(403).json({ error: "Super admin access required" });
    });
}

module.exports = { auth, verifyAdmin, superAdmin };
