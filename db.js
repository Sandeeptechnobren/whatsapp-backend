const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'app_user',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'chatterly',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Keep connections alive so MySQL doesn't drop idle ones (fixes ECONNRESET)
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 30000,
});

// Retry wrapper — on ECONNRESET the pool auto-gets a fresh connection on retry
const originalQuery = pool.query.bind(pool);
pool.query = async function (...args) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await originalQuery(...args);
    } catch (err) {
      if ((err.code === 'ECONNRESET' || err.code === 'PROTOCOL_CONNECTION_LOST') && attempt < 3) {
        console.warn(`[DB] ${err.code} — retrying query (attempt ${attempt}/3)`);
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      throw err;
    }
  }
};

module.exports = pool;
