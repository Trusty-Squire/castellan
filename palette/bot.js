// BOT SKELETON (palette) — signs up to a SaaS provider, extracts the api key, stores it.
// Exports signup_and_extract(provider, email, password, base_url) -> Credential (for tests /
// integration), AND runs as a CLI that also persists the key via the storage module.
//
// To use: copy this to bot.js (and run-bot.sh) and use it as-is. Uses Node's built-in fetch.
// Provider protocol (from the contract): POST <base>/signup {email,password} -> {dashboard_token};
// GET <base>/api-key  Authorization: Bearer <dashboard_token>  -> {api_key}.
const storage = require("./storage");

async function signup_and_extract(provider, email, password, base_url) {
  const signup = await fetch(`${base_url}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!signup.ok) throw new Error(`signup failed: ${signup.status}`);
  const { dashboard_token } = await signup.json();
  const keyResp = await fetch(`${base_url}/api-key`, {
    headers: { authorization: `Bearer ${dashboard_token}` },
  });
  if (!keyResp.ok) throw new Error(`api-key failed: ${keyResp.status}`);
  const { api_key } = await keyResp.json();
  return { provider, email, password, api_key };
}

module.exports = { signup_and_extract };

if (require.main === module) {
  const [, , provider, email, password, base_url] = process.argv;
  signup_and_extract(provider, email, password, base_url)
    .then(async (cred) => {
      try { await storage.create_user(email, password); } catch { /* user may already exist */ }
      await storage.store_api_key(email, provider, cred.api_key);
      console.log(`stored ${provider} key for ${email}`);
    })
    .catch((e) => { console.error(e.message || e); process.exit(1); });
}
