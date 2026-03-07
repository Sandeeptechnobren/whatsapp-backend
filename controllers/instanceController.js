const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode  = require("qrcode");
const db      = require("../db");
const crypto  = require("crypto");
const axios   = require("axios");
const path    = require("path");
const fs      = require("fs").promises;

let instances = {};

async function getAdminFromToken(token) {
    if (!token) return null;
    const [rows] = await db.query("SELECT * FROM admins WHERE token = ?", [token]);
    return rows.length ? rows[0] : null;
}

function setNoCacheHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
}

async function forwardToWebhook(webhookUrl, event, instanceName, data) {
    if (!webhookUrl) return;
    try {
        await axios.post(webhookUrl, { event, instance: instanceName, data }, { timeout: 5000 });
    } catch (err) {
        console.error(`[Webhook ${instanceName}] forward error:`, err.message);
    }
}

async function safeDestroyClient(client, instanceName) {
    try { await client.destroy(); } catch (_) { /* ignore */ }

    // Step 2: wait for Windows to release file handles on Chromium's SQLite files
    await new Promise(r => setTimeout(r, 2000));

    // Step 3: retry deleting session dir with backoff (handles Windows EBUSY)
    const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await fs.rm(sessionDir, { recursive: true, force: true });
            return; // success
        } catch (_) {
            if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 1000));
        }
    }
    console.warn(`[${instanceName}] Could not fully clean session dir — will be cleaned on next startup`);
}

/** Attach all standard event handlers to a WhatsApp client */
function attachClientEvents(client, instanceName, adminId) {
    client.on("ready", async () => {
        try {
            if (!instances[instanceName]) return; // guard: instance may have been removed
            // whatsapp-web.js can fire 'ready' multiple times during injection retries —
            // only process the first one
            if (instances[instanceName].ready) return;
            instances[instanceName].ready = true;
            instances[instanceName].qr = null;
            await db.query(
                "UPDATE instances SET status='ready', qr_code=NULL, last_seen=NOW() WHERE name=? AND admin_id=?",
                [instanceName, adminId]
            );
            const wh = instances[instanceName]?.webhookUrl;
            if (wh) forwardToWebhook(wh, "session.connected", instanceName, { instance: instanceName });
            console.log(`[${instanceName}] Connected and ready`);
        } catch (err) { console.error(`[${instanceName}] ready event error:`, err.message); }
    });

    client.on("disconnected", async (reason) => {
        console.log(`[${instanceName}] Disconnected: ${reason}`);
        // Guard: if already cleaned up (e.g. logoutInstance deleted the entry first),
        // skip all further processing to prevent duplicate DB writes and false reconnects.
        if (!instances[instanceName]) return;
        const webhookUrl = instances[instanceName]?.webhookUrl || null;
        delete instances[instanceName];

        // BUG FIX 1: Destroy the Chromium browser immediately after removing the instance
        // from the map. Without this, the process stays alive and keeps a WhatsApp Web
        // session open. When autoReconnect creates a new client seconds later with the
        // same LocalAuth session, WhatsApp detects two simultaneous connections and fires
        // LOGOUT on both — causing the "Connected and ready → Disconnected: LOGOUT" loop.
        client.destroy().catch(() => {});

        try {
            await db.query(
                "UPDATE instances SET status='disconnected', last_seen=NOW() WHERE name=? AND admin_id=?",
                [instanceName, adminId]
            );
        } catch (err) { console.error(`[${instanceName}] disconnect DB error:`, err.message); }

        // BUG FIX 2: When WhatsApp fires LOGOUT the session has been revoked on the
        // server side (user removed the linked device from their phone, or too many
        // devices). Delete the local session directory so restoreActiveSessions doesn't
        // reload a dead session on the next restart, which would produce another instant
        // "ready → LOGOUT" cycle.
        if (reason === "LOGOUT") {
            const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
            fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
            console.log(`[${instanceName}] Session directory removed (LOGOUT — session revoked)`);
        }

        // Auto-reconnect unless the user explicitly logged out or there's a conflict
        if (reason !== "LOGOUT" && reason !== "CONFLICT") {
            console.log(`[${instanceName}] Will auto-reconnect in 5s (reason: ${reason})`);
            setTimeout(() => autoReconnect(instanceName, adminId, webhookUrl), 5000);
        }
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
        } catch (err) { console.error(`[${instanceName}] message event error:`, err.message); }
    });

    client.on("message_ack", async (msg, ack) => {
        const wh = instances[instanceName]?.webhookUrl;
        if (wh) forwardToWebhook(wh, "message.ack", instanceName, { id: msg.id, ack });
    });

    // Keep instances[name].qr up to date on every QR rotation so getQrPng always
    // returns the latest code — critical for restored/auto-reconnected sessions
    client.on("qr", async (qr) => {
        if (!instances[instanceName]) return;
        instances[instanceName].qr = qr;
        instances[instanceName].ready = false;
        await db.query(
            "UPDATE instances SET status='pending', qr_code=? WHERE name=? AND admin_id=?",
            [qr.toString(), instanceName, adminId]
        ).catch(() => {});
        console.log(`[${instanceName}] QR updated`);
    });

    client.on("auth_failure", async (msg) => {
        console.error(`[${instanceName}] Auth failure:`, msg);
        if (instances[instanceName]) delete instances[instanceName];
        // Destroy browser and remove the invalid session so it is not restored on restart
        client.destroy().catch(() => {});
        const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
        fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
        db.query("UPDATE instances SET status='disconnected' WHERE name=? AND admin_id=?", [instanceName, adminId]).catch(() => {});
    });

    client.on("error", (err) => console.error(`[${instanceName}] Client error:`, err.message));
}

function createClient(instanceName) {
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: instanceName }),
        puppeteer: {
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-zygote",
                // Prevent WhatsApp Web from detecting headless Chrome as an automated
                // browser, which causes it to revoke the session immediately after
                // authentication (ready → LOGOUT within seconds).
                "--disable-blink-features=AutomationControlled",
            ],
        },
        // Pin to a locally cached WhatsApp Web version rather than always fetching
        // the latest. WhatsApp pushes updates frequently and newer versions can be
        // incompatible with the current whatsapp-web.js injection until a library
        // patch is released. With 'local', once a working version is cached it stays
        // pinned; delete .wwebjs_cache to force a fresh download.
        webVersionCache: {
            type: "local",
            path: "./.wwebjs_cache",
        },
    });

    // LocalAuth.logout() calls fs.promises.rm() while Chromium still holds file handles
    // open on Windows → EBUSY. This wrapper swallows that error so it never becomes an
    // unhandledRejection. The original function is still called so fresh-session cleanup
    // works when it can; safeDestroyClient handles the retry after the browser closes.
    const _origLogout = client.authStrategy.logout.bind(client.authStrategy);
    client.authStrategy.logout = async () => { try { await _origLogout(); } catch (_) {} };

    return client;
}

// Tracks instances currently in the middle of an auto-reconnect attempt
const reconnecting = new Set();

/** Auto-reconnect an instance after an unexpected disconnect */
async function autoReconnect(instanceName, adminId, webhookUrl) {
    if (instances[instanceName]) return; // already back online
    if (reconnecting.has(instanceName)) return; // another reconnect is already in progress

    // Check session dir exists before trying to reconnect
    const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
    try { await fs.access(sessionDir); } catch { return; } // session was deleted (explicit logout)

    // Verify instance still exists in DB and isn't deleted
    try {
        const [rows] = await db.query(
            "SELECT id FROM instances WHERE name=? AND admin_id=? AND deleted_at IS NULL",
            [instanceName, adminId]
        );
        if (!rows.length) return;
    } catch { return; }

    reconnecting.add(instanceName);
    console.log(`[${instanceName}] Auto-reconnecting...`);
    try {
        const client = createClient(instanceName);
        instances[instanceName] = { client, ready: false, qr: null, webhookUrl: webhookUrl || null };
        attachClientEvents(client, instanceName, adminId);
        client.initialize().catch(err => {
            console.error(`[${instanceName}] Auto-reconnect init error:`, err.message);
            delete instances[instanceName];
        });
    } finally {
        reconnecting.delete(instanceName);
    }
}

/**
 * On server startup: restore WhatsApp sessions for all instances that have a
 * saved LocalAuth session directory. This keeps users logged in across restarts.
 */
async function restoreActiveSessions() {
    const baseDir = path.join(process.cwd(), ".wwebjs_auth");
    let entries;
    try {
        entries = await fs.readdir(baseDir);
    } catch {
        return; // no session dir yet — nothing to restore
    }

    for (const entry of entries) {
        if (!entry.startsWith("session-")) continue;
        const instanceName = entry.slice("session-".length);
        if (instances[instanceName]) continue; // already initializing

        try {
            const [rows] = await db.query(
                "SELECT admin_id, webhook_url FROM instances WHERE name=? AND deleted_at IS NULL LIMIT 1",
                [instanceName]
            );
            if (!rows.length) continue;

            const { admin_id, webhook_url } = rows[0];
            console.log(`[${instanceName}] Restoring saved session...`);

            const client = createClient(instanceName);
            instances[instanceName] = { client, ready: false, qr: null, webhookUrl: webhook_url || null };

            attachClientEvents(client, instanceName, admin_id);
            client.initialize().catch(err => {
                console.error(`[${instanceName}] Session restore init error:`, err.message);
                delete instances[instanceName];
            });
        } catch (err) {
            console.error(`[${instanceName}] Session restore error:`, err.message);
        }
    }
}

exports.restoreActiveSessions = restoreActiveSessions;

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

        // Report current in-memory state without blocking
        if (instances[instance_name]) {
            const inst = instances[instance_name];
            if (inst.ready) return res.json({ success: true, status: "ready" });
            if (inst.qr)    return res.json({ success: true, status: "pending" });
            return res.json({ success: true, status: "initializing" });
        }

        // Start client initialization in the background — respond immediately
        const client = createClient(instance_name);
        instances[instance_name] = { client, ready: false, qr: null, webhookUrl: rows[0].webhook_url || null };
        attachClientEvents(client, instance_name, admin.id);
        client.initialize().catch(err => {
            console.error(`[${instance_name}] init error:`, err.message);
            delete instances[instance_name];
        });

        return res.json({ success: true, status: "initializing" });

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

        const client = createClient(instance_name);
        instances[instance_name] = { client, ready: false, qr: null, webhookUrl: rows[0].webhook_url || null };

        client.on("qr", async (qr) => {
            if (!instances[instance_name]) return; // guard
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

        // Remove from map FIRST so the 'disconnected' event handler sees no entry
        // and exits immediately — prevents the double-LOGOUT / double-cleanup problem.
        delete instances[id];

        // Send the WhatsApp logout signal via Puppeteer (best-effort, 3s timeout).
        const signalPromise = (instance.client.pupPage?.evaluate(
            () => window.Store?.AppState?.logout?.()
        ) ?? Promise.resolve()).catch(() => {});
        await Promise.race([signalPromise, new Promise(resolve => setTimeout(resolve, 3000))]);

        // Destroy browser + clean session files with retry backoff (safe on Windows)
        await safeDestroyClient(instance.client, id);

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
        setNoCacheHeaders(res);
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
