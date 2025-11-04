const { Client } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const db = require('../db');
const crypto = require('crypto');
const { log } = require("console");
let instances = {};

exports.listInstances = async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const adminId = decoded.id;

    const [rows] = await db.query(
      `SELECT id, name, token, status FROM instances WHERE admin_id = ? AND deleted_at IS NULL ORDER BY id DESC`,[adminId]
    );
    return res.json({
      success: true,
      count: rows.length,
      message: rows.length ? "Instances fetched successfully" : "No instances found",
      data: rows,
    });
  } catch (err) {
    console.error("Error in listInstances:", err);
    return res.status(500).json({ error: "Database Error" });
  }
};


exports.startInstance = async (req, res) => {
  try {
    const { instance_name } = req.body;
    console.log("Starting instance:", instance_name); 
    const token = req.headers.authorization;
    console.log(token);
    if (!token) return res.status(401).json({ error: "No token provided" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const adminId = decoded.id;
    const [instancesRows] = await db.query(
      `SELECT * FROM instances WHERE name = ? AND admin_id = ? AND deleted_at IS NULL`,
      [instance_name, adminId]
    );
    if (!instancesRows.length) {
      return res.status(404).json({ error: "Instance not found" });
    }
    const dbInstance = instancesRows[0];
    if (dbInstance.status === 'ready') {
      return res.status(400).json({ message: "Instance already linked to WhatsApp." });
    }
    const id = instance_name;
    // const client = new Client({ puppeteer: { headless: true } }); 
    const client = new Client({puppeteer: {headless: true,args: ['--no-sandbox', '--disable-setuid-sandbox']}});
    instances[id] = { client, qr: null, ready: false, webhookUrl: null };
    client.on("qr", async (qr) => {
      const [instanceStatusRow] = await db.query(`SELECT status FROM instances WHERE name = ? AND admin_id = ?`, [instance_name, adminId]);
      if (instanceStatusRow[0]?.status === 'ready') {
        return;
      }
      instances[id].qr = qr;
      await db.query(`UPDATE instances SET qr_code = ?, status = 'pending' WHERE name = ? AND admin_id = ?`, [qr, instance_name, adminId]);
    });
    client.on("ready", async () => {
      instances[id].ready = true;
      await db.query(
        `UPDATE instances SET status = 'ready', last_seen = NOW(), qr_code = NULL WHERE name = ? AND admin_id = ?`,
        [instance_name, adminId]
      );
    });
    client.on("disconnected", async (reason) => {
      delete instances[id];
      await db.query(
        `UPDATE instances SET status = 'disconnected', last_seen = NOW() WHERE name = ? AND admin_id = ?`,
        [instance_name, adminId]
      );
    });
    client.initialize();
    res.status(200).json({ success: true, message: "Instance started, QR will be generated if not already linked." });
  } catch (error) {
  }
};

// exports.createInstance = async (req, res) => {
//   try {
//     const { instance_name } = req.body;
//     const token = req.headers.authorization;
//     if (!token) return res.status(401).json({ error: "No token provided" });
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     const adminId = decoded.id;
//     const instanceToken = crypto.randomBytes(12).toString("hex");
//     console.log(adminId, instance_name, instanceToken);
//     const [result] = await db.query(
//       `INSERT INTO instances(admin_id, name, token, status) VALUES (?, ?, ?, 'pending')`,
//       [adminId, instance_name, instanceToken]
//     );
//     return res.status(201).json({
//       success: true,
//       message: `Instance '${instance_name}' registered. QR not generated yet.`,
//       instance: {
//         id: result.insertId,
//         name: instance_name,
//         token: instanceToken,
//         status: "pending",
//       },
//     });
//   } catch (error) {
//   }
// };
exports.createInstance = async (req, res) => {
  try {
    const { instance_name } = req.body;
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "No token provided" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const adminId = decoded.id;
    const instanceToken = crypto.randomBytes(12).toString("hex");
    console.log(adminId, instance_name, instanceToken);
    const [result] = await db.query(
      `INSERT INTO instances (admin_id, name, token, status) VALUES (?, ?, ?, 'pending')`,
      [adminId, instance_name, instanceToken]
    );
    return res.status(201).json({
      success: true,
      message: `Instance '${instance_name}' registered. QR not generated yet.`,
      instance: {
        id: result.insertId,
        name: instance_name,
        token: instanceToken,
        status: "pending",
      },
    });
  } catch (error) {
    console.error("Create Instance Error:", error);
    return res.status(500).json({
      error: error.message,
      sqlMessage: error.sqlMessage || null,
      code: error.code || null,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined // Show stack only in dev
    });
  }
};


exports.setWebhook = (req, res) => {
  const id = req.params.id;
  const { webhookUrl } = req.body;
  console.log(`Setting webhook for instance ${id} to ${webhookUrl}`);
  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  instance.webhookUrl = webhookUrl || null;
  res.json({
    success: true,
    message: webhookUrl
      ? `Webhook set for instance ${id}`
      : `Webhook removed for instance ${id}`,
    webhookUrl: instance.webhookUrl,
  });
};

exports.getQr = async (req, res) => {
  const id = req.params.id;
  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  if (!instance.qr)
    return res.status(400).json({
      error: "QR not generated yet or already scanned",
    });
  const qrImage = await qrcode.toDataURL(instance.qr);
  res.json({ qr: qrImage });
};

exports.getQrPng = async (req, res) => {
  const id = req.params.id;
  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  if (!instance.qr)
    return res.status(400).json({ error: "QR not generated yet or already scanned" });

  try {
    const qrBuffer = await qrcode.toBuffer(instance.qr, { type: "png" });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${id}-qr.png"`);
    res.send(qrBuffer);
  } catch (err) {
    console.error("QR generation failed:", err);
    res.status(500).json({ error: "Failed to generate QR code" });
  }
};

exports.sendMessage = async (req, res) => {
  const id = req.params.id;
  const { number, message } = req.body;
  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  if (!instance.ready) return res.status(400).json({ error: "Instance not ready" });

  try {
    const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
    await instance.client.sendMessage(chatId, message);
    res.json({ success: true, message: "Message sent successfully" });
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.getStatus = (req, res) => {
  const id = req.params.id;
  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  res.json({
    id,
    ready: instance.ready,
    hasQr: !!instance.qr,
    webhookUrl: instance.webhookUrl || null,
  });
};

exports.deleteInstance = async (req, res) => {
  const id = req.params.id;
  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });

  await instance.client.destroy();
  delete instances[id];

  await db.query(`UPDATE instances SET deleted_at = NOW(), status = 'disconnected' WHERE name = ?`, [id]);

  res.json({ success: true, message: `Instance ${id} deleted successfully` });
};

exports.logoutInstance = async (req, res) => {
  const id = req.params.id;
  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });

  try {
    await instance.client.logout();
    await instance.client.destroy();
    delete instances[id];
    await db.query(`UPDATE instances SET status = 'disconnected', last_seen = NOW() WHERE name = ?`, [id]);

    return res.json({
      success: true,
      message: `Instance ${id} logged out and removed.`,
    });
  } catch (error) {
    console.error("Logout error:", error);
    return res.status(500).json({ error: "Failed to logout and remove instance." });
  }
};
