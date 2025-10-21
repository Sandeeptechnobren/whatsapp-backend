const jwt = require("jsonwebtoken");

// General authentication middleware
function auth(req, res, next) {
    const token = req.headers["authorization"];

    if (!token) {
        return res.status(401).json({ error: "No token provided" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // attach decoded user info to request
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
}

// Only allow admins
function verifyAdmin(req, res, next) {
    auth(req, res, () => {
        if (req.user && req.user.role === "admin") {
            next();
        } else {
            return res.status(403).json({ error: "Access denied: Admins only" });
        }
    });
}

module.exports = { auth, verifyAdmin };
