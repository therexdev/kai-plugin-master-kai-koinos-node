"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function canonicalPath(value) {
  // Docker Desktop may spell the same Windows path with backslashes or /host_mnt.
  let p = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  p = p.replace(/^\/(?:host_mnt|run\/desktop\/mnt\/host|mnt)\/([a-z])\//i, "$1:/");
  return /^[a-z]:\//i.test(p) ? p.toLowerCase() : p;
}

// Both app profiles use this one machine/user lock. Keep it for the supervisor's
// lifetime, including intervals between Docker commands. No daemon-wide actions.
function claimProject(project, { lockRoot = path.join(os.tmpdir(), "kai-node-control"), pid = process.pid } = {}) {
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error("Invalid node project");
  fs.mkdirSync(lockRoot, { recursive: true });
  const dir = path.join(lockRoot, project);
  const token = `${pid}-${crypto.randomBytes(12).toString("hex")}`;
  try { fs.mkdirSync(dir); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const owners = fs.readdirSync(dir);
    for (const owner of owners) {
      if (!/^\d+-[a-f0-9]{24}$/.test(owner)) throw new Error("Node control lock needs inspection.");
      try { process.kill(Number(owner.split("-")[0]), 0); }
      catch (error) {
        if (error.code === "ESRCH") { try { fs.unlinkSync(path.join(dir, owner)); } catch {} continue; }
      }
      throw new Error("Another KAI app is managing this node. Use its Node screen; this app cannot restart or stop it.");
    }
    // A creator may not have written its token yet. Never steal a fresh lock.
    if (!owners.length && Date.now() - fs.statSync(dir).mtimeMs < 30000) throw new Error("Node control is starting in another app. Retrying shortly.");
    try { fs.rmdirSync(dir); fs.mkdirSync(dir); }
    catch { throw new Error("Another KAI app is taking control of this node. Retrying shortly."); }
  }
  fs.writeFileSync(path.join(dir, token), "", { flag: "wx" });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(path.join(dir, token)); fs.rmdirSync(dir); } catch {}
  };
}

async function inspectOwner(exec, project, nodeRoot) {
  const list = await exec("docker", ["ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"], { timeout: 15000 });
  if (!list.ok) return { ok: false, reason: "docker-unavailable", message: "Waiting for Docker to respond. Your node data is retained." };
  const ids = list.stdout.trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return { ok: true, empty: true };
  if (ids.some(id => !/^[a-f0-9]{12,64}$/i.test(id))) return { ok: false, reason: "ownership-unknown", message: "Could not verify which app owns the node." };
  const result = await exec("docker", ["inspect", "--format",
    '{{json (index .Config.Labels "com.docker.compose.project.working_dir")}}', ...ids], { timeout: 15000 });
  if (!result.ok) return { ok: false, reason: "ownership-unknown", message: "Node ownership could not be checked. Retrying shortly." };
  let roots;
  try { roots = result.stdout.trim().split("\n").map(line => JSON.parse(line)); } catch { roots = []; }
  if (roots.length !== ids.length || roots.some(p => typeof p !== "string" || !p)) return { ok: false, reason: "ownership-unknown", message: "This node does not identify its owning app. Automatic changes are paused." };
  if (roots.some(p => canonicalPath(p) !== canonicalPath(nodeRoot))) return { ok: false, reason: "managed-elsewhere", message: "This node belongs to another KAI profile (Master or Live/Test). It can keep running there, or close that app and use Migrate node here. Other node controls stay disabled." };
  return { ok: true, empty: false };
}

module.exports = { canonicalPath, claimProject, inspectOwner };
