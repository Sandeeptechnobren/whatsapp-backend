const db   = require("../db");
const Groq = require("groq-sdk");
const { syncGroqSettingsInMemory } = require("./instanceController");

async function getAdminFromToken(token) {
    if (!token) return null;
    const [rows] = await db.query("SELECT * FROM admins WHERE token = ?", [token]);
    return rows.length ? rows[0] : null;
}

/* ── GET AI settings ───────────────────────────────────────────────────── */
exports.getAISettings = async (req, res) => {
    const token = req.body?.token || req.query.token;
    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        return res.json({
            success: true,
            groqApiKey: admin.groq_api_key ? maskKey(admin.groq_api_key) : "",
            groqApiKeySet: !!admin.groq_api_key,
            groqModel: admin.groq_model || process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ── UPDATE AI settings ────────────────────────────────────────────────── */
exports.updateAISettings = async (req, res) => {
    const { token, groqApiKey, groqModel } = req.body;
    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        const safeKey   = groqApiKey?.trim() || null;
        const safeModel = groqModel?.trim()   || "llama-3.3-70b-versatile";

        await db.query(
            "UPDATE admins SET groq_api_key=?, groq_model=? WHERE id=?",
            [safeKey, safeModel, admin.id]
        );

        // Immediately sync all running instances owned by this admin
        syncGroqSettingsInMemory(admin.id, {
            apiKey: safeKey,
            model:  safeModel,
        });

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

/* ── TEST AI connection ─────────────────────────────────────────────────── */
exports.testAIConnection = async (req, res) => {
    const { token, groqApiKey, groqModel } = req.body;
    try {
        const admin = await getAdminFromToken(token);
        if (!admin) return res.status(401).json({ error: "Invalid token" });

        // Use the key provided in request, or the admin's saved key, or .env fallback
        const key   = groqApiKey?.trim() || admin.groq_api_key || process.env.GROQ_API_KEY;
        const model = groqModel?.trim()   || admin.groq_model   || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

        if (!key) return res.status(400).json({ error: "No Groq API key configured." });

        const groq = new Groq({ apiKey: key });
        const completion = await groq.chat.completions.create({
            model,
            messages: [{ role: "user", content: "Say: test OK" }],
            max_tokens: 10,
        });
        const reply = completion.choices[0]?.message?.content?.trim();
        return res.json({ success: true, reply, model });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
};

function maskKey(key) {
    if (!key || key.length < 8) return "****";
    return key.slice(0, 6) + "****" + key.slice(-4);
}
