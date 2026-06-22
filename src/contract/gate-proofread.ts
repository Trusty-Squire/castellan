/**
 * The gate SATISFIABILITY proofreader. A recurring, expensive failure: an authored gate
 * READS persisted/authenticated state it never SEEDS — an empty `SELECT … WHERE`, a
 * login as a user nobody registered — so NO build can pass it, and the executor burns its
 * whole escalation ladder discovering that. Authored gates slip this even from a premium
 * model (measured across the trustysquire probe). So the harness proofreads gates at derive
 * time and repairs the clear cases before the build ever runs them.
 *
 * HIGH PRECISION by design: only flag a read that has NO seeding mechanism at all (no
 * INSERT/store, no register/signup, no script that could populate state). A gate that can
 * set up its own preconditions is trusted — false-flagging a good gate would break a
 * working build, which is worse than missing one.
 */
import type { LlmClient } from "../llm/types.js";

/** A gate that can plausibly seed its own state — if so, we trust it and don't proofread further. */
function canSeedItself(gate: string): boolean {
  return /\bINSERT\b|\bUPDATE\b|VALUES\s*\(|\bcreate[_-]?user\b|\bregister\b|\bsign[_-]?up\b|\bstore[_-]?key\b|\.save\(|\.set\(|\bseed\b|\.\/[\w./-]+\.(sh|py|js|mjs|ts)\b|\bnode\s+[\w./-]+\.(c?js|mjs)\b|\bpython3?\s+[\w./-]+\.py\b/i.test(gate);
}

/**
 * PURE: the satisfiability issues with a gate command. Empty array = no clear problem.
 * Each issue is a human-readable reason the gate cannot be passed by ANY correct build.
 */
export function gateProofread(gate: string): string[] {
  const issues: string[] = [];
  if (!gate || canSeedItself(gate)) return issues;

  // 1. Reads a specific persisted row it never wrote → the query is empty → never passes.
  if (/\bSELECT\b[\s\S]*\bWHERE\b/i.test(gate)) {
    issues.push(
      "reads a specific row (SELECT … WHERE) but the gate never seeds it — the query is empty, so no build can pass it",
    );
  }

  // 2. Authenticates as a literal user it never registers → real auth rejects the unknown
  //    user → never passes. Needs both an auth-read shape AND an auth context to fire.
  const authReadShape = /\/login\b|["']username["']\s*:|["']email["'][\s\S]*["']password["']|-u\s+\S+:\S+/.test(gate);
  const authContext = /login|auth|token|access_token|dashboard|\/api\//i.test(gate);
  if (authReadShape && authContext) {
    issues.push(
      "authenticates as a user it never registers — a correct auth rejects the unknown user, so no build can pass it",
    );
  }
  return issues;
}

/** A foreign persistence inspector — a DB engine/CLI used to read state the BUILD owns. */
const FOREIGN_DB_READER_RE =
  /\|\s*sqlite3\b|\bsqlite3\s+[\w./-]+\.(?:db|sqlite\d?)\b|\bpsql\b|\bmysql\s+-|\bmongosh?\b|\bredis-cli\b/i;

/** The gate drives the build's OWN module (so an interface EXISTS to verify through). */
const DRIVES_BUILD_MODULE_RE = /require\(['"]\.\/|\bfrom\s+['"]\.\/|\bimport\s+['"]\.\//i;

/**
 * INTERFACE COHERENCE: a gate that drives the build's own module but READS BACK by reaching
 * AROUND it with a foreign persistence tool (sqlite3/psql/redis-cli on the raw store). That
 * foreign reader silently DICTATES the storage mechanism — the worker must now produce a file
 * THAT tool can open (the crypto-storage trap: qwen fought node-gyp / SQLITE_CANTOPEN for 8
 * rungs, none of it about the actual requirement: key stored, not plaintext, readable back).
 * The property should be verified through the module's OWN read API, leaving persistence the
 * worker's choice. Returns an issue string, or null when coherent (no foreign reader, or the
 * build exposes no module interface to verify through, so the tool IS the contract).
 */
export function interfaceCoherence(gate: string): string | null {
  if (!gate) return null;
  if (!FOREIGN_DB_READER_RE.test(gate)) return null;
  if (!DRIVES_BUILD_MODULE_RE.test(gate)) return null;
  return "verifies persistence by reaching AROUND the build's interface with a foreign DB tool (sqlite3/psql/…), which forces a specific storage mechanism on the worker — verify through the module's own read API instead (round-trip the value, then assert the plaintext is absent from the persisted store)";
}

/**
 * Repair an interface-incoherent gate via the PLANNER (knight): rewrite it to verify the
 * property THROUGH the module's own interface (round-trip + mechanism-agnostic plaintext
 * absence) instead of reaching around it with a DB engine. Returns the corrected command, or
 * null. The caller re-checks interfaceCoherence and only adopts a clean result.
 */
export async function repairInterfaceGate(
  llm: LlmClient,
  model: string,
  args: { brief: string; contract: string; gate: string; issue: string },
): Promise<string | null> {
  const system =
    "You fix ONE shell gate (exit 0 = pass) that verifies a data-producing module by reaching AROUND its interface with a foreign DB tool (sqlite3/psql/redis-cli on the raw store). That tool DICTATES the storage mechanism and traps the worker on driver/native-build/DB-path errors. Rewrite it to verify the SAME property THROUGH THE MODULE'S OWN API, in ONE shell command (chain with &&): (1) drive the build's interface to create/seed the user and STORE a known key; (2) read it back via the module's getter and assert it ROUND-TRIPS (equals what was stored); (3) assert the key is NOT stored in plaintext by checking the plaintext bytes are ABSENT from the persisted store with a mechanism-AGNOSTIC reader — `! grep -rqF '<the-key>' <data-dir>/` — NOT a DB engine. Do NOT shell out to sqlite3/psql/mongo/redis or any DB CLI. Do NOT install a driver. NEVER weaken to a vacuous pass. Output ONLY the corrected shell command, no prose, no code fences.";
  const user = `SHARED CONTRACT:\n${args.contract}\n\nNODE BRIEF:\n${args.brief}\n\nINTERFACE-INCOHERENT GATE:\n${args.gate}\n\nWHY IT TRAPS THE WORKER:\n- ${args.issue}`;
  try {
    const res = await llm.complete({ model, system, user, json: false, maxTokens: 900 });
    const cmd = res.text
      .trim()
      .replace(/^```[\w-]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

/** localhost/127.0.0.1 ports a gate HITS (curls), excluding external-service base URLs. */
export function gateLocalPorts(gate: string): number[] {
  const out = new Set<number>();
  const re = /(\w*URL\s*=\s*['"]?)?https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})\b/g;
  for (let m = re.exec(gate); m; m = re.exec(gate)) {
    if (!m[1]) out.add(Number(m[2]));
  }
  return [...out];
}

/** Does this node build a runnable server (a server-entry file in its blast radius)? */
export function buildsServer(blastRadius: string[]): boolean {
  return /\b(server|app|main|index|api|wsgi|asgi)\.(js|mjs|cjs|ts|py)\b/i.test(blastRadius.join(" "));
}

export interface PortCheckNode {
  id: string;
  deps: string[];
  blastRadius: string[];
  gateRun: string;
}

/** Transitive dependency ids of a node. */
function depClosure(id: string, all: PortCheckNode[]): Set<string> {
  const byId = new Map(all.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.deps ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (seen.has(d)) continue;
    seen.add(d);
    stack.push(...(byId.get(d)?.deps ?? []));
  }
  return seen;
}

/**
 * PORT COHERENCE: a node whose gate boots a server (serve-gate-wrapped on a port) but that
 * builds NO server itself can't boot it — at runtime serve-gate fails (exit 3) and the build
 * halts (the bot-module wall: its gate curls :3000, the web app another node builds). Returns
 * a deterministic repair (depend on the node that builds that server's files, so they exist
 * when this gate runs and serve-gate can boot them) when acyclic, a warning when not, or null
 * when the node is coherent (builds its own server, or already depends on the provider).
 */
export function portCoherence(
  node: PortCheckNode,
  all: PortCheckNode[],
): { kind: "add-dep"; dep: string } | { kind: "warn"; issue: string } | null {
  const m = node.gateRun.match(/serve-gate\.mjs --port (\d+)/);
  if (!m || buildsServer(node.blastRadius)) return null; // not a serve-gate node, or builds its own
  const port = Number(m[1]);
  const provider = all.find((n) => n.id !== node.id && buildsServer(n.blastRadius) && gateLocalPorts(n.gateRun).includes(port));
  if (!provider) {
    return { kind: "warn", issue: `gate boots a server on :${port} but this node builds no server and no node serves :${port}` };
  }
  if (depClosure(node.id, all).has(provider.id)) return null; // provider's files already present at runtime
  if (depClosure(provider.id, all).has(node.id)) {
    return { kind: "warn", issue: `gate needs :${port} from "${provider.id}", but depending on it would create a cycle` };
  }
  return { kind: "add-dep", dep: provider.id };
}

/** Local SOURCE files a gate runs/requires (scripts + modules), excluding harness scaffolds. */
export function extractGateFiles(gate: string): string[] {
  const out = new Set<string>();
  const add = (f?: string): void => {
    if (!f) return;
    const x = f.replace(/^\.\//, "");
    if (!x.startsWith(".squire/")) out.add(x);
  };
  for (const m of gate.matchAll(/\.\/([\w./-]+\.(?:sh|js|mjs|cjs|ts|py))\b/g)) add(m[1]);
  for (const m of gate.matchAll(/\b(?:node|python3?|bash|sh)\s+([\w./-]+\.(?:sh|js|mjs|cjs|ts|py))\b/g)) add(m[1]);
  for (const m of gate.matchAll(/require\((['"])\.\/([\w./-]+)\1\)/g)) {
    const name = m[2];
    if (name) add(name.includes(".") ? name : `${name}.js`);
  }
  return [...out];
}

/**
 * TOOLING COHERENCE: a node can't pass a gate that runs a file it doesn't build (bot-module's
 * `./run-bot.sh`, which lives in another node) or that needs a dependency it can't install (the
 * crypto-storage SQLite trap — its gate writes a DB from Node but its blast_radius has no
 * package.json to install a driver). Returns the files to ADD to the node's blast_radius so it
 * is EQUIPPED to build/install what its own gate requires (widening a radius is safe — it
 * permits, never forces). Empty array = already equipped.
 */
export function toolingCoherence(node: PortCheckNode, all: PortCheckNode[]): string[] {
  const byId = new Map(all.map((n) => [n.id, n]));
  const inScope = new Set<string>(node.blastRadius);
  for (const dep of depClosure(node.id, all)) for (const f of byId.get(dep)?.blastRadius ?? []) inScope.add(f);
  const basenames = new Set([...inScope].map((f) => f.split("/").pop()!));
  const add = new Set<string>();

  // 1. a source file the gate runs that no node in scope builds → equip this node to build it
  const referenced = extractGateFiles(node.gateRun);
  for (const f of referenced) {
    if (!inScope.has(f) && !basenames.has(f.split("/").pop()!)) add.add(f);
  }
  // 2. runs its own code but has no manifest to install a dependency it might need
  const runsOwnCode = referenced.length > 0;
  const buildsJs = node.blastRadius.some((f) => /\.(js|mjs|cjs|ts)$/.test(f));
  const buildsPy = node.blastRadius.some((f) => /\.py$/.test(f));
  const hasPkg = [...inScope].some((f) => /(^|\/)package\.json$/.test(f));
  const hasReq = [...inScope].some((f) => /(^|\/)requirements\.txt$/.test(f));
  if (runsOwnCode && buildsJs && !hasPkg) add.add("package.json");
  if (runsOwnCode && buildsPy && !hasReq) add.add("requirements.txt");
  return [...add];
}

/**
 * Repair an unsatisfiable gate via the PLANNER (knight): rewrite it to seed its
 * preconditions FIRST, through the build's own interface, then make the SAME assertion.
 * Returns the corrected command, or null if the model couldn't produce one. The caller
 * re-proofreads the result and only adopts it if it now passes (and isn't vacuous).
 */
export async function repairUnsatisfiableGate(
  llm: LlmClient,
  model: string,
  args: { brief: string; contract: string; gate: string; issues: string[] },
): Promise<string | null> {
  const system =
    "You fix ONE shell gate (exit 0 = pass) that is UNSATISFIABLE because it READS state it never SEEDS. Rewrite it so it SEEDS its preconditions FIRST through the BUILD'S OWN interface — register the user via the built endpoint THEN log in; store the record via the built API or the storage module THEN read it; INSERT the row THEN SELECT it — and then makes the SAME real assertion. Keep it a SINGLE shell command (use && to chain). NEVER weaken it to a vacuous pass (no `true`, no bare `exit 0`, no `| head` swallow), and NEVER `echo` a throwaway server/script and test THAT — drive the artifact the build produces. Output ONLY the corrected shell command, no prose, no code fences.";
  const user = `SHARED CONTRACT:\n${args.contract}\n\nNODE BRIEF:\n${args.brief}\n\nUNSATISFIABLE GATE:\n${args.gate}\n\nWHY IT CAN'T PASS:\n- ${args.issues.join("\n- ")}`;
  try {
    const res = await llm.complete({ model, system, user, json: false, maxTokens: 900 });
    const cmd = res.text
      .trim()
      .replace(/^```[\w-]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    return cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}
