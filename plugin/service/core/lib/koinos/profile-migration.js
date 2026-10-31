"use strict";
// Reviewed transfer of chain databases only. Wallets, producer keys, config and
// arbitrary Docker projects are deliberately outside this migration boundary.
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto"), os = require("node:os");
const { NETWORKS } = require("./constants");
const { canonicalPath, claimProject } = require("./node-control");
const { canonicalGenesis, MAX_BYTES: MAX_GENESIS_BYTES } = require("./genesis-json");
const DATA_DIRS = ["chain", "block_store", "mempool", "transaction_store", "account_history", "contract_meta_store"];
const SERVICE_IMAGES = Object.freeze({
  amqp: "rabbitmq", chain: "koinos/koinos-chain", mempool: "koinos/koinos-mempool",
  block_store: "koinos/koinos-block-store", p2p: "koinos/koinos-p2p",
  block_producer: "koinos/koinos-block-producer", jsonrpc: "koinos/koinos-jsonrpc",
  grpc: "koinos/koinos-grpc", transaction_store: "koinos/koinos-transaction-store",
  contract_meta_store: "koinos/koinos-contract-meta-store", account_history: "koinos/koinos-account-history",
  rest: "koinos/koinos-rest",
});
function recognizedImage(service, image) {
  if (typeof service !== "string" || !Object.hasOwn(SERVICE_IMAGES, service) || typeof image !== "string") return false;
  // Match the official repository for this exact Compose role. A broad letter-
  // only image-name expression rejected our own digit-bearing p2p image.
  const match = /^(?:docker\.io\/)?([^:@]+)(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-fA-F0-9]{64})?$/.exec(image);
  if (!match) return false;
  const repository = service === "amqp" && match[1] === "library/rabbitmq" ? "rabbitmq" : match[1];
  return repository === SERVICE_IMAGES[service];
}
const MARKER = ".kai-restore-incomplete.json", CHUNK = 1024 * 1024, MAX_FILES = 2000000;
const absent = e => e?.code === "ENOENT";
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const key = value => canonicalPath(path.resolve(value));
const identity = s => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const privateFile = s => s.isFile() && !s.isSymbolicLink() && s.nlink === 1;
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (absent(error)) return null; throw error; } }
function overlap(a, b) { a = key(a); b = key(b); return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); }
function checkedPath(file, { missing = false } = {}) {
  const absolute = path.resolve(file), root = path.parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); const entry = stat(cursor);
    if (!entry) { if (missing) continue; throw Error("Node migration path is missing: " + cursor); }
    const systemAlias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(cursor);
    if (entry.isSymbolicLink() && !systemAlias) throw Error("Linked Node storage is not supported; original files were preserved.");
    if (cursor !== absolute && !entry.isDirectory() && !systemAlias) throw Error("Node migration parent is not a directory.");
  }
  return fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
}
function hostPath(value) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) throw Error("Docker did not provide a usable local Node path.");
  const normalized = process.platform === "win32" ? canonicalPath(value).replace(/\//g, path.sep) : value;
  if (!path.isAbsolute(normalized)) throw Error("Docker Node storage is not on this computer.");
  return checkedPath(normalized);
}
function syncDir(directory) {
  let fd;
  try { fd = fs.openSync(directory, "r"); fs.fsyncSync(fd); }
  catch (error) { if (!(process.platform === "win32" && ["EPERM", "EISDIR", "EINVAL", "EACCES"].includes(error.code))) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function atomicJson(file, value) {
  checkedPath(file, { missing: true }); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try { const fd = fs.openSync(temporary, "wx", 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temporary, file); syncDir(path.dirname(file)); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function readJson(file, max = 16 * 1024 * 1024) {
  const entry = stat(file); if (!entry) return null;
  checkedPath(file); if (!privateFile(entry) || entry.size > max) throw Error("Node migration record is unsafe or too large; it was preserved.");
  let value; try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw Error("Node migration record is unreadable; it was preserved."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Node migration record is invalid; it was preserved.");
  return value;
}
function genesisValue(file, label) {
  const fail = message => Error(`${label} ${message} Its containers and chain data were preserved.`);
  const safePath = () => {
    try { checkedPath(file); }
    catch (error) { throw fail(error.code ? "could not be read. Check its file permissions and try again." : "has a missing, linked or unsafe path."); }
  };
  safePath(); let fd, data;
  try {
    const before = fs.lstatSync(file);
    if (!privateFile(before)) throw fail("is linked or is not a regular file.");
    if (before.size > MAX_GENESIS_BYTES) throw fail("exceeds the 8 MiB supported size limit.");
    const unchanged = entry => privateFile(entry) && same(identity(before), identity(entry)) && before.ctimeMs === entry.ctimeMs;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!unchanged(fs.fstatSync(fd))) throw fail("changed while being opened. Keep the old application closed and try again.");
    // Bound the read even if another process replaces or grows the file.
    data = Buffer.allocUnsafe(before.size + 1); let read = 0;
    while (read < data.length) { const count = fs.readSync(fd, data, read, data.length - read, read); if (!count) break; read += count; }
    safePath();
    if (read !== before.size || !unchanged(fs.fstatSync(fd)) || !unchanged(fs.lstatSync(file))) throw fail("changed while being read. Keep the old application closed and try again.");
    data = data.subarray(0, read);
  } catch (error) {
    if (error.code) throw fail("could not be read. Check its file permissions and try again.");
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  try { return canonicalGenesis(data); }
  catch (error) { throw fail("could not be validated: " + error.message); }
}
function relativeFile(root, relative) {
  if (typeof relative !== "string" || relative.length > 8192 || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === ".." || /[:\0\r\n]/.test(part)) || !DATA_DIRS.includes(relative.split("/")[0])) throw Error("Invalid chain migration file path.");
  return path.join(root, ...relative.split("/"));
}
async function inventory(basedir, { requireChain = true } = {}) {
  checkedPath(basedir); const items = [], directories = []; let bytes = 0;
  async function walk(directory, relative) {
    const st = fs.lstatSync(directory); if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Chain data contains a linked or invalid directory.");
    directories.push(relative);
    const handle = await fsp.opendir(directory);
    for await (const entry of handle) {
      const file = path.join(directory, entry.name), rel = relative + "/" + entry.name, value = fs.lstatSync(file);
      relativeFile(basedir, rel);
      if (value.isDirectory() && !value.isSymbolicLink()) await walk(file, rel);
      else if (privateFile(value)) { if (items.length >= MAX_FILES) throw Error("Chain database contains too many files to migrate safely."); bytes += value.size; items.push({ relative: rel, ...identity(value) }); }
      else throw Error("Chain data contains a linked or special file; original data was preserved.");
    }
  }
  for (const name of DATA_DIRS) if (stat(path.join(basedir, name))) await walk(path.join(basedir, name), name);
  if (requireChain && (!directories.includes("chain") || !directories.includes("block_store") || !items.length)) throw Error("The old node does not contain both chain and block-store data.");
  return { items, directories, bytes, files: items.length };
}
async function digest(file, { signal, expected, allowLinked = false, onBytes = () => {} } = {}) {
  checkedPath(file); const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || (!allowLinked && before.nlink !== 1) || (allowLinked && before.nlink > 2) || (expected && !same(expected, identity(before)))) throw Error("Chain file changed or is linked; original data was preserved.");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)), hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(CHUNK); let position = 0;
  try {
    if (!same(identity(before), identity(await handle.stat()))) throw Error("Chain file changed while opening.");
    for (;;) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; onBytes(bytesRead); }
    if (!same(identity(before), identity(await handle.stat())) || !same(identity(before), identity(fs.lstatSync(file)))) throw Error("Chain data changed during migration. Keep the old application closed.");
    return { sha256: hash.digest("hex"), bytes: position, identity: identity(before) };
  } finally { await handle.close(); }
}
const MASTER_PROFILE = "Master Koinos AI Node";
// A recognized Docker image alone is not enough: this plugin may migrate the
// Master application's chain, never Alpha/Core or the ordinary Node plugin.
function masterProfileFromRoot(root, network) {
  if (typeof root !== "string" || !Object.hasOwn(NETWORKS, network)) return null;
  const normalized = canonicalPath(root), parts = normalized.split("/");
  const fold = /^[a-z]:\//i.test(normalized) ? value => value.toLowerCase() : value => value;
  const suffixes = [[MASTER_PROFILE, "core", "koinos-node", "node", network], [".master-koinos-ai", "koinos-node", "node", network]];
  for (const suffix of suffixes) {
    if (parts.length >= suffix.length && suffix.every((part, i) => fold(parts[parts.length - suffix.length + i]) === fold(part))) {
      return { kind: suffix.length === 5 ? "desktop" : "headless", root: parts.slice(0, parts.length - suffix.length + 1).join("/") };
    }
  }
  return null;
}
function knownMasterProfiles() {
  const home = os.homedir(), appData = process.platform === "win32" ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
    : process.platform === "darwin" ? path.join(home, "Library", "Application Support") : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [path.join(appData, MASTER_PROFILE), path.join(home, ".master-koinos-ai")];
}
function identifyMasterSource(root, network, profiles = knownMasterProfiles()) {
  const standard = masterProfileFromRoot(root, network);
  if (standard) return { app: MASTER_PROFILE, profile: standard.root, storage: "default" };
  for (const profile of profiles) {
    if (typeof profile !== "string" || !path.isAbsolute(profile)) continue;
    const name = path.basename(profile), desktop = process.platform === "win32" ? name.toLowerCase() === MASTER_PROFILE.toLowerCase() : name === MASTER_PROFILE;
    if (!desktop && name !== ".master-koinos-ai") continue;
    const file = path.join(profile, ...(desktop ? ["core"] : []), "koinos-node", "settings.json");
    const saved = readJson(file, 1024 * 1024);
    const configured = saved?.node?.dataDir;
    if (typeof configured === "string" && path.isAbsolute(configured) && !/[\0\r\n]/.test(configured) && key(path.join(configured, network)) === key(root)) {
      return { app: MASTER_PROFILE, profile: path.resolve(profile), storage: "configured" };
    }
  }
  throw Error("Only a verified Master Koinos AI Node chain can be migrated into this plugin. Alpha, Core and other Node plugins were left untouched.");
}
const INSPECT = '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"root":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"image":{{json .Config.Image}},"running":{{json .State.Running}},"paused":{{json .State.Paused}},"mounts":{{json .Mounts}}}';
function createProfileMigration({ manager, journalRoot = path.join(manager.dataRoot, ".profile-migrations"), onComplete = () => {} }, dependencies = {}) {
  const exec = dependencies.exec || manager._exec.bind(manager), claim = dependencies.claim || claimProject;
  let reviewed = null, state = { phase: "idle", progress: { completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0, detail: "" }, resumable: false }, pending = null, controller = null;
  const stateCopy = () => structuredClone(state);
  const recordPath = network => path.join(journalRoot, network + ".json");
  const manifestPath = network => path.join(journalRoot, network + ".files.json");
  function target(network) { if (!Object.hasOwn(NETWORKS, network)) throw Error("Choose a known Node network."); return manager.dirs(network); }
  function journal(network) {
    const record = readJson(recordPath(network)); if (!record) return null;
    if (record.schema !== 1 || record.network !== network || !/^[a-f0-9-]{36}$/.test(record.id) || !record.source || !record.destination || (record.phase !== "complete" && (key(record.destination.basedir) !== key(target(network).basedir) || key(record.destination.root) !== key(target(network).root))) || !path.isAbsolute(record.source.root) || !path.isAbsolute(record.source.basedir) || overlap(record.source.basedir, record.destination.basedir) || !Number.isSafeInteger(record.completedFiles) || record.completedFiles < 0) throw Error("Saved Node migration needs recovery; no files were changed.");
    if (record.source.app !== MASTER_PROFILE || typeof record.source.profile !== "string" || !["default", "configured"].includes(record.source.storage) || key(record.source.basedir) !== key(path.join(record.source.root, "basedir"))) throw Error("Saved migration is not a reviewed Master Koinos AI Node transfer; no files were changed.");
    if (record.phase !== "complete") {
      const source = identifyMasterSource(record.source.root, network, dependencies.masterProfiles);
      if (key(source.profile) !== key(record.source.profile) || source.storage !== record.source.storage) throw Error("The saved Master Node source changed; no files were changed.");
      checkedPath(record.source.root); checkedPath(record.source.basedir);
    }
    checkedPath(record.destination.root, { missing: true }); checkedPath(record.destination.basedir, { missing: true });
    if (record.phase === "complete" && stat(path.join(record.destination.basedir, MARKER))) {
      assertMarker(path.join(record.destination.basedir, MARKER), record);
      fs.unlinkSync(path.join(record.destination.basedir, MARKER)); syncDir(record.destination.basedir);
    }
    return record;
  }
  async function dockerRows() {
    const context = await exec("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], { timeout: 15000 });
    let endpoint; try { endpoint = JSON.parse(context.stdout.trim()); } catch { /* refuse unknown context */ }
    const configured = process.env.DOCKER_HOST || endpoint;
    if (!context.ok || typeof endpoint !== "string" || !/^(unix|npipe):\/\//.test(endpoint) || !/^(unix|npipe):\/\//.test(configured)) throw Error("Node migration requires a local Docker Desktop or Docker Engine connection.");
    const list = await exec("docker", ["ps", "--all", "--format", "{{.ID}}"], { timeout: 15000 });
    if (!list.ok) throw Error("Docker could not list its containers. No chain data was changed.");
    const ids = list.stdout.trim().split(/\s+/).filter(Boolean); if (!ids.length) return [];
    if (ids.length > 2048 || ids.some(id => !/^[a-f0-9]{12,64}$/i.test(id))) throw Error("Docker returned an invalid container inventory.");
    const response = await exec("docker", ["inspect", "--format", INSPECT, ...ids], { timeout: 30000 });
    let rows; try { rows = response.stdout.trim().split("\n").map(line => JSON.parse(line)); } catch { throw Error("Docker container ownership could not be verified."); }
    if (!response.ok || rows.length !== ids.length || rows.some(row => !/^[a-f0-9]{64}$/i.test(row.id) || !Array.isArray(row.mounts))) throw Error("Docker container ownership could not be verified.");
    return rows;
  }
  function writers(rows, source, destination, allowed = new Set()) {
    for (const row of rows) for (const mount of row.mounts) {
      if (mount.RW === false || typeof mount.Source !== "string" || !mount.Source) continue;
      const sourcePath = process.platform === "win32" ? canonicalPath(mount.Source).replace(/\//g, path.sep) : mount.Source;
      if (!path.isAbsolute(sourcePath)) continue;
      if ((overlap(sourcePath, source) || overlap(sourcePath, destination)) && !allowed.has(row.id)) throw Error("Another Docker container can write this chain data. Stop and remove that container's access before migrating; it was left untouched.");
    }
  }
  async function candidate(network) {
    const rows = await dockerRows(), project = NETWORKS[network].composeProject, owned = rows.filter(row => row.project === project);
    if (!owned.length) throw Error("No Master Koinos AI Node was found for this network.");
    if (owned.some(row => typeof row.root !== "string" || !row.root || !recognizedImage(row.service, row.image))) throw Error("This Docker project is not a recognized Koinos AI node. Its containers were left untouched.");
    const root = hostPath(owned[0].root), destination = target(network);
    if (owned.some(row => key(hostPath(row.root)) !== key(root))) throw Error("Node containers belong to different profiles; no containers were changed.");
    if (key(root) === key(destination.root)) throw Error("This node already belongs to this plugin.");
    const masterSource = identifyMasterSource(root, network, dependencies.masterProfiles);
    const chain = owned.find(row => row.service === "chain"), block = owned.find(row => row.service === "block_store");
    if (!chain || !block) throw Error("Both the old chain and block-store containers are needed to identify their data safely.");
    const mounts = [chain, block].map(row => row.mounts.find(mount => mount.Type === "bind" && mount.Destination === "/koinos" && mount.RW !== false));
    if (mounts.some(mount => !mount)) throw Error("The old node does not use a supported local chain folder.");
    const basedir = hostPath(mounts[0].Source);
    if (key(hostPath(mounts[1].Source)) !== key(basedir)) throw Error("Chain and block-store containers use different data folders.");
    if (key(basedir) !== key(path.join(root, "basedir"))) throw Error("The chain mount does not belong to the verified Master Node folder. Its containers and data were left untouched.");
    if (overlap(basedir, destination.basedir) || overlap(root, destination.root)) throw Error("Old and new node folders overlap; select separate storage before migration.");
    checkedPath(destination.root, { missing: true }); checkedPath(destination.basedir, { missing: true });
    const oldGenesis = path.join(root, "config", "genesis_data.json"), currentGenesis = path.join(manager.templateRoot, NETWORKS[network].templateDir, "genesis_data.json");
    if (genesisValue(oldGenesis, "The old node's genesis file") !== genesisValue(currentGenesis, "The plugin's genesis template")) throw Error(`The old node's genesis does not match the selected ${NETWORKS[network].label} network. Its containers and chain data were preserved.`);
    for (const name of DATA_DIRS) if (stat(path.join(destination.basedir, name))) throw Error("The plugin already has chain data. Existing destination data was preserved.");
    if (stat(path.join(basedir, MARKER)) || stat(path.join(destination.basedir, MARKER))) throw Error("A chain restore or migration is incomplete. Resume its recorded operation first.");
    writers(rows, basedir, destination.basedir, new Set(owned.map(row => row.id)));
    const info = await inventory(basedir);
    let ancestor = path.resolve(destination.root); while (!stat(ancestor)) ancestor = path.dirname(ancestor);
    const mode = fs.statSync(basedir).dev === fs.statSync(ancestor).dev ? "move" : "copy-delete";
    return { available: true, previewId: crypto.randomUUID(), network, source: { root, basedir, ...masterSource }, destination: { root: path.resolve(destination.root), basedir: path.resolve(destination.basedir) }, bytes: info.bytes, files: info.files, mode, resumable: false,
      detail: "Close Master Koinos AI Node, including its tray process. Migration stops and removes only its verified Node containers, then transfers chain data. Keep the old app closed after migration.",
      walletNotice: "Wallets, private producer keys, KOIN and VHP are not migrated. If you created a new Node wallet, transfer funds manually. Mining stays off.",
      containers: owned.map(row => ({ id: row.id, service: row.service, root: row.root, image: row.image })).sort((a, b) => a.id.localeCompare(b.id)) };
  }
  function publicPreview(value) { const { containers, ...rest } = value; return structuredClone(rest); }
  function marker(record) { return { schema: 1, kind: "kai-profile-chain-migration", id: record.id, network: record.network, destination: record.destination.basedir, source: record.source.basedir }; }
  function assertMarker(file, record) { const data = readJson(file, 8192); if (!data || data.id !== record.id || data.kind !== "kai-profile-chain-migration" || data.destination !== record.destination.basedir || data.source !== record.source.basedir) throw Error("Node migration marker changed; data was preserved for recovery."); }
  function progress(record, detail) { state.progress = { completedBytes: record.completedBytes, totalBytes: record.bytes, completedFiles: record.completedFiles, totalFiles: record.files, detail }; }
  function save(record) { atomicJson(recordPath(record.network), record); }
  async function preview(network) {
    if (pending) return state.preview;
    const record = journal(network);
    if (record && record.phase !== "complete") {
      reviewed = { ...record.preview, available: true, previewId: record.id, resumable: true };
      state = { phase: ["running", "preparing"].includes(record.phase) ? "cancelled" : record.phase, preview: publicPreview(reviewed), resumable: true, progress: { completedBytes: record.completedBytes, totalBytes: record.bytes, completedFiles: record.completedFiles, totalFiles: record.files, detail: "Resume the saved transfer before starting either node." }, ...(record.error ? { error: record.error } : {}) };
      return publicPreview(reviewed);
    }
    reviewed = await candidate(network); return publicPreview(reviewed);
  }
  function status(network) {
    if (pending || state.preview?.network === network) return stateCopy();
    const record = journal(network);
    if (!record) state = { phase: "idle", progress: { completedBytes: 0, totalBytes: 0, completedFiles: 0, totalFiles: 0, detail: "" }, resumable: false };
    if (record) { state = { phase: ["running", "preparing"].includes(record.phase) ? "cancelled" : record.phase, preview: publicPreview(record.preview), resumable: record.phase !== "complete", progress: { completedBytes: record.completedBytes, totalBytes: record.bytes, completedFiles: record.completedFiles, totalFiles: record.files, detail: record.phase === "complete" ? "Chain migration complete. Start a sync-only node when ready." : "Resume the saved transfer before starting either node." }, result: record.result, error: record.error }; }
    return stateCopy();
  }
  async function ensureNoWriters(record) { writers(await dockerRows(), record.source.basedir, record.destination.basedir); }
  function ensureParents(file, root) {
    checkedPath(root); const relative = path.relative(root, path.dirname(file)); let cursor = root;
    for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); try { fs.mkdirSync(cursor, { mode: 0o700 }); syncDir(path.dirname(cursor)); } catch (error) { if (error.code !== "EEXIST") throw error; } checkedPath(cursor); if (!fs.statSync(cursor).isDirectory()) throw Error("Chain destination is not a directory."); }
  }
  async function transfer(record, item) {
    controller.signal.throwIfAborted();
    const source = relativeFile(record.source.basedir, item.relative), destination = relativeFile(record.destination.basedir, item.relative);
    checkedPath(source, { missing: true }); checkedPath(destination, { missing: true }); ensureParents(destination, record.destination.basedir);
    let saved = record.current;
    if (!saved) {
      const value = await digest(source, { signal: controller.signal, expected: item });
      saved = record.current = { relative: item.relative, sha256: value.sha256, bytes: value.bytes, source: value.identity, mode: record.preview.mode };
      save(record);
    }
    if (saved.relative !== item.relative || !hex(saved.sha256) || saved.bytes !== item.size || !same(saved.source, item)) throw Error("Saved chain transfer record does not match its manifest.");
    let sourceStat = stat(source), destinationStat = stat(destination), verifiedIdentity;
    if (destinationStat) {
      const temporary = path.join(path.dirname(destination), ".kai-chain-" + record.id + ".tmp"), temporaryStat = stat(temporary);
      if (temporaryStat && temporaryStat.dev === destinationStat.dev && temporaryStat.ino === destinationStat.ino && temporaryStat.nlink === 2 && destinationStat.nlink === 2) {
        const checked = await digest(destination, { signal: controller.signal, allowLinked: true });
        if (checked.sha256 !== saved.sha256 || checked.bytes !== saved.bytes) throw Error("The interrupted chain copy differs; its files were preserved.");
        fs.unlinkSync(temporary); syncDir(path.dirname(destination)); destinationStat = fs.lstatSync(destination);
      }
      const shared = sourceStat && sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino;
      const checked = await digest(destination, { signal: controller.signal, allowLinked: shared });
      if (checked.sha256 !== saved.sha256 || checked.bytes !== saved.bytes) throw Error("A destination chain file differs; both copies were preserved.");
      verifiedIdentity = checked.identity;
    } else {
      if (!sourceStat || !same(saved.source, identity(sourceStat))) throw Error("A source chain file changed or is missing; recovery is required.");
      const temporary = path.join(path.dirname(destination), ".kai-chain-" + record.id + ".tmp");
      const stale = stat(temporary); if (stale) { if (!privateFile(stale)) throw Error("Unsafe temporary chain copy was preserved."); fs.unlinkSync(temporary); syncDir(path.dirname(temporary)); }
      let linked = false;
      try { await fsp.link(source, destination); linked = true; }
      catch (error) { if (error.code !== "EXDEV") throw error; }
      if (linked) {
        const handle = await fsp.open(destination, "r+"); try { await handle.sync(); } finally { await handle.close(); }
        const checked = await digest(destination, { signal: controller.signal, expected: saved.source, allowLinked: true });
        if (checked.sha256 !== saved.sha256) throw Error("The source chain changed while moving. Both names were retained.");
        verifiedIdentity = checked.identity;
        syncDir(path.dirname(destination));
      } else {
        const free = fs.statfsSync(path.dirname(destination)); if (Number(free.bavail) * Number(free.bsize) < saved.bytes) throw Error("Not enough free space for the next chain file. Free space and resume migration.");
        const input = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); let output;
        try {
          if (!same(saved.source, identity(await input.stat()))) throw Error("Chain source changed while opening.");
          output = await fsp.open(temporary, "wx", 0o600); const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(CHUNK); let position = 0;
          for (;;) {
            controller.signal.throwIfAborted(); const { bytesRead } = await input.read(buffer, 0, buffer.length, position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead));
            let offset = 0; while (offset < bytesRead) { const written = await output.write(buffer, offset, bytesRead - offset, position + offset); if (!written.bytesWritten) throw Error("Chain copy stopped."); offset += written.bytesWritten; }
            position += bytesRead; state.progress.completedBytes = record.completedBytes + position;
          }
          if (position !== saved.bytes || hash.digest("hex") !== saved.sha256 || !same(saved.source, identity(await input.stat())) || !same(saved.source, identity(fs.lstatSync(source)))) throw Error("Source chain changed during copying. The original file was retained.");
          await output.sync();
        } finally { await input.close(); await output?.close(); }
        const checked = await digest(temporary, { signal: controller.signal }); if (checked.sha256 !== saved.sha256 || checked.bytes !== saved.bytes) throw Error("Copied chain data could not be verified; original file was retained.");
        verifiedIdentity = checked.identity;
        fs.linkSync(temporary, destination); syncDir(path.dirname(destination)); fs.unlinkSync(temporary); syncDir(path.dirname(destination));
      }
    }
    controller.signal.throwIfAborted();
    const verifiedDestinationStat = fs.lstatSync(destination), verifiedDestination = { ...identity(verifiedDestinationStat), ctimeMs: verifiedDestinationStat.ctimeMs };
    if (!verifiedIdentity || !same(verifiedIdentity, identity(verifiedDestinationStat))) throw Error("The hashed destination changed before cleanup. The source chain file was preserved.");
    await ensureNoWriters(record);
    assertMarker(path.join(record.source.basedir, MARKER), record); assertMarker(path.join(record.destination.basedir, MARKER), record);
    checkedPath(source, { missing: true }); checkedPath(destination);
    sourceStat = stat(source); destinationStat = fs.lstatSync(destination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || !same(verifiedDestination, identity(destinationStat)) || destinationStat.ctimeMs !== verifiedDestination.ctimeMs) throw Error("The verified destination changed before cleanup. The source chain file was preserved.");
    if (sourceStat) {
      if (!same(saved.source, identity(sourceStat))) throw Error("Source chain changed before cleanup; original file was retained.");
      // No application can interleave here; the shared project lease and old
      // restore marker keep its supervisor out for this complete operation.
      fs.unlinkSync(source); syncDir(path.dirname(source));
    }
    record.completedFiles++; record.completedBytes += saved.bytes; record.current = null; save(record);
  }
  async function run(record, resume) {
    let release;
    try {
      manager.assertOperation("migration");
      release = claim(NETWORKS[record.network].composeProject, { lockRoot: manager.lockRoot });
      manager._desiredRunning = false; manager._stopWatchdog(); manager._saveIntent(record.network, false);
      if (!resume) {
        const fresh = await candidate(record.network);
        if (JSON.stringify(fresh.containers) !== JSON.stringify(record.preview.containers) || key(fresh.source.root) !== key(record.source.root) || key(fresh.source.basedir) !== key(record.source.basedir)) throw Error("The old Node changed since review. Open migration again.");
        record.phase = "preparing"; save(record);
        const ids = fresh.containers.map(row => row.id);
        const restart = await exec("docker", ["update", "--restart=no", ...ids], { timeout: 30000 }); if (!restart.ok) throw Error("Could not disable the old containers' restart policy. No chain data was moved.");
        const stopped = await exec("docker", ["stop", "--time", "120", ...ids], { timeout: 180000 }); if (!stopped.ok) throw Error("The old node did not stop cleanly. No chain data was moved.");
        const rows = await dockerRows(), owned = rows.filter(row => ids.includes(row.id));
        if (owned.length !== ids.length || owned.some(row => row.running || row.paused) || rows.some(row => row.project === NETWORKS[record.network].composeProject && !ids.includes(row.id))) throw Error("The old node is still running or its containers changed. No chain data was moved.");
        writers(rows, record.source.basedir, record.destination.basedir, new Set(ids));
        const removed = await exec("docker", ["rm", ...ids], { timeout: 30000 }); if (!removed.ok) throw Error("Could not retire the old containers. No chain data was moved.");
        await ensureNoWriters(record); controller.signal.throwIfAborted();
        const files = await inventory(record.source.basedir);
        record.bytes = files.bytes; record.files = files.files;
        fs.mkdirSync(record.destination.basedir, { recursive: true, mode: 0o700 }); checkedPath(record.destination.basedir);
        atomicJson(manifestPath(record.network), { schema: 1, id: record.id, directories: files.directories, items: files.items });
        record.phase = "running"; record.prepared = true; save(record);
        atomicJson(path.join(record.source.basedir, MARKER), marker(record)); atomicJson(path.join(record.destination.basedir, MARKER), marker(record));
      } else {
        if (!record.prepared) {
          for (const name of DATA_DIRS) if (stat(path.join(record.destination.basedir, name))) throw Error("The plugin destination gained chain data after review. It was preserved; inspect that data before resuming.");
          const rows = await dockerRows(), ids = record.preview.containers.map(row => row.id), present = rows.filter(row => ids.includes(row.id));
          if (rows.some(row => row.project === NETWORKS[record.network].composeProject && !ids.includes(row.id))) throw Error("The old node was recreated after migration started. Keep it closed and inspect its containers before resuming.");
          for (const row of present) { const expected = record.preview.containers.find(item => item.id === row.id); if (!expected || row.project !== NETWORKS[record.network].composeProject || row.root !== expected.root || row.service !== expected.service || row.image !== expected.image) throw Error("Old node container identity changed."); }
          writers(rows, record.source.basedir, record.destination.basedir, new Set(ids));
          if (present.length) {
            const retained = present.map(row => row.id);
            const restart = await exec("docker", ["update", "--restart=no", ...retained], { timeout: 30000 }); if (!restart.ok) throw Error("Could not disable the old node restart policy.");
            const stopped = await exec("docker", ["stop", "--time", "120", ...retained], { timeout: 180000 }); if (!stopped.ok) throw Error("The old node did not stop cleanly.");
            const stoppedRows = await dockerRows(); if (stoppedRows.some(row => retained.includes(row.id) && (row.running || row.paused))) throw Error("The old node is still running.");
            const removed = await exec("docker", ["rm", ...retained], { timeout: 30000 }); if (!removed.ok) throw Error("Could not retire the old node containers.");
          }
          await ensureNoWriters(record); controller.signal.throwIfAborted();
          const files = await inventory(record.source.basedir); record.bytes = files.bytes; record.files = files.files;
          fs.mkdirSync(record.destination.basedir, { recursive: true, mode: 0o700 }); checkedPath(record.destination.basedir);
          atomicJson(manifestPath(record.network), { schema: 1, id: record.id, directories: files.directories, items: files.items });
          record.prepared = true; save(record);
        }
        // Recover a crash between the durable manifest and marker publication.
        for (const base of [record.source.basedir, record.destination.basedir]) {
          const file = path.join(base, MARKER); if (!stat(file)) atomicJson(file, marker(record)); else assertMarker(file, record);
        }
        await ensureNoWriters(record);
      }
      record.phase = "running"; delete record.error; save(record);
      const manifest = readJson(manifestPath(record.network), 512 * 1024 * 1024);
      if (manifest?.schema !== 1 || manifest.id !== record.id || !Array.isArray(manifest.items) || manifest.items.length !== record.files || manifest.items.length > MAX_FILES || !Array.isArray(manifest.directories) || record.completedFiles > record.files) throw Error("The saved chain file manifest needs recovery.");
      for (const relative of manifest.directories) ensureParents(path.join(relativeFile(record.destination.basedir, relative), ".keep"), record.destination.basedir);
      let lastDockerCheck = 0;
      for (let index = record.completedFiles; index < manifest.items.length; index++) {
        controller.signal.throwIfAborted(); manager.assertOperation("migration");
        if (Date.now() - lastDockerCheck > 2000) { await ensureNoWriters(record); lastDockerCheck = Date.now(); }
        const item = manifest.items[index]; relativeFile(record.source.basedir, item.relative);
        if (!Number.isSafeInteger(item.size) || item.size < 0) throw Error("Invalid chain file size in migration manifest.");
        progress(record, "Transferring " + item.relative); await transfer(record, item);
      }
      await ensureNoWriters(record);
      for (const relative of [...manifest.directories].sort((a, b) => b.length - a.length)) {
        const directory = relativeFile(record.source.basedir, relative); checkedPath(directory, { missing: true });
        try { fs.rmdirSync(directory); syncDir(path.dirname(directory)); } catch (error) { if (!absent(error)) throw Error("Unexpected data appeared in the old chain folder. Keep both applications stopped and resume after inspecting it."); }
      }
      const finalInventory = await inventory(record.destination.basedir);
      const expectedFiles = new Map(manifest.items.map(item => [item.relative, item.size]));
      if (finalInventory.files !== expectedFiles.size || finalInventory.items.some(item => expectedFiles.get(item.relative) !== item.size)) throw Error("The destination chain layout changed during migration. Keep the node stopped and inspect it before resuming.");
      manager.ensureFiles(record.network, null); manager._saveIntent(record.network, false);
      assertMarker(path.join(record.destination.basedir, MARKER), record);
      record.phase = "complete"; record.result = { summary: "Chain data migrated. The old node remains retired. Start a sync-only node in this plugin when ready. Wallets, producer keys, KOIN and VHP were not moved.", movedFiles: record.completedFiles, deletedFiles: record.completedFiles, bytes: record.completedBytes, warnings: [] };
      save(record); fs.unlinkSync(path.join(record.destination.basedir, MARKER)); syncDir(record.destination.basedir);
      state.phase = "complete"; state.result = record.result; state.resumable = false; progress(record, "Chain migration complete. Mining remains off."); await onComplete(record);
    } catch (error) {
      state.phase = controller.signal.aborted ? "cancelled" : "failed"; state.error = controller.signal.aborted ? "Migration paused. Resume before starting either node." : ["EACCES", "EPERM", "EBUSY"].includes(error.code) ? "Node data is locked or this operating-system account cannot move it. Give your account access to the displayed chain folders, then resume. Unfinished source files and completed verified copies are preserved." : error.message;
      state.resumable = !!stat(recordPath(record.network)); record.phase = state.phase; record.error = state.error;
      if (stat(recordPath(record.network))) { try { save(record); } catch (saveError) { state.error += " Recovery record: " + saveError.message; } }
      else reviewed = null;
    } finally { release?.(); manager._profileMigrationActive = false; pending = null; }
  }
  function start(network, previewId) {
    if (pending) throw Error("A Node migration is already running.");
    if (!reviewed || reviewed.network !== network || reviewed.previewId !== previewId) throw Error("Review this Node migration again before starting.");
    if (manager._op?.running || manager._move?.running || manager._quickSync?.running || manager._control.size) throw Error("Finish this plugin's current node operation before migrating another profile.");
    let record = journal(network), resume = !!record && record.phase !== "complete";
    if (!resume) record = { schema: 1, id: reviewed.previewId, network, source: reviewed.source, destination: reviewed.destination, preview: structuredClone(reviewed), bytes: reviewed.bytes, files: reviewed.files, completedFiles: 0, completedBytes: 0, phase: "running", prepared: false, current: null };
    controller = new AbortController(); manager._profileMigrationActive = true;
    state = { phase: "running", preview: publicPreview(reviewed), resumable: resume, progress: { completedBytes: record.completedBytes, totalBytes: record.bytes, completedFiles: record.completedFiles, totalFiles: record.files, detail: resume ? "Resuming the verified chain transfer…" : "Checking the old node and stopping its containers…" } };
    pending = Promise.resolve().then(() => run(record, resume)); return stateCopy();
  }
  return { preview, status, start, review(network, previewId) { if (!reviewed || reviewed.network !== network || reviewed.previewId !== previewId) throw Error("Review this Node migration again."); return publicPreview(reviewed); }, cancel() { controller?.abort(); return stateCopy(); }, async dispose() { controller?.abort(); await pending; }, get running() { return !!pending; } };
}
module.exports = { createProfileMigration, DATA_DIRS, MARKER, masterProfileFromRoot, identifyMasterSource, knownMasterProfiles };
