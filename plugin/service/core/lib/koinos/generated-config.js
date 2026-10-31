"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");

function checkedDirectory(directory, create = false) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root; let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); let entry;
    try { entry = fs.lstatSync(cursor); } catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      try { fs.mkdirSync(cursor); } catch (failure) { if (failure.code !== "EEXIST") throw failure; }
      entry = fs.lstatSync(cursor);
    }
    const systemAlias = process.platform === "darwin" && ["/tmp", "/var", "/etc"].includes(cursor);
    if ((!entry.isDirectory() || entry.isSymbolicLink()) && !systemAlias) throw Error("Generated Node configuration has an unsafe parent folder; existing files were preserved.");
  }
}
function checkedDestination(file) {
  checkedDirectory(path.dirname(file)); let leaf;
  try { leaf = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.nlink !== 1) throw Error("Generated Node configuration is linked or invalid; the existing file was preserved.");
  return leaf;
}
const sameFile = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

// Installed package files are immutable (0400). copyFile carries that readonly
// attribute into data on Windows, so the next node start cannot overwrite them.
// These callers name only generated public configuration files, never keys or
// databases. Publish fresh writable bytes without changing the package's mode.
function copyGeneratedFile(source, destination) {
  return writeGeneratedFile(fs.readFileSync(source), destination);
}
function writeGeneratedFile(bytes, destination) {
  if (!Buffer.isBuffer(bytes)) throw Error("Generated Node configuration bytes are required.");
  const before = checkedDestination(destination);
  const temporary = path.join(path.dirname(destination), ".kai-config-" + crypto.randomUUID() + ".tmp");
  let writable = false, published = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    // These public Docker configs must also be readable by container service UIDs.
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const current = checkedDestination(destination);
    if (before ? !sameFile(before, current) : current) throw Error("Generated Node configuration changed during preparation; the existing file was preserved.");
    // Windows cannot replace a readonly destination even with an atomic rename.
    // Repair this one verified generated file; never alter its parent or template.
    if (current && !(current.mode & 0o200)) { fs.chmodSync(destination, current.mode | 0o200); writable = true; }
    fs.renameSync(temporary, destination); published = true;
  } finally {
    try {
      if (!published && writable) {
        const current = checkedDestination(destination);
        if (sameFile(before, current)) fs.chmodSync(destination, before.mode);
      }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
module.exports = { copyGeneratedFile, writeGeneratedFile, ensureGeneratedDirectory: directory => checkedDirectory(directory, true) };
