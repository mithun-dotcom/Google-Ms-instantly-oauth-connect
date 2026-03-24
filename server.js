// server.js — Instantly OAuth Connector Backend
// Deploy to Render (free tier)
const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());
app.get("/", (_, res) => res.json({ status: "ok", service: "instantly-oauth-connector" }));

app.post("/api/instantly", async (req, res) => {
  const { action, apiKey, data } = req.body || {};
  if (!apiKey) return res.json({ ok: false, error: "Missing API key" });

  const authHeaders = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    let result;

    if (action === "init_oauth") {
      const provider = data?.provider || "microsoft"; // "google" or "microsoft"
      const r = await fetch(`https://api.instantly.ai/api/v2/oauth/${provider}/init`, {
        method: "POST", headers: authHeaders, body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || `Instantly error ${r.status}`);

      let authUrl = j.auth_url || j.authUrl || "";
      if (data?.email && authUrl) {
        const sep = authUrl.includes("?") ? "&" : "?";
        if (provider === "microsoft") {
          const domain = data.email.split("@")[1] || "";
          // For Microsoft: login_hint pre-fills email, prompt=login bypasses account picker
          authUrl += `${sep}login_hint=${encodeURIComponent(data.email)}&prompt=login&domain_hint=${encodeURIComponent(domain)}`;
        } else {
          // For Google: login_hint pre-fills email
          authUrl += `${sep}login_hint=${encodeURIComponent(data.email)}`;
        }
      }
      result = { sessionId: j.session_id || j.sessionId, authUrl };
    }

    else if (action === "poll_session") {
      const r = await fetch(
        `https://api.instantly.ai/api/v2/oauth/session/status/${data.sessionId}`,
        { headers: authHeaders }
      );
      const j = await r.json();
      result = { status: j.status, email: j.email, error: j.error_description || j.error };
    }

    else if (action === "check_account") {
      const r = await fetch(
        `https://api.instantly.ai/api/v2/accounts?search=${encodeURIComponent(data.email)}&limit=5`,
        { headers: authHeaders }
      );
      const j = await r.json();
      result = { exists: (j.items || []).some(a => a.email?.toLowerCase() === data.email.toLowerCase()) };
    }

    else throw new Error(`Unknown action: ${action}`);

    res.json({ ok: true, result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`Instantly OAuth backend running on port ${PORT}`));
