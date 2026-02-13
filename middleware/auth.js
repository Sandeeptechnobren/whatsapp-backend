const jwt = require("jsonwebtoken");

// function auth(req, res, next) {
    
//     const authHeader = req.headers["authorization"];
//     const token = authHeader && authHeader.split(" ")[1];// const token = req.headers["authorization"];
//     if (!token) {
//         return res.status(401).json({ error: "No token provided" });
//     }
//     try {
//         const decoded = jwt.verify(token, process.env.JWT_SECRET);
//         req.user = decoded; // attach decoded user info to request
//         console.log("Auth middleware - token verified:", req.user);
//         next();
//     } catch (err) {
//         console.log(err);
//         return res.status(401).json({ error: "Invalid token" });
//     }
// }

// // Only allow admins
// function verifyAdmin(req, res, next) {
//     auth(req, res, () => {
//         if (req.user && req.user.role === "admin") {
//             next();
//         } else {
//             return res.status(403).json({ error: "Access denied: Admins only" });
//         }
//     });
// }

// module.exports = { auth, verifyAdmin };
function auth(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];

    if (!token) {
        return res.status(401).json({ error: "No token provided" });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        console.log("JWT ERROR:", err.message);
        return res.status(401).json({ error: "Invalid token" });
    }
}

function verifyAdmin(req, res, next) {
    auth(req, res, () => {
        if (req.user) {
            next();
        } else {
            return res.status(403).json({ error: "Access denied" });
        }
    });
}

module.exports = { auth, verifyAdmin };