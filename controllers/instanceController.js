const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode  = require("qrcode");
const db      = require("../db");
const crypto  = require("crypto");
const axios   = require("axios");
const path    = require("path");
const fs      = require("fs").promises;

/* ────────────────────────────────────────────────────────────────────────────
   Groq AI — used for auto-reply
   API key and model are stored per-admin in the DB (dynamic, changeable from UI).
   process.env.GROQ_API_KEY / GROQ_MODEL serve as server-wide fallbacks.
   ──────────────────────────────────────────────────────────────────────────── */
const Groq = require("groq-sdk");

/* ── Conversation history helpers ────────────────────────────────────────── */

/** Fetch the last `limit` messages for a chat, oldest-first (for Groq context). */
async function getConversationHistory(instanceDbId, chatId, limit = 20) {
    try {
        const [rows] = await db.query(
            `SELECT role, content
               FROM messages
              WHERE instance_id = ? AND chat_id = ?
              ORDER BY created_at DESC
              LIMIT ?`,
            [instanceDbId, chatId, limit]
        );
        return rows.reverse(); // oldest → newest
    } catch (err) {
        console.error("[Memory] fetch error:", err.message);
        return [];
    }
}

/** Persist a single message (user or assistant) to the messages table. */
async function saveMessage(instanceDbId, chatId, role, content, waTimestamp) {
    try {
        await db.query(
            `INSERT INTO messages (instance_id, chat_id, role, content, wa_timestamp)
             VALUES (?, ?, ?, ?, ?)`,
            [instanceDbId, chatId, role, content, waTimestamp || null]
        );
    } catch (err) {
        console.error("[Memory] save error:", err.message);
    }
}

/* ── Groq reply with full conversation context ───────────────────────────── */

/**
 * @param {string|null} apiKey       - admin's Groq key (falls back to .env)
 * @param {string|null} model        - Groq model name
 * @param {string}      systemPrompt - AI persona / instructions
 * @param {Array}       history      - [{role:'user'|'assistant', content:string}, ...]
 * @param {string}      userMessage  - the latest incoming message
 */
async function generateGroqReply(apiKey, model, systemPrompt, history, userMessage) {
    const key   = apiKey  || process.env.GROQ_API_KEY;
    const mdl   = model   || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
    const sysPr = systemPrompt?.trim() ||
        "You are a helpful WhatsApp assistant. Reply concisely and professionally.";

    if (!key) {
        console.warn("[Groq] No API key — configure it in AI Settings.");
        return null;
    }

    try {
        const groq = new Groq({ apiKey: key });

        const messages = [
            { role: "system", content: sysPr },
            ...history,                           // previous turns
            { role: "user",   content: userMessage }, // current message
        ];

        const completion = await groq.chat.completions.create({
            model: mdl,
            messages,
            max_tokens: 512,
            temperature: 0.7,
        });
        return completion.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
        console.error("[Groq] Error generating reply:", err.message);
        return null;
    }
}

/* ────────────────────────────────────────────────────────────────────────────
   In-memory instance store
   Structure: instances[instanceName] = {
     client, ready, qr,
     instanceDbId,                              ← instances.id PK (for messages FK)
     adminId,
     webhookUrl,
     autoReply:    { enabled, scope, prompt },
     groqSettings: { apiKey, model }
   }
   ──────────────────────────────────────────────────────────────────────────── */
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

    await new Promise(r => setTimeout(r, 2000));

    const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await fs.rm(sessionDir, { recursive: true, force: true });
            return;
        } catch (_) {
            if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 1000));
        }
    }
    console.warn(`[${instanceName}] Could not fully clean session dir`);
}

/** Attach all standard event handlers to a WhatsApp client */
function attachClientEvents(client, instanceName, adminId) {
    client.on("ready", async () => {
        try {
            if (!instances[instanceName]) return;
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
        if (!instances[instanceName]) return;
        const webhookUrl = instances[instanceName]?.webhookUrl || null;
        delete instances[instanceName];

        client.destroy().catch(() => {});

        try {
            await db.query(
                "UPDATE instances SET status='disconnected', last_seen=NOW() WHERE name=? AND admin_id=?",
                [instanceName, adminId]
            );
        } catch (err) { console.error(`[${instanceName}] disconnect DB error:`, err.message); }

        if (reason === "LOGOUT") {
            const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
            fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
            console.log(`[${instanceName}] Session directory removed (LOGOUT)`);
        }

        // Auto-reconnect unless explicit logout or conflict
        if (reason !== "LOGOUT" && reason !== "CONFLICT") {
            console.log(`[${instanceName}] Will auto-reconnect in 5s (reason: ${reason})`);
            setTimeout(() => autoReconnect(instanceName, adminId, webhookUrl), 5000);
        }
    });

    client.on("message", async (msg) => {
        try {
            const inst = instances[instanceName];
            if (!inst) return;

            // Forward to webhook
            const wh = inst.webhookUrl;
            if (wh) {
                await forwardToWebhook(wh, "message", instanceName, {
                    from:      msg.from,
                    to:        msg.to,
                    body:      msg.body,
                    type:      msg.type,
                    timestamp: msg.timestamp,
                    isGroup:   msg.from.endsWith("@g.us"),
                    author:    msg.author || null,
                    hasMedia:  msg.hasMedia,
                });
            }

            // ── Groq auto-reply with conversation memory ───────────────────────
            const ar = inst.autoReply;
            if (ar?.enabled && msg.body && !msg.fromMe) {
                const isGroup  = msg.from.endsWith("@g.us");
                const scope    = ar.scope || "private";
                const shouldReply =
                    scope === "all" ||
                    (scope === "private" && !isGroup) ||
                    (scope === "groups"  && isGroup);

                if (shouldReply) {
                    const chatId      = msg.from;          // unique per conversation
                    const instanceDbId = inst.instanceDbId;

                    // 1. Persist the incoming user message
                    await saveMessage(instanceDbId, chatId, "user", msg.body, msg.timestamp);

                    // 2. Load previous conversation turns for context
                    const history = await getConversationHistory(instanceDbId, chatId, 20);
                    // Remove the message we just saved (last entry) — it will be
                    // passed separately as the final "user" turn in generateGroqReply
                    if (history.length > 0) history.pop();

                    // 3. Generate reply using full context
                    const gs    = inst.groqSettings || {};
                    const reply = await generateGroqReply(
                        gs.apiKey, gs.model, ar.prompt, history, msg.body
                    );

                    if (reply) {
                        // 4. Send the reply
                        await msg.reply(reply);
                        // 5. Persist the assistant reply
                        await saveMessage(instanceDbId, chatId, "assistant", reply, null);
                        console.log(`[${instanceName}] Auto-replied to ${chatId} (history: ${history.length} turns)`);
                    }
                }
            }
        } catch (err) { console.error(`[${instanceName}] message event error:`, err.message); }
    });

    client.on("message_ack", async (msg, ack) => {
        const wh = instances[instanceName]?.webhookUrl;
        if (wh) forwardToWebhook(wh, "message.ack", instanceName, { id: msg.id, ack });
    });

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
        client.destroy().catch(() => {});
        const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
        fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
        db.query("UPDATE instances SET status='disconnected' WHERE name=? AND admin_id=?", [instanceName, adminId]).catch(() => {});
    });

    client.on("error", (err) => console.error(`[${instanceName}] Client error:`, err.message));
}

function createClient(instanceName) {
    const puppeteerConfig = {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-zygote",
            "--disable-blink-features=AutomationControlled",
        ],
    };

    if (process.platform === "linux") {
        const chromePaths = [
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
        ];
        const fs_sync = require("fs");
        const systemChrome = chromePaths.find(p => {
            try { fs_sync.accessSync(p); return true; } catch { return false; }
        });
        if (systemChrome) puppeteerConfig.executablePath = systemChrome;
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: instanceName }),
        puppeteer: puppeteerConfig,
        webVersionCache: { type: "local", path: "./.wwebjs_cache" },
    });

    const _origLogout = client.authStrategy.logout.bind(client.authStrategy);
    client.authStrategy.logout = async () => { try { await _origLogout(); } catch (_) {} };

    return client;
}

const reconnecting = new Set();

/** Fetch admin's Groq settings from DB (returns {apiKey, model}) */
async function getAdminGroqSettings(adminId) {
    try {
        const [rows] = await db.query(
            "SELECT groq_api_key, groq_model FROM admins WHERE id=?",
            [adminId]
        );
        if (!rows.length) return { apiKey: null, model: null };
        return {
            apiKey: rows[0].groq_api_key || null,
            model:  rows[0].groq_model   || null,
        };
    } catch { return { apiKey: null, model: null }; }
}

/**
 * After an admin updates their Groq settings, call this to immediately sync
 * all their running instances in memory — no restart required.
 */
function syncGroqSettingsInMemory(adminId, groqSettings) {
    for (const name of Object.keys(instances)) {
        if (instances[name].adminId === adminId) {
            instances[name].groqSettings = groqSettings;
        }
    }
}

exports.syncGroqSettingsInMemory = syncGroqSettingsInMemory;

/** Auto-reconnect an instance after an unexpected disconnect */
async function autoReconnect(instanceName, adminId, webhookUrl) {
    if (instances[instanceName]) return;
    if (reconnecting.has(instanceName)) return;

    const sessionDir = path.join(process.cwd(), ".wwebjs_auth", `session-${instanceName}`);
    try { await fs.access(sessionDir); } catch { return; }

    let dbRow = null;
    try {
        const [rows] = await db.query(
            "SELECT id, webhook_url, auto_reply_enabled, auto_reply_scope, auto_reply_prompt FROM instances WHERE name=? AND admin_id=? AND deleted_at IS NULL",
            [instanceName, adminId]
        );
        if (!rows.length) return;
        dbRow = rows[0];
    } catch { return; }

    reconnecting.add(instanceName);
    console.log(`[${instanceName}] Auto-reconnecting...`);
    const groqSettings = await getAdminGroqSettings(adminId);
    try {
        const client = createClient(instanceName);
        instances[instanceName] = {
            client,
            ready: false,
            qr: null,
            instanceDbId: dbRow.id,
            adminId,
            webhookUrl: webhookUrl || dbRow.webhook_url || null,
            autoReply: {
                enabled: !!dbRow.auto_reply_enabled,
                scope:   dbRow.auto_reply_scope   || "private",
                prompt:  dbRow.auto_reply_prompt  || "",
            },
            groqSettings,
        };
        attachClientEvents(client, instanceName, adminId);
        client.initialize().catch(err => {
            console.error(`[${instanceName}] Auto-reconnect init error:`, err.message);
            delete instances[instanceName];
        });
    } finally {
        reconnecting.delete(instanceName);
    }
}

exports.restoreActiveSessions = async function restoreActiveSessions() {
    // NOTE: This function is intentionally NOT called on startup.
    // Instances are loaded into RAM only when the user explicitly connects them.
    // This saves resources — each instance runs a Chromium browser process.
    // To restore all saved sessions manually, call this function directly.
    const baseDir = path.join(process.cwd(), ".wwebjs_auth");
    let entries;
    try {
        entries = await fs.readdir(baseDir);
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.startsWith("session-")) continue;
        const instanceName = entry.slice("session-".length);
        if (instances[instanceName]) continue;

        try {
            const [rows] = await db.query(
                "SELECT id, admin_id, webhook_url, auto_reply_enabled, auto_reply_scope, auto_reply_prompt FROM instances WHERE name=? AND deleted_at IS NULL LIMIT 1",
                [instanceName]
            );
            if (!rows.length) continue;

            const row = rows[0];
            console.log(`[${instanceName}] Restoring saved session...`);

            const groqSettings = await getAdminGroqSettings(row.admin_id);
            const client = createClient(instanceName);
            instances[instanceName] = {
                client,
                ready: false,
                qr: null,
                instanceDbId: row.id,
                adminId: row.admin_id,
                webhookUrl: row.webhook_url || null,
                autoReply: {
                    enabled: !!row.auto_reply_enabled,
                    scope:   row.auto_reply_scope  || "private",
                    prompt:  row.auto_reply_prompt || "",
                },
                groqSettings,
            };

            attachClientEvents(client, instanceName, row.admin_id);
            client.initialize().catch(err => {
                console.error(`[${instanceName}] Session restore init error:`, err.message);
                delete instances[instanceName];
            });
        } catch (err) {
            console.error(`[${instanceName}] Session restore error:`, err.message);
        }
    }
};

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
        trialEndsAt.setDate(trialEndsAt.getDate() + 6);

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
            `SELECT id, name, token, status, uuid, trial_ends_at, plan, plan_expires_at, last_seen,
                    auto_reply_enabled, auto_reply_scope
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
        const token = req.query.token || req.body?.token;
        const instanceId = req.params.uuid;

        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const [rows] = await db.query(
            `SELECT id, name, token, status, uuid, trial_ends_at, plan, plan_expires_at,
                    webhook_url, last_seen, auto_reply_enabled, auto_reply_scope, auto_reply_prompt
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

        const row = rows[0];
        const groqSettings = await getAdminGroqSettings(admin.id);
        const client = createClient(instance_name);
        instances[instance_name] = {
            client,
            ready: false,
            qr: null,
            instanceDbId: row.id,
            adminId: admin.id,
            webhookUrl: row.webhook_url || null,
            autoReply: {
                enabled: !!row.auto_reply_enabled,
                scope:   row.auto_reply_scope  || "private",
                prompt:  row.auto_reply_prompt || "",
            },
            groqSettings,
        };
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

        const row = rows[0];
        const groqSettings = await getAdminGroqSettings(admin.id);
        const client = createClient(instance_name);
        instances[instance_name] = {
            client,
            ready: false,
            qr: null,
            instanceDbId: row.id,
            adminId: admin.id,
            webhookUrl: row.webhook_url || null,
            autoReply: {
                enabled: !!row.auto_reply_enabled,
                scope:   row.auto_reply_scope  || "private",
                prompt:  row.auto_reply_prompt || "",
            },
            groqSettings,
        };

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

        delete instances[id];

        const signalPromise = (instance.client.pupPage?.evaluate(
            () => window.Store?.AppState?.logout?.()
        ) ?? Promise.resolve()).catch(() => {});
        await Promise.race([signalPromise, new Promise(resolve => setTimeout(resolve, 3000))]);

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

        const instance = instances[id];

        const [rows] = await db.query(
            `SELECT status, webhook_url, trial_ends_at, plan, plan_expires_at,
                    auto_reply_enabled, auto_reply_scope
             FROM instances WHERE name=? AND admin_id=? AND deleted_at IS NULL`,
            [id, admin.id]
        );

        if (!rows.length) return res.status(404).json({ error: "Instance not found" });

        return res.json({
            id,
            ready:      instance ? instance.ready : false,
            hasQr:      instance ? !!instance.qr : false,
            status:     instance?.ready ? "ready" : (rows[0].status || "pending"),
            webhookUrl: instance?.webhookUrl || rows[0].webhook_url || null,
            plan:              rows[0].plan,
            trial_ends_at:     rows[0].trial_ends_at,
            plan_expires_at:   rows[0].plan_expires_at,
            auto_reply_enabled: !!rows[0].auto_reply_enabled,
            auto_reply_scope:   rows[0].auto_reply_scope || "private",
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ============================================================
   AUTO-REPLY SETTINGS
   ============================================================ */

exports.getAutoReplySettings = async (req, res) => {
    const token = req.body?.token || req.query.token;
    const id    = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const [rows] = await db.query(
            "SELECT auto_reply_enabled, auto_reply_scope, auto_reply_prompt FROM instances WHERE name=? AND admin_id=? AND deleted_at IS NULL",
            [id, admin.id]
        );
        if (!rows.length) return res.status(404).json({ error: "Instance not found" });

        return res.json({
            success: true,
            enabled: !!rows[0].auto_reply_enabled,
            scope:   rows[0].auto_reply_scope  || "private",
            prompt:  rows[0].auto_reply_prompt || "",
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

exports.updateAutoReplySettings = async (req, res) => {
    const { token, enabled, scope, prompt } = req.body;
    const id = req.params.id;

    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const validScopes = ["private", "groups", "all"];
        const safeScope   = validScopes.includes(scope) ? scope : "private";

        await db.query(
            "UPDATE instances SET auto_reply_enabled=?, auto_reply_scope=?, auto_reply_prompt=? WHERE name=? AND admin_id=? AND deleted_at IS NULL",
            [enabled ? 1 : 0, safeScope, prompt || null, id, admin.id]
        );

        // Sync in-memory state immediately
        if (instances[id]) {
            instances[id].autoReply = {
                enabled: !!enabled,
                scope:   safeScope,
                prompt:  prompt || "",
            };
        }

        return res.json({ success: true });
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
                wid:      info.wid._serialized,
                phone:    info.wid.user,
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

        return res.json({ success: true, groupId: group.gid._serialized, name });
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
