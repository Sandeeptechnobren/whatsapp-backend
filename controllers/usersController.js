const db = require('../db');

exports.listUsers = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, email, created_at, updated_at FROM users ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};

exports.getUser = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};

exports.createUser = async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email required' });
    const [result] = await db.query('INSERT INTO users (name, email) VALUES (?, ?)', [name, email]);
    const [rows] = await db.query('SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Database error' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { name, email } = req.body;
    const id = req.params.id;
    const [result] = await db.query('UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email) WHERE id = ?', [name, email, id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    const [rows] = await db.query('SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?', [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Database error' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const [result] = await db.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};
