const db = require('../db');
const bcrypt = require('bcrypt');
const jwt = require("jsonwebtoken");
exports.listAdmins = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, name, address, email, phone, role, token, created_at, updated_at FROM admins ORDER BY id DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};

exports.getAdmin = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, name, address, email, phone, role, token, created_at, updated_at FROM admins WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Admin not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};

exports.createAdmin = async (req, res) => {
  try {
    const { username, password, name, address, email, phone, role } = req.body;

    if (!username || !password || !name) {
      return res.status(400).json({ error: 'username, password, and name are required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `INSERT INTO admins (username, password, name, address, email, phone, role)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [username, hashedPassword, name, address || null, email || null, phone || null, role || 'admin']
    );

    const [rows] = await db.query(
      'SELECT id, username, name, address, email, phone, role, token, created_at, updated_at FROM admins WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Duplicate entry: username/email already exists' });
    res.status(500).json({ error: 'Database error' });
  }
};

exports.updateAdmin = async (req, res) => {
  try {
    const { username, password, name, address, email, phone, role } = req.body;
    const id = req.params.id;

    let hashedPassword = null;
    if (password) hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      `UPDATE admins 
       SET username = COALESCE(?, username),
           password = COALESCE(?, password),
           name = COALESCE(?, name),
           address = COALESCE(?, address),
           email = COALESCE(?, email),
           phone = COALESCE(?, phone),
           role = COALESCE(?, role)
       WHERE id = ?`,
      [username, hashedPassword, name, address, email, phone, role, id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Admin not found' });
    const [rows] = await db.query(
      'SELECT id, username, name, address, email, phone, role, token, created_at, updated_at FROM admins WHERE id = ?',
      [id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Duplicate entry: username/email already exists' });
    res.status(500).json({ error: 'Database error' });
  }
};

exports.deleteAdmin = async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM admins WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Admin not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};
exports.loginAdmin = async (req, res) => {
  const debugLogs = [];

  try {
    const { username, password } = req.body;

    debugLogs.push("Step 1: Received login request");
    debugLogs.push(`Username: ${username}`);
    debugLogs.push(`Password provided: ${password ? "Yes" : "No"}`);

    if (!username || !password) {
      debugLogs.push("Step 2: Missing username or password");
      return res.status(400).json({ error: "Username and password are required", debugLogs });
    }
    const [rows] = await db.query("SELECT * FROM admins WHERE username = ?", [username]);
    debugLogs.push(`Step 3: DB query result: ${rows.length} record(s) found`);

    if (!rows.length) {
      debugLogs.push("Step 3: No admin found with this username");
      return res.status(401).json({ error: "Invalid username or password", debugLogs });
    }

    const admin = rows[0];
    const isMatch = await bcrypt.compare(password, admin.password);
    debugLogs.push(`Step 4: Password match: ${isMatch}`);

    if (!isMatch) {
      debugLogs.push("Step 4: Password incorrect");
      return res.status(401).json({ error: "Invalid username or password", debugLogs });
    }
    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    debugLogs.push(`Step 5: JWT token generated`);
    await db.query("UPDATE admins SET token = ? WHERE id = ?", [token, admin.id]);
    debugLogs.push("Step 6: Token saved to database");
    debugLogs.push("Step 7: Returning response to client");
    return res.json({
      success: true,
      admin: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role,
        token,
      },
      debugLogs
    });
  } catch (err) {
    debugLogs.push(`Step 8: Error occurred: ${err.message}`);
    return res.status(500).json({ error: "Database error", debugLogs });
  }
};
// exports.loginAdmin = async (req, res) => {
//   try {
//     let { username, password } = req.body;
//     username = username?.trim();
//     console.log("Login attempt:", username);

//     if (!username || !password) {
//       return res.status(400).json({ error: "Username and password are required" });
//     }

//     const [rows] = await db.query("SELECT * FROM admins WHERE username = ?", [username]);
//     console.log("Query result:", rows);

//     if (!rows || rows.length === 0) {
//       return res.status(401).json({ error: "Admin not found" });
//     }

//     const admin = rows[0];
//     const isMatch = await bcrypt.compare(password, admin.password);

//     if (!isMatch) {
//       return res.status(401).json({ error: "Invalid username or password" });
//     }

//     const token = jwt.sign(
//       { id: admin.id, username: admin.username, role: admin.role },
//       process.env.JWT_SECRET,
//       { expiresIn: "1h" }
//     );

//     // Optional: Save token in DB
//     await db.query("UPDATE admins SET token = ? WHERE id = ?", [token, admin.id]);

//     res.json({
//       id: admin.id,
//       username: admin.username,
//       name: admin.name,
//       role: admin.role,
//       token,
//     });
//   } catch (err) {
//     console.error("Login error:", err);
//     res.status(500).json({ error: "Database error" });
//   }
// };
