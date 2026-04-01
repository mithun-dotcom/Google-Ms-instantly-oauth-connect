const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Instantly OAuth Backend", time: new Date().toISOString() });
});

app.post("/api/instantly", async (req, res) => {
  try {
    const { action, apiKey, data } = req.body || {};
    if (!apiKey) return res.json({ ok: false, error: "Missing API key" });

    const authHeaders = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    let result;

    // ── Init OAuth session ────────────────────────────────────────────────────
    if (action === "init_oauth") {
      const provider = data?.provider || "microsoft";
      const endpoint = provider === "google"
        ? "https://api.instantly.ai/api/v2/oauth/google/init"
        : "https://api.instantly.ai/api/v2/oauth/microsoft/init";

      const r = await fetch(endpoint, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || `Instantly error ${r.status}`);

      // !! Pass authUrl 100% untouched — Instantly signs the state param.
      // Any modification (login_hint, prompt dedup, anything) breaks the
      // signature and causes U402 on the redirect callback.
      const authUrl = j.auth_url || j.authUrl || "";

      result = { sessionId: j.session_id || j.sessionId, authUrl };
    }

    // ── Poll session status ───────────────────────────────────────────────────
    else if (action === "poll_session") {
      const r = await fetch(
        `https://api.instantly.ai/api/v2/oauth/session/status/${data.sessionId}`,
        { headers: authHeaders }
      );
      const j = await r.json();
      result = { status: j.status, email: j.email, error: j.error_description || j.error };
    }

    // ── Check if account already exists ──────────────────────────────────────
    else if (action === "check_account") {
      const r = await fetch(
        `https://api.instantly.ai/api/v2/accounts?search=${encodeURIComponent(data.email)}&limit=5`,
        { headers: authHeaders }
      );
      const j = await r.json();
      const exists = (j.items || []).some(
        a => a.email?.toLowerCase() === data.email.toLowerCase()
      );
      result = { exists };
    }

    // ── List accounts ─────────────────────────────────────────────────────────
    else if (action === "list_accounts") {
      const r = await fetch(
        `https://api.instantly.ai/api/v2/accounts?limit=100&skip=${data?.skip || 0}`,
        { headers: authHeaders }
      );
      const j = await r.json();
      result = { accounts: j.items || [], total: j.total };
    }

    else throw new Error(`Unknown action: ${action}`);

    res.json({ ok: true, result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Instantly OAuth Backend running on port ${PORT}`);
});
