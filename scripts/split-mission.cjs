// Build a single-piece-flow c15 mission: split the over-bundled secure-storage node into
// crypto → auth → storage (each one file, one concern, one focused gate). Keep all the web-app
// gate fixes. Run: node scripts/split-mission.js
const y = require("../node_modules/yaml");
const f = require("fs");
const { deriveUiGate } = require("../dist/contract/derive2.js");
const { briefFileCoherence } = require("../dist/contract/gate-proofread.js");

const m = y.parse(f.readFileSync("/home/lunchbox/squire-c13/mission.yaml", "utf8"));
const ss = m.nodes.find((n) => n.id === "secure-storage");
const CONTRACT = ss.brief.split("\n\n---")[0]; // the SHARED CONTRACT preamble, reused by each node

const cryptoGate =
  `node -e "const c=require('./crypto');const e=c.encrypt('secret-value-123','mykey');` +
  `if(e==='secret-value-123'){console.error('not encrypted');process.exit(1)}` +
  `const d=c.decrypt(e,'mykey');if(d!=='secret-value-123'){console.error('round-trip failed',d);process.exit(1)}` +
  `process.exit(0)"`;

const authGate =
  `node -e "const a=require('./auth');(async()=>{const h=await a.hash_password('pw123');` +
  `if(h==='pw123'){console.error('not hashed');process.exit(1)}` +
  `const ok=await a.verify_password('pw123',h);const bad=await a.verify_password('wrongpw',h);` +
  `if(ok!==true||bad!==false){console.error('verify wrong',ok,bad);process.exit(1)}` +
  `process.exit(0)})().catch(e=>{console.error(e);process.exit(1)})"`;

const storageGate =
  `rm -rf data && mkdir -p data && { [ -f schema.sql ] && sqlite3 data/app.db < schema.sql 2>/dev/null; true; } && ` +
  `node -e "const storage=require('./storage');(async()=>{` +
  `await storage.create_user('test3@example.com','password123');` +
  `await storage.store_api_key('test3@example.com','vouchflow','vouchflow_key_123');` +
  `await storage.store_api_key('test3@example.com','trustysquire','trustysquire_key_456');` +
  `const k=await storage.get_user_keys('test3@example.com','password123');` +
  `if(!k||k.vouchflow!=='vouchflow_key_123'||k.trustysquire!=='trustysquire_key_456'){console.error('round-trip failed',k);process.exit(1)}` +
  `process.exit(0)})().catch(e=>{console.error(e);process.exit(1)})" ` +
  `&& ! grep -rqF 'vouchflow_key_123' data/ && ! grep -rqF 'trustysquire_key_456' data/`;

const cryptoNode = {
  id: "crypto",
  brief: `${CONTRACT}\n\n---\n\nBuild ONLY crypto.js. Export encrypt(data, key) and decrypt(data, key) using Node's BUILT-IN node:crypto module with AES-256 (do NOT install any package). decrypt must exactly reverse encrypt. The key argument is an arbitrary string — derive a 32-byte AES-256 key from it deterministically (e.g. crypto.createHash('sha256').update(key).digest()). encrypt('x', k) MUST NOT equal 'x' (it is ciphertext); decrypt(encrypt('x', k), k) MUST equal 'x'.`,
  deps: [],
  context_globs: [],
  blast_radius: ["crypto.js", "test/crypto.test.js"],
  budget_usd: 0.12,
};

const authNode = {
  id: "auth",
  brief: `${CONTRACT}\n\n---\n\nBuild ONLY auth.js. Export hash_password(password) and verify_password(password, hash) using bcrypt (add "bcrypt" to package.json — it will be installed). hash_password returns a hash that is NOT the plaintext; verify_password(pw, hash) returns true for the correct password and false otherwise. Sync (hashSync/compareSync) or async are both fine.`,
  deps: [],
  context_globs: [],
  blast_radius: ["auth.js", "test/auth.test.js", "package.json"],
  budget_usd: 0.12,
};

const storageNode = {
  id: "storage",
  brief: `${CONTRACT}\n\n---\n\nBuild ONLY storage.js (you MAY also create schema.sql). crypto.js and auth.js ALREADY EXIST — require('./crypto') and require('./auth'). Export: create_user(email, password) — hash the password via auth.hash_password and INSERT the user; store_api_key(email, provider, api_key) — encrypt the api_key via crypto.encrypt and update the user's api_keys (a JSON object {provider: encrypted_key}); get_user_keys(email, password) — verify the password via auth.verify_password and return the DECRYPTED keys {provider: api_key}. Use SQLite (add "sqlite3" to package.json) with a users table (id, email, password_hash, api_keys). Initialize the schema with CREATE TABLE IF NOT EXISTS so a fresh data/app.db works on first use. Raw api keys must NEVER appear in the DB — always store them encrypted.`,
  deps: ["crypto", "auth"],
  context_globs: ["crypto.js", "auth.js"],
  blast_radius: ["storage.js", "schema.sql", "test/storage.test.js", "package.json", "data/.gitkeep"],
  budget_usd: 0.2,
};

// gates live alongside nodes in this mission shape (node.gate)
cryptoNode.gate = { type: "command", run: cryptoGate };
authNode.gate = { type: "command", run: authGate };
storageNode.gate = { type: "command", run: storageGate };

// Replace secure-storage with the three; repoint dependents to `storage`.
m.nodes = m.nodes.filter((n) => n.id !== "secure-storage");
m.nodes.unshift(cryptoNode, authNode, storageNode);
for (const n of m.nodes) {
  if (n.deps) n.deps = n.deps.map((d) => (d === "secure-storage" ? "storage" : d));
}

// web-app: login-driving DOM gate + explicit serving clause + brief↔radius coherence.
const web = m.nodes.find((n) => n.id === "web-app");
if (web && !web.brief.includes("MUST serve the login page at GET /")) {
  web.brief += "\n\nSERVING (critical — the page must be REACHABLE, not just created): the Express app MUST serve the login page at GET / (the root route returns login.html containing [data-testid=login-form], [data-testid=email-input], [data-testid=password-input], [data-testid=login-button]). An unauthenticated GET /dashboard redirects to GET /. After a successful POST /login, redirect to GET /dashboard which serves dashboard.html ([data-testid=dashboard], [data-testid=api-keys-list], [data-testid=logout-button]).";
}
for (const n of m.nodes) for (const g of briefFileCoherence(n.brief, n.blast_radius)) if (!n.blast_radius.includes(g)) n.blast_radius.push(g);
if (web) web.gate = deriveUiGate({ brief: web.brief }, web.brief);

f.writeFileSync("/home/lunchbox/squire-c15/mission.yaml", y.stringify(m));
console.log("nodes:", m.nodes.map((n) => `${n.id}[${(n.deps || []).join(",")}]`).join("  "));
