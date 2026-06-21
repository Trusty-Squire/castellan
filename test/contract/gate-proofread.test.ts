import { describe, it, expect } from "vitest";
import { gateProofread } from "../../src/contract/gate-proofread.js";

describe("gateProofread — catch a gate that reads state it never seeds", () => {
  it("FLAGS a SELECT-WHERE with no seed (the crypto_storage halt)", () => {
    const g = `echo 'SELECT api_keys FROM users WHERE email="test3@example.com"' | sqlite3 data/app.db | grep -v -E '^(vouchflow_key_|trustysquire_key_)'`;
    expect(gateProofread(g)).toHaveLength(1);
    expect(gateProofread(g)[0]).toMatch(/never seeds/i);
  });

  it("FLAGS a login as a user nobody registers (the auth_module halt)", () => {
    const g = `curl -s -X POST http://localhost:8000/login -d '{"username":"testuser","password":"testpass"}' | jq -e '.access_token != null'`;
    expect(gateProofread(g)).toHaveLength(1);
    expect(gateProofread(g)[0]).toMatch(/never registers/i);
  });

  it("PASSES a gate that registers THEN logs in (the knight's self-seeding gate)", () => {
    const g = `curl -s http://localhost:3000/api/auth/register -d '{"email":"ui@test.com","password":"uipass"}' && curl -s http://localhost:3000/dashboard -u ui@test.com:uipass | grep -q 'API Keys'`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES a gate that INSERTs before it SELECTs", () => {
    const g = `sqlite3 app.db "INSERT INTO users(email,api_keys) VALUES('a@b.c','enc')" && sqlite3 app.db 'SELECT api_keys FROM users WHERE email="a@b.c"' | grep -qv plaintext`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES a gate that seeds via a build script before reading", () => {
    const g = `VOUCHFLOW_BASE_URL=http://localhost:8001 ./run-bot.sh vouchflow a@b.c pw && curl -s http://localhost:3000/api/keys -u a@b.c:pw | grep -q vouchflow`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES a negative auth test (expects 401, seeds nothing — satisfiable)", () => {
    const g = `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/dashboard | grep -q 401`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES an unrelated gate (build/grep) and an empty gate", () => {
    expect(gateProofread("npm run build --if-present")).toEqual([]);
    expect(gateProofread("python3 test_crypto.py && grep -q PASS out.txt")).toEqual([]);
    expect(gateProofread("")).toEqual([]);
  });
});
