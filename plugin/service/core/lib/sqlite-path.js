"use strict";
const path = require("node:path");

// SQLite's Windows file APIs need the extended-length spelling even when
// Node's fs APIs can already open the same long path. Keep that spelling at
// the SQLite boundary; persisted journal identities remain ordinary paths.
function filesystemPath(file) {
  if (process.platform !== "win32") return file;
  if (file.startsWith("\\\\?\\UNC\\")) return "\\\\" + file.slice(8);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(file)) return file.slice(4);
  return file;
}
function sqlitePath(file) {
  return process.platform === "win32" ? path.toNamespacedPath(filesystemPath(file)) : file;
}
module.exports = { sqlitePath, filesystemPath };
