const db = require('../db');
const bcrypt = require('bcrypt');
const jwt = require("jsonwebtoken");

exports.listInstances = async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const [adminResult] = await db.query(
      'SELECT id FROM admins WHERE token = ? AND deleted_at IS NULL',
      [token]
    );
    if (adminResult.length === 0) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    const adminId = adminResult[0].id;
    const [instances] = await db.query(
      `SELECT id, name, token, status, created_at, updated_at 
       FROM instances 
       WHERE admin_id = ? AND deleted_at IS NULL 
       ORDER BY id DESC`,
      [adminId]
    );
    res.status(200).json({
      success: true,
      message: instances.length > 0 
        ? 'Instances fetched successfully'
        : 'No instances found for this admin',
      count: instances.length,
      data: instances,
    });
  } catch (err) {
    console.error('Error fetching instances:', err);
    res.status(500).json({ error: 'Database error' });
  }
};
exports.instanceStatistics = async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Step 1: Validate admin
    const [adminResult] = await db.query(
      'SELECT id FROM admins WHERE token = ? AND deleted_at IS NULL',
      [token]
    );

    if (adminResult.length === 0) {
      return res.status(403).json({ error: 'Invalid token or admin not found' });
    }

    const adminId = adminResult[0].id;

    // Step 2: Get total instance count
    const [countResult] = await db.query(
      'SELECT COUNT(*) AS total FROM instances WHERE admin_id = ? AND deleted_at IS NULL',
      [adminId]
    );

    const totalInstances = countResult[0].total;
    const [statusResult] = await db.query(
      `SELECT status, COUNT(*) AS count
       FROM instances
       WHERE admin_id = ? AND deleted_at IS NULL
       GROUP BY status`,
      [adminId]
    );
    const statusStats = {
      pending: 0,
      ready: 0,
      disconnected: 0,
      error: 0,
    };

    statusResult.forEach(row => {
      statusStats[row.status] = row.count;
    });
    res.status(200).json({
      success: true,
      message: 'Instance statistics fetched successfully',
      data: {
        totalInstances,
        statusBreakdown: statusStats,
      },
    });

  } catch (err) {
    console.error('Error in instanceStatistics:', err);
    res.status(500).json({ error: 'Error fetching instance statistics' });
  }
};

