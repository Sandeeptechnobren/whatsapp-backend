const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode  = require("qrcode");
const db      = require("../db");
const crypto  = require("crypto");
const axios   = require("axios");
const path    = require("path");
const fs      = require("fs").promises;

/* ============================================================
   In-memory map of running WhatsApp clients
   key = instance name, value = { client, ready, qr, webhookUrl }
   ============================================================ */
let instances = {};

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */
async function getAdminFromToken(token) {
    if (!token) return null;
    const [rows] = await db.query("SELECT * FROM admins WHERE token = ?", [token]);
    return rows.length ? rows[0] : null;
}

async function forwardToWebhook(webhookUrl, event, instanceName, data) {
    if (!webhookUrl) return;
    try {
        await axios.post(webhookUrl, { event, instance: instanceName, data }, { timeout: 5000 });
    } catch (err) {
        console.error(`[Webhook ${instanceName}] forward error:`, err.message);
    }
}

/** Safely destroy a WhatsApp client, release file locks, clean session on Windows */
async function safeDestroyClient(client, instanceName) {
    // Step 1: destroy the browser (releases file locks on Windows)
    try { await client.destroy(); } catch (e) { /* ignore */ }

    // Step 2: on Windows EBUSY, wait a moment then force-delete session dir
    await new Promise(r => setTimeout(r, 1500));

    const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
    try {
        await fs.rm(sessionDir, { recursive: true, force: true });
    } catch (_) { /* ignore if already gone */ }
}

/** Attach all standard event handlers to a WhatsApp client */
function attachClientEvents(client, instanceName, adminId) {
    client.on("ready", async () => {
        try {
            instances[instanceName].ready = true;
            await db.query(
                "UPDATE instances SET status='ready', qr_code=NULL, last_seen=NOW() WHERE name=? AND admin_id=?",
                [instanceName, adminId]
            );
            const wh = instances[instanceName]?.webhookUrl;
            if (wh) forwardToWebhook(wh, "session.connected", instanceName, { instance: instanceName });
        } catch (err) { console.error("ready event DB error:", err.message); }
    });

    client.on("disconnected", async (reason) => {
        try {
            delete instances[instanceName];
            await db.query(
                "UPDATE instances SET status='pending', last_seen=NOW() WHERE name=? AND admin_id=?",
                [instanceName, adminId]
            );
        } catch (err) { console.error("disconnected event DB error:", err.message); }
    });

    client.on("message", async (msg) => {
        try {
            const wh = instances[instanceName]?.webhookUrl;
            if (wh) {
                await forwardToWebhook(wh, "message", instanceName, {
                    from: msg.from,
                    to: msg.to,
                    body: msg.body,
                    type: msg.type,
                    timestamp: msg.timestamp,
                    isGroup: msg.from.endsWith("@g.us"),
                    author: msg.author || null,
                    hasMedia: msg.hasMedia,
                });
            }
        } catch (err) { console.error("message event error:", err.message); }
    });

    client.on("message_ack", async (msg, ack) => {
        const wh = instances[instanceName]?.webhookUrl;
        if (wh) forwardToWebhook(wh, "message.ack", instanceName, { id: msg.id, ack });
    });

    client.on("auth_failure", (msg) => console.error(`[${instanceName}] Auth failure:`, msg));
    client.on("error", (err) => console.error(`[${instanceName}] Client error:`, err.message));
}

/* ============================================================
   INSTANCE MANAGEMENT
   ============================================================ */

exports.createInstance = async (req, res) => {
    try {
        const { instance_name, token } = req.body;

        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const instanceToken = crypto.randomBytes(12).toString("hex");
        const trialEndsAt = new Date();
        trialEndsAt.setDate(trialEndsAt.getDate() + 6); // 6 days free trial

        const [result] = await db.query(
            `INSERT INTO instances (admin_id, name, token, status, trial_ends_at, plan, uuid)
             VALUES (?, ?, ?, 'pending', ?, 'trial', UUID())`,
            [admin.id, instance_name, instanceToken, trialEndsAt]
        );

        return res.status(201).json({
            success: true,
            message: `Instance '${instance_name}' created. Trial expires in 6 days.`,
            instance: {
                id: result.insertId,
                name: instance_name,
                token: instanceToken,
                status: "pending",
                trial_ends_at: trialEndsAt,
                plan: "trial",
            },
        });
    } catch (error) {
        console.error("createInstance error:", error);
        if (error.code === "ER_DUP_ENTRY")
            return res.status(400).json({ error: "Instance name already exists" });
        return res.status(500).json({ error: error.message });
    }
};

exports.listInstances = async (req, res) => {
    try {
        const { token } = req.body;
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const [rows] = await db.query(
            `SELECT id, name, token, status, uuid, trial_ends_at, plan, plan_expires_at, last_seen
             FROM instances WHERE admin_id=? AND deleted_at IS NULL ORDER BY id DESC`,
            [admin.id]
        );

        return res.json({ success: true, count: rows.length, data: rows });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.getInstanceDetails = async (req, res) => {
    try {
        const { token } = req.body;
        const instanceId = req.params.uuid;

        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const [rows] = await db.query(
            `SELECT id, name, token, status, uuid, trial_ends_at, plan, plan_expires_at, webhook_url, last_seen
             FROM instances WHERE admin_id=? AND uuid=? AND deleted_at IS NULL`,
            [admin.id, instanceId]
        );

        if (!rows.length) return res.status(404).json({ error: "Instance not found" });
        return res.json({ success: true, instance: rows[0] });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.connectInstance = async (req, res) => {
    try {
        const { token } = req.body;
        const instance_name = req.params.instance_name;

        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const [rows] = await db.query(
            "SELECT * FROM instances WHERE name=? AND admin_id=? AND deleted_at IS NULL",
            [instance_name, admin.id]
        );
        if (!rows.length) return res.status(404).json({ error: "Instance not found" });

        if (instances[instance_name])
            return res.status(400).json({ error: "Instance is already initializing or connected" });

        const client = new Client({
            authStrategy: new LocalAuth({ clientId: instance_name }),
            puppeteer: {
                headless: true,
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
            },
        });

        instances[instance_name] = { client, ready: false, qr: null, webhookUrl: null };

        // Restore saved webhook
        if (rows[0].webhook_url) instances[instance_name].webhookUrl = rows[0].webhook_url;

        /* QR or already-ready race */
        const resolveEvent = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("QR generation timed out (60s)")), 60000);

            client.on("qr", async (qr) => {
                clearTimeout(timeout);
                instances[instance_name].qr = qr;
                try {
                    const buf = await qrcode.toBuffer(qr, { type: "png" });
                    await db.query(
                        "UPDATE instances SET status='pending', qr_code=? WHERE name=? AND admin_id=?",
                        [qr.toString(), instance_name, admin.id]
                    );
                    resolve({ type: "qr", buf });
                } catch (e) { reject(e); }
            });

            client.on("ready", () => {
                clearTimeout(timeout);
                resolve({ type: "ready" });
            });
        });

        attachClientEvents(client, instance_name, admin.id);
        client.initialize().catch(err => console.error(`[${instance_name}] init error:`, err.message));

        const result = await resolveEvent;

        if (result.type === "ready") {
            return res.json({ success: true, status: "ready", message: "Already authenticated" });
        }

        res.setHeader("Content-Type", "image/png");
        return res.send(result.buf);

    } catch (error) {
        console.error("connectInstance error:", error);
        return res.status(500).json({ error: error.message });
    }
};

exports.startInstance = async (req, res) => {
    try {
        const { instance_name, token } = req.body;

        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const [rows] = await db.query(
            "SELECT * FROM instances WHERE name=? AND admin_id=? AND deleted_at IS NULL",
            [instance_name, admin.id]
        );
        if (!rows.length) return res.status(404).json({ error: "Instance not found" });
        if (instances[instance_name]) return res.status(400).json({ message: "Already running" });

        const client = new Client({
            puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
        });

        instances[instance_name] = { client, ready: false, qr: null, webhookUrl: rows[0].webhook_url || null };

        client.on("qr", async (qr) => {
            instances[instance_name].qr = qr;
            await db.query(
                "UPDATE instances SET qr_code=?, status='pending' WHERE name=? AND admin_id=?",
                [qr, instance_name, admin.id]
            ).catch(() => {});
        });

        attachClientEvents(client, instance_name, admin.id);
        client.initialize().catch(() => {});

        res.json({ success: true, message: "Instance started" });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

exports.deleteInstance = async (req, res) => {
    const { token } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const instance = instances[id];
        if (instance) {
            await safeDestroyClient(instance.client, id);
            delete instances[id];
        }

        await db.query(
            "UPDATE instances SET deleted_at=NOW(), status='disconnected' WHERE name=? AND admin_id=?",
            [id, admin.id]
        );

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.logoutInstance = async (req, res) => {
    const { token } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const instance = instances[id];
        if (!instance) return res.status(404).json({ error: "Instance not in memory (may be offline)" });

        // Step 1: try graceful logout (sends signal to WhatsApp servers)
        try {
            await Promise.race([
                instance.client.logout(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("logout timeout")), 8000)),
            ]);
        } catch (e) {
            console.warn(`[${id}] logout signal failed:`, e.message);
            // Step 2: force destroy to release file locks (EBUSY fix)
            await safeDestroyClient(instance.client, id);
        }

        delete instances[id];

        await db.query(
            "UPDATE instances SET status='pending', last_seen=NOW() WHERE name=? AND admin_id=?",
            [id, admin.id]
        );

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.setWebhook = async (req, res) => {
    const { token, webhookUrl } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        if (instances[id]) instances[id].webhookUrl = webhookUrl || null;

        await db.query(
            "UPDATE instances SET webhook_url=? WHERE name=? AND admin_id=?",
            [webhookUrl || null, id, admin.id]
        );

        return res.json({ success: true, webhookUrl: webhookUrl || null });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.getQr = async (req, res) => {
    const token = req.query.token || req.body?.token;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const instance = instances[id];
        if (!instance) return res.status(404).json({ error: "Instance not running" });
        if (!instance.qr) return res.status(400).json({ error: "QR not generated yet" });

        const qrImage = await qrcode.toDataURL(instance.qr);
        return res.json({ qr: qrImage });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.getQrPng = async (req, res) => {
    const id = req.params.id;
    const instance = instances[id];

    if (!instance) return res.status(404).json({ error: "Instance not running" });
    if (!instance.qr) return res.status(400).json({ error: "QR not generated yet" });

    try {
        const buf = await qrcode.toBuffer(instance.qr, { type: "png" });
        res.setHeader("Content-Type", "image/png");
        return res.send(buf);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.getStatus = async (req, res) => {
    const token = req.body?.token || req.query.token;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        // Check in-memory first
        const instance = instances[id];

        // Also fetch DB row for plan info
        const [rows] = await db.query(
            "SELECT status, webhook_url, trial_ends_at, plan, plan_expires_at FROM instances WHERE name=? AND admin_id=? AND deleted_at IS NULL",
            [id, admin.id]
        );

        if (!rows.length) return res.status(404).json({ error: "Instance not found" });

        return res.json({
            id,
            ready: instance ? instance.ready : false,
            hasQr: instance ? !!instance.qr : false,
            status: instance?.ready ? "ready" : (rows[0].status || "pending"),
            webhookUrl: instance?.webhookUrl || rows[0].webhook_url || null,
            plan: rows[0].plan,
            trial_ends_at: rows[0].trial_ends_at,
            plan_expires_at: rows[0].plan_expires_at,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ============================================================
   MESSAGING APIs
   ============================================================ */

function getReadyClient(id) {
    const inst = instances[id];
    if (!inst) return { error: "Instance not running. Please connect first." };
    if (!inst.ready) return { error: "Instance not ready. Scan QR code first." };
    return { client: inst.client };
}

exports.sendMessage = async (req, res) => {
    const { token, number, message } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chatId = number.includes("@") ? number : `${number}@c.us`;
        const sentMsg = await client.sendMessage(chatId, message);

        return res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.sendMedia = async (req, res) => {
    const { token, number, base64, mimetype, filename, caption } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        if (!base64 || !mimetype) return res.status(400).json({ error: "base64 and mimetype are required" });

        const media = new MessageMedia(mimetype, base64, filename || "file");
        const chatId = number.includes("@") ? number : `${number}@c.us`;

        const sentMsg = await client.sendMessage(chatId, media, { caption: caption || "" });

        return res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.sendMediaFromUrl = async (req, res) => {
    const { token, number, url, caption } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
        const chatId = number.includes("@") ? number : `${number}@c.us`;
        const sentMsg = await client.sendMessage(chatId, media, { caption: caption || "" });

        return res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.sendLocation = async (req, res) => {
    const { token, number, latitude, longitude, description } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const { Location } = require("whatsapp-web.js");
        const chatId = number.includes("@") ? number : `${number}@c.us`;
        const loc = new Location(parseFloat(latitude), parseFloat(longitude), description || "");
        const sentMsg = await client.sendMessage(chatId, loc);

        return res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ============================================================
   CHAT APIs
   ============================================================ */

exports.getChats = async (req, res) => {
    const { token } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chats = await client.getChats();
        const result = chats.map(c => ({
            id: c.id._serialized,
            name: c.name,
            isGroup: c.isGroup,
            isReadOnly: c.isReadOnly,
            unreadCount: c.unreadCount,
            timestamp: c.timestamp,
            lastMessage: c.lastMessage ? {
                body: c.lastMessage.body,
                type: c.lastMessage.type,
                timestamp: c.lastMessage.timestamp,
                from: c.lastMessage.from,
            } : null,
        }));

        return res.json({ success: true, count: result.length, data: result });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.getChatMessages = async (req, res) => {
    const { token, limit = 50 } = req.body;
    const id = req.params.id;
    const chatId = req.params.chatId;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: parseInt(limit) });

        const result = messages.map(m => ({
            id: m.id._serialized,
            body: m.body,
            type: m.type,
            from: m.from,
            to: m.to,
            author: m.author,
            timestamp: m.timestamp,
            fromMe: m.fromMe,
            hasMedia: m.hasMedia,
            isForwarded: m.isForwarded,
        }));

        return res.json({ success: true, count: result.length, data: result });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.markChatRead = async (req, res) => {
    const { token, chatId } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chat = await client.getChatById(chatId);
        await chat.sendSeen();

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.deleteMessage = async (req, res) => {
    const { token, chatId, messageId, forEveryone = false } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 100 });
        const msg = messages.find(m => m.id._serialized === messageId);

        if (!msg) return res.status(404).json({ error: "Message not found" });

        await msg.delete(forEveryone);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.reactToMessage = async (req, res) => {
    const { token, chatId, messageId, emoji } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chat = await client.getChatById(chatId);
        const messages = await chat.fetchMessages({ limit: 100 });
        const msg = messages.find(m => m.id._serialized === messageId);

        if (!msg) return res.status(404).json({ error: "Message not found" });

        await msg.react(emoji);
        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ============================================================
   CONTACT APIs
   ============================================================ */

exports.getContacts = async (req, res) => {
    const { token } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const contacts = await client.getContacts();
        const result = contacts
            .filter(c => c.isUser && c.isWAContact)
            .map(c => ({
                id: c.id._serialized,
                name: c.name || c.pushname || c.number,
                number: c.number,
                isMyContact: c.isMyContact,
                isBlocked: c.isBlocked,
            }));

        return res.json({ success: true, count: result.length, data: result });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.checkNumber = async (req, res) => {
    const { token, number } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const numberId = number.includes("@") ? number : `${number}@c.us`;
        const isRegistered = await client.isRegisteredUser(numberId);

        return res.json({ success: true, number, isRegistered });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.getProfilePic = async (req, res) => {
    const { token, number } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const numberId = number.includes("@") ? number : `${number}@c.us`;
        const picUrl = await client.getProfilePicUrl(numberId);

        return res.json({ success: true, number, profilePicUrl: picUrl || null });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.getAccountInfo = async (req, res) => {
    const { token } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const info = client.info;
        return res.json({
            success: true,
            data: {
                wid: info.wid._serialized,
                phone: info.wid.user,
                platform: info.platform,
                pushname: info.pushname,
            },
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ============================================================
   GROUP APIs
   ============================================================ */

exports.getGroups = async (req, res) => {
    const { token } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chats = await client.getChats();
        const groups = chats
            .filter(c => c.isGroup)
            .map(g => ({
                id: g.id._serialized,
                name: g.name,
                participantCount: g.participants ? g.participants.length : 0,
                description: g.description || "",
                timestamp: g.timestamp,
            }));

        return res.json({ success: true, count: groups.length, data: groups });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.createGroup = async (req, res) => {
    const { token, name, participants } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        if (!name || !Array.isArray(participants) || !participants.length)
            return res.status(400).json({ error: "name and participants[] are required" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const participantIds = participants.map(p => p.includes("@") ? p : `${p}@c.us`);
        const group = await client.createGroup(name, participantIds);

        return res.json({
            success: true,
            groupId: group.gid._serialized,
            name,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.addGroupParticipants = async (req, res) => {
    const { token, groupId, participants } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chat = await client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ error: "Not a group" });

        const ids = participants.map(p => p.includes("@") ? p : `${p}@c.us`);
        await chat.addParticipants(ids);

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.removeGroupParticipants = async (req, res) => {
    const { token, groupId, participants } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chat = await client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ error: "Not a group" });

        const ids = participants.map(p => p.includes("@") ? p : `${p}@c.us`);
        await chat.removeParticipants(ids);

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.leaveGroup = async (req, res) => {
    const { token, groupId } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const { client, error } = getReadyClient(id);
        if (error) return res.status(400).json({ error });

        const chat = await client.getChatById(groupId);
        await chat.leave();

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
