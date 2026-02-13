const { Client } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const db = require("../db");
const crypto = require("crypto");

let instances = {};

async function getAdminFromToken(token) {
  if (!token) return null;

  const [rows] = await db.query(
    `SELECT * FROM admins WHERE token = ?`,
    [token]
  );

  if (!rows.length) return null;

  return rows[0];
}
exports.createInstance = async (req, res) => {
  try {
    const { instance_name, token } = req.body;

    const admin = await getAdminFromToken(token);
    if (!admin) return res.status(401).json({ error: "Invalid token" });

    const instanceToken = crypto.randomBytes(12).toString("hex");

    const [result] = await db.query(
      `INSERT INTO instances (admin_id, name, token, status) 
       VALUES (?, ?, ?, 'pending')`,
      [admin.id, instance_name, instanceToken]
    );

    return res.status(201).json({
      success: true,
      message: `Instance '${instance_name}' registered.`,
      instance: {
        id: result.insertId,
        name: instance_name,
        token: instanceToken,
        status: "pending",
      },
    });
  } catch (error) {
    console.error("Create Instance Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

exports.listInstances = async (req, res) => {
  try {
    const { token } = req.body;
    console.log(token);

    const admin = await getAdminFromToken(token);
    if (!admin) return res.status(401).json({ error: "Invalid token" });

    const [rows] = await db.query(
      `SELECT id, name, token, status ,uuid
       FROM instances 
       WHERE admin_id = ? AND deleted_at IS NULL 
       ORDER BY id DESC`,
      [admin.id]
    );

    return res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("Error in listInstances:", err);
    return res.status(500).json({ error: "Database Error" });
  }
};
exports.getInstanceDetails = async (req, res) => {
  try {
    const { token } = req.body;
    const instanceId = req.params.uuid;
    const admin = await getAdminFromToken(token);
    if (!admin) return res.status(401).json({ error: "Invalid token" });
    const [rows] = await db.query(
      `SELECT id, name, token, status ,uuid
       FROM instances 
       WHERE admin_id = ? AND uuid = ? AND deleted_at IS NULL`,
      [admin.id, instanceId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Instance not found" });
    }

    return res.json({
      success: true,
      instance: rows[0],
    });
  } catch (err) {
    console.error("Error in getInstanceDetails:", err);
    return res.status(500).json({ error: "Database Error" });
  }
};

exports.startInstance = async (req, res) => {
  try {
    const { instance_name, token } = req.body;

    const admin = await getAdminFromToken(token);
    if (!admin) return res.status(401).json({ error: "Invalid token" });

    const [rows] = await db.query(
      `SELECT * FROM instances 
       WHERE name = ? AND admin_id = ? AND deleted_at IS NULL`,
      [instance_name, admin.id]
    );

    if (!rows.length)
      return res.status(404).json({ error: "Instance not found" });

    const dbInstance = rows[0];

    if (dbInstance.status === "ready") {
      return res.status(400).json({ message: "Already connected." });
    }

    const id = instance_name;

    const client = new Client({
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    instances[id] = { client, qr: null, ready: false, webhookUrl: null };

    client.on("qr", async (qr) => {
      instances[id].qr = qr;

      await db.query(
        `UPDATE instances 
         SET qr_code = ?, status = 'pending' 
         WHERE name = ? AND admin_id = ?`,
        [qr, instance_name, admin.id]
      );
    });

    client.on("ready", async () => {
      instances[id].ready = true;

      await db.query(
        `UPDATE instances 
         SET status = 'ready', last_seen = NOW(), qr_code = NULL 
         WHERE name = ? AND admin_id = ?`,
        [instance_name, admin.id]
      );
    });

    client.on("disconnected", async () => {
      delete instances[id];

      await db.query(
        `UPDATE instances 
         SET status = 'disconnected', last_seen = NOW() 
         WHERE name = ? AND admin_id = ?`,
        [instance_name, admin.id]
      );
    });

    client.initialize();

    res.json({
      success: true,
      message: "Instance started successfully.",
    });
  } catch (error) {
    console.error("Start Instance Error:", error);
    res.status(500).json({ error: error.message });
  }
};

exports.getQr = async (req, res) => {
  const { token } = req.body;
  const id = req.params.id;

  const admin = await getAdminFromToken(token);
  if (!admin) return res.status(401).json({ error: "Invalid token" });

  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  if (!instance.qr)
    return res.status(400).json({ error: "QR not generated yet" });

  const qrImage = await qrcode.toDataURL(instance.qr);
  res.json({ qr: qrImage });
};


exports.getStatus = async (req, res) => {
  const { token } = req.body;
  const id = req.params.id;

  const admin = await getAdminFromToken(token);
  if (!admin) return res.status(401).json({ error: "Invalid token" });

  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });

  res.json({
    id,
    ready: instance.ready,
    hasQr: !!instance.qr,
    webhookUrl: instance.webhookUrl || null,
  });
};

exports.sendMessage = async (req, res) => {
  const { token, number, message } = req.body;
  const id = req.params.id;

  const admin = await getAdminFromToken(token);
  if (!admin) return res.status(401).json({ error: "Invalid token" });

  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  if (!instance.ready)
    return res.status(400).json({ error: "Instance not ready" });

  try {
    const chatId = number.includes("@c.us") ? number : `${number}@c.us`;
    await instance.client.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteInstance = async (req, res) => {
  const { token } = req.body;
  const id = req.params.id;

  const admin = await getAdminFromToken(token);
  if (!admin) return res.status(401).json({ error: "Invalid token" });

  const instance = instances[id];

  if (instance) {
    await instance.client.destroy();
    delete instances[id];
  }

  await db.query(
    `UPDATE instances 
     SET deleted_at = NOW(), status = 'disconnected' 
     WHERE name = ? AND admin_id = ?`,
    [id, admin.id]
  );

  res.json({ success: true });
};

exports.logoutInstance = async (req, res) => {
  const { token } = req.body;
  const id = req.params.id;

  const admin = await getAdminFromToken(token);
  if (!admin) return res.status(401).json({ error: "Invalid token" });

  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });

  try {
    await instance.client.logout();
    await instance.client.destroy();
    delete instances[id];

    await db.query(
      `UPDATE instances 
       SET status = 'disconnected', last_seen = NOW() 
       WHERE name = ? AND admin_id = ?`,
      [id, admin.id]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Logout failed" });
  }
};
exports.setWebhook = async (req, res) => {
  const { token, webhookUrl } = req.body;
  const id = req.params.id;

  const admin = await getAdminFromToken(token);
  if (!admin) return res.status(401).json({ error: "Invalid token" });

  const instance = instances[id];
  if (!instance) return res.status(404).json({ error: "Instance not found" });

  instance.webhookUrl = webhookUrl || null;

  res.json({
    success: true,
    webhookUrl: instance.webhookUrl,
  });
};
exports.getQrPng = async (req, res) => {
  const id = req.params.id;
  const instance = instances[id];

  if (!instance)
    return res.status(404).json({ error: "Instance not found" });

  if (!instance.qr)
    return res.status(400).json({ error: "QR not generated yet" });

  try {
    const qrBuffer = await qrcode.toBuffer(instance.qr, { type: "png" });

    res.setHeader("Content-Type", "image/png");
    res.send(qrBuffer);
  } catch (err) {
    res.status(500).json({ error: "Failed to generate QR code" });
  }
};
exports.connectInstance = async (req, res, instance_name) => {
  try {
    const { token } = req.body;
    // const instance_name = req.params.name;

    const admin = await getAdminFromToken(token);
    if (!admin) return res.status(401).json({ error: "Invalid token" });

    const [rows] = await db.query(
      `SELECT * FROM instances 
       WHERE name = ? AND admin_id = ? AND deleted_at IS NULL`,
      [instance_name, admin.id]
    );

    if (!rows.length)
      return res.status(404).json({ error: "Instance not found" });

    const dbInstance = rows[0];
    if (dbInstance.status === "ready") {
      return res.status(400).json({ error: "Already connected" });
    }

    if (instances[instance_name]) {
      return res.status(400).json({ error: "Instance already initializing" });
    }

    const client = new Client({
      puppeteer: {
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      },
    });

    instances[instance_name] = {
      client,
      ready: false,
    };

    client.on("qr", async (qr) => {
      try {
        const qrBuffer = await qrcode.toBuffer(qr, { type: "png" });

        await db.query(
          `UPDATE instances 
           SET status = 'pending', qr_code = ? 
           WHERE name = ? AND admin_id = ?`,
          [qr, instance_name, admin.id]
        );

        res.setHeader("Content-Type", "image/png");
        return res.send(qrBuffer);
      } catch (err) {
        return res.status(500).json({ error: "QR generation failed" });
      }
    });

    client.on("ready", async () => {
      instances[instance_name].ready = true;

      await db.query(
        `UPDATE instances 
         SET status = 'ready', qr_code = NULL, last_seen = NOW()
         WHERE name = ? AND admin_id = ?`,
        [instance_name, admin.id]
      );
    });

    client.on("disconnected", async () => {
      delete instances[instance_name];

      await db.query(
        `UPDATE instances 
         SET status = 'pending', last_seen = NOW()
         WHERE name = ? AND admin_id = ?`,
        [instance_name, admin.id]
      );
    });

    client.initialize();

  } catch (error) {
    console.error("Connect Instance Error:", error);
    res.status(500).json({ error: error.message });
  }
};

