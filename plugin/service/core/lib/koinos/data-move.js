"use strict";

/*
 * Moving the chain data to another disk, without ever being able to lose it.
 *
 * A synced Koinos node is tens of gigabytes, and the reason someone moves it
 * is almost always that the current drive is full or has been replaced. Both
 * of those are exactly the conditions under which a naive move destroys the
 * thing it was asked to protect: a rename across devices fails outright, a
 * copy that runs out of room halfway leaves a torn directory, and a "move"
 * implemented as delete-then-copy loses everything if the machine dies in the
 * middle.
 *
 * So the order here is fixed and non-negotiable:
 *
 *   1. copy everything into a TEMPORARY directory beside the destination,
 *      hashing each file as it is read
 *   2. check every file is present at the right size
 *   3. re-read the copy and check every sha256 against the source's
 *   4. only then swap the temp directory into place
 *   5. only then point the setting at it
 *   6. only then delete the original
 *
 * Steps 2 and 3 are separate on purpose. The size pass is nearly free and
 * catches the common failure — a copy cut short by a full disk or a pulled
 * cable. The checksum pass costs a second full read and catches the one the
 * size pass cannot: a file of exactly the right length holding the wrong
 * bytes. Since the reward for passing is that the original gets deleted, both
 * are worth their cost.
 *
 * Nothing before step 5 touches the source. Kill the process at any point and
 * the original is still there and still the one the app is configured to use;
 * the worst outcome is a half-written temp directory, which is disposable by
 * construction and is named so it can be recognised and swept up later.
 *
 * The copy is a manual walk rather than fs.cpSync because this is the main
 * process of a desktop app: a synchronous 50 GB copy would freeze the window,
 * and a progress bar is not decoration when the honest answer to "how long?"
 * is twenty minutes.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

// Copied into and swept from the destination's parent. The suffix is what
// makes an interrupted move recognisable as debris rather than data.
const TEMP_SUFFIX = ".koinos-move-tmp";

/*
 * Everything below walks the tree asynchronously.
 *
 * Core runs in Electron's MAIN process, so a synchronous walk of a 50 GB chain
 * directory freezes the window — the same class of bug as the v0.43.2 rmSync
 * freeze, smaller only because this touches metadata rather than bytes. The
 * copy and checksum passes were already streamed for exactly this reason; the
 * measuring and checking passes were not, which meant the app locked up before
 * the dialog that explains the move had even appeared.
 *
 * Files within one directory are statted with bounded concurrency rather than
 * one at a time: a purely sequential await chain is non-blocking but markedly
 * slower than the sync version it replaces, and this runs while someone is
 * waiting for a folder-picker dialog to respond. The bound is what keeps a
 * directory of ten thousand SST files from opening ten thousand handles at
 * once and hitting EMFILE.
 */
const STAT_CONCURRENCY = 32;

/** Run `fn` over `items` with at most `limit` in flight. Order is not kept. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(runners);
}

/** Does `p` exist? Async, and never throws. */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Bytes free on the filesystem holding `dir`, or null where unsupported. */
async function freeBytes(dir) {
  // statfs needs a path that exists; walk up until one does, since the
  // destination is usually about to be created.
  let probe = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    try {
      const s = await fsp.statfs(probe);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = path.dirname(probe);
      if (up === probe) return null;
      probe = up;
    }
  }
  return null;
}

/** Total bytes and file count under `dir`. Missing dir reads as empty. */
async function measure(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return; // unreadable subtree: measured as empty, and the copy will report it
    }
    const dirs = [];
    const paths = [];
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) dirs.push(p);
      else if (e.isFile()) paths.push(p);
    }
    await mapLimit(paths, STAT_CONCURRENCY, async (p) => {
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        return; // vanished mid-walk
      }
      // Resolve the stat BEFORE touching the accumulators. `bytes += await …`
      // reads `bytes` first and writes the sum back after the await, so with
      // several stats in flight each one adds to a value it read before its
      // neighbours had finished, and the total silently comes out short.
      bytes += st.size;
      files += 1;
    });
    for (const sub of dirs) await walk(sub);
  };
  await walk(path.resolve(dir));
  return { bytes, files };
}

/**
 * Is `child` the same as, or inside, `parent`?
 *
 * Moving a directory into itself is the one input that turns a copy into an
 * infinite one, and "put it in a subfolder of where it already is" is an
 * entirely reasonable thing for someone to try in a folder picker.
 */
function isInside(parent, child) {
  const a = path.resolve(parent);
  const b = path.resolve(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Everything that has to be true before a move is worth starting, answered in
 * one place so the UI can explain the "no" instead of just refusing.
 *
 * Resolves { ok, reason } — reason is written for a person, not a log.
 *
 * `size` is an already-taken measurement of the source. Callers that need the
 * size anyway pass theirs in, because inspecting a move used to walk the whole
 * tree twice — once here for the headroom sum and once in the caller for the
 * figure it shows the user — which on a 50 GB chain directory is the identical
 * expensive walk done back to back for one dialog.
 */
async function checkTarget(source, target, { headroomBytes = 512 * 1024 * 1024, size = null } = {}) {
  const src = path.resolve(source);
  const dst = path.resolve(target);

  if (src === dst) return { ok: false, reason: "That is already where the data lives." };
  if (isInside(src, dst)) {
    return { ok: false, reason: "That folder is inside the current data folder — pick somewhere outside it." };
  }
  if (isInside(dst, src)) {
    // Copying a directory into its own ancestor is legal, but the delete step
    // would then take the destination with it. Refuse rather than be clever.
    return { ok: false, reason: "The current data folder is inside that one — pick a different location." };
  }

  const dstExists = await exists(dst);
  if (dstExists) {
    let entries;
    try {
      entries = await fsp.readdir(dst);
    } catch (e) {
      return { ok: false, reason: `That folder can't be read (${e.code || e.message}).` };
    }
    if (entries.length) {
      return { ok: false, reason: "That folder already has something in it — choose an empty folder, or a new one." };
    }
  }

  // Writable? Find out now, with a real file, rather than 40 GB in.
  const probeDir = dstExists ? dst : path.dirname(dst);
  try {
    await fsp.mkdir(probeDir, { recursive: true });
    const probe = path.join(probeDir, `.koinos-write-test-${process.pid}`);
    await fsp.writeFile(probe, "x");
    await fsp.unlink(probe);
  } catch (e) {
    return { ok: false, reason: `That location can't be written to (${e.code || e.message}).` };
  }

  const need = (size || await measure(src)).bytes;
  const free = await freeBytes(probeDir);
  if (free != null && free < need + headroomBytes) {
    return {
      ok: false,
      reason: `Not enough room — the data is ${gb(need)} and that drive has ${gb(free)} free.`,
      needBytes: need,
      freeBytes: free,
    };
  }
  return { ok: true, needBytes: need, freeBytes: free };
}

function gb(n) {
  if (n == null) return "unknown";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

/**
 * Copy a tree, hashing every byte on the way through, reporting progress and
 * honouring cancellation.
 *
 * The hash is computed from the SOURCE as it is read, not afterwards. That is
 * the whole reason this streams rather than calling fs.copyFile: a separate
 * hashing pass would mean reading the entire source a second time, and on the
 * 50 GB this exists for that is not a rounding error. The trade is that we
 * give up any copy-on-write fast path the filesystem might have offered —
 * irrelevant here, because the destination is a different device (that is why
 * someone is moving) and reflinks do not cross devices anyway.
 *
 * Errors are NOT swallowed. A single unreadable file means the copy is not a
 * faithful one, and a faithful copy is the only thing that earns the right to
 * delete the original.
 *
 * Returns { bytes, sums } where sums maps each file's path RELATIVE to the
 * root onto its sha256 — relative so it can be checked against a destination
 * rooted somewhere else entirely.
 */
async function copyTree(src, dst, { onProgress = () => {}, shouldCancel = () => false, total = 0 }) {
  let done = 0;
  let lastPing = 0;
  const sums = new Map();
  const root = path.resolve(src);

  const walk = async (from, to) => {
    if (shouldCancel()) throw Object.assign(new Error("cancelled"), { cancelled: true });
    await fsp.mkdir(to, { recursive: true });
    const entries = await fsp.readdir(from, { withFileTypes: true });
    for (const e of entries) {
      if (shouldCancel()) throw Object.assign(new Error("cancelled"), { cancelled: true });
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) {
        await walk(a, b);
      } else if (e.isSymbolicLink()) {
        // Preserve the link rather than following it — a followed link would
        // silently inflate the copy, or loop.
        const target = await fsp.readlink(a);
        await fsp.symlink(target, b).catch(() => {});
      } else if (e.isFile()) {
        const h = crypto.createHash("sha256");
        await pipeline(
          fs.createReadStream(a),
          async function* (chunks) {
            for await (const c of chunks) {
              if (shouldCancel()) throw Object.assign(new Error("cancelled"), { cancelled: true });
              h.update(c);
              done += c.length;
              const now = Date.now();
              if (now - lastPing > 400) {
                lastPing = now;
                onProgress({ copiedBytes: done, totalBytes: total });
              }
              yield c;
            }
          },
          fs.createWriteStream(b),
        );
        sums.set(path.relative(root, a), h.digest("hex"));
      }
      // Sockets, FIFOs and devices are deliberately skipped: a chain data
      // directory has none, and copying one is never what was meant.
    }
  };

  await walk(root, path.resolve(dst));
  onProgress({ copiedBytes: done, totalBytes: total });
  return { bytes: done, sums };
}

/**
 * Re-read every copied file and check its sha256 against what was read out of
 * the source.
 *
 * This is the pass that answers "is everything still in order" rather than
 * merely "is everything there". The size check below catches a torn copy; only
 * this catches a file that is the right length and the wrong content — a bad
 * cable, a failing drive, silent corruption in flight.
 *
 * One honest limitation, stated here so nobody reads more into a green result
 * than it carries: reading a file back moments after writing it may be served
 * from the operating system's page cache rather than from the disk itself, so
 * this proves the bytes made it through the copy correctly, not that the new
 * drive will still return them a year from now. Nothing portable can prove the
 * latter, and the alternative — skipping the check — proves nothing at all.
 */
async function checksumTree(dst, sums, { onProgress = () => {}, shouldCancel = () => false, total = 0 } = {}) {
  const mismatched = [];
  const unreadable = [];
  let done = 0;
  let lastPing = 0;

  for (const [rel, want] of sums) {
    if (shouldCancel()) throw Object.assign(new Error("cancelled"), { cancelled: true });
    const file = path.join(path.resolve(dst), rel);
    try {
      const h = crypto.createHash("sha256");
      await pipeline(fs.createReadStream(file), async function* (chunks) {
        for await (const c of chunks) {
          h.update(c);
          done += c.length;
          const now = Date.now();
          if (now - lastPing > 400) {
            lastPing = now;
            onProgress({ checkedBytes: done, totalBytes: total });
          }
          yield c;
        }
      }, async function (chunks) { for await (const _ of chunks) { /* drain */ } });
      const got = h.digest("hex");
      if (got !== want) mismatched.push({ path: rel, want, got });
    } catch (e) {
      unreadable.push({ path: rel, error: e.code || e.message });
    }
  }
  onProgress({ checkedBytes: done, totalBytes: total });
  return { ok: mismatched.length === 0 && unreadable.length === 0, checked: sums.size, mismatched, unreadable };
}

/**
 * Prove the copy is faithful before anything irreversible happens.
 *
 * Byte-for-byte hashing of tens of gigabytes would take longer than the copy
 * itself and buy little against the failure this actually guards — a copy cut
 * short by a full disk, a dropped USB enclosure, or a killed process. Every
 * file present at an identical size catches all of those. It is stated plainly
 * rather than described as "verified" so nobody mistakes it for a checksum.
 */
async function verifyTree(src, dst) {
  const missing = [];
  const wrongSize = [];
  let checked = 0;

  const walk = async (from, to) => {
    const entries = await fsp.readdir(from, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const e of entries) {
      const pair = { a: path.join(from, e.name), b: path.join(to, e.name) };
      if (e.isDirectory()) dirs.push(pair);
      else if (e.isFile()) files.push(pair);
    }
    checked += files.length;
    await mapLimit(files, STAT_CONCURRENCY, async ({ a, b }) => {
      let sb;
      try {
        sb = await fsp.stat(b);
      } catch {
        missing.push(b);
        return;
      }
      const sa = await fsp.stat(a);
      if (sa.size !== sb.size) wrongSize.push({ path: b, expected: sa.size, got: sb.size });
    });
    for (const { a, b } of dirs) {
      if (!(await exists(b))) { missing.push(b); continue; }
      await walk(a, b);
    }
  };

  await walk(path.resolve(src), path.resolve(dst));
  return { ok: missing.length === 0 && wrongSize.length === 0, checked, missing, wrongSize };
}

module.exports = {
  TEMP_SUFFIX,
  freeBytes,
  measure,
  isInside,
  checkTarget,
  copyTree,
  verifyTree,
  checksumTree,
  gb,
};
