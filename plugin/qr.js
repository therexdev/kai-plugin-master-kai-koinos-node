/*
 * Minimal QR encoder — byte mode, versions 1-10, ISO/IEC 18004.
 *
 * Why hand-rolled rather than a dependency: this window runs under
 * `script-src 'self'` with no network at all (see index.html's CSP), and the
 * whole point of the feature is showing a receive address on a machine that
 * may be offline. A CDN script or an image service could not work here, and
 * pulling an npm package into the Electron bundle for ~200 lines of finite,
 * fully-specified algorithm is a worse trade than owning it.
 *
 * Versions 1-10 is a deliberate ceiling, not laziness: v10-M carries 213
 * bytes and the longest thing we ever encode is a 42-character Ethereum
 * address. encode() throws above that rather than silently truncating, so a
 * future caller that tries to QR something large gets told instead of
 * shipping an unscannable square.
 *
 * Correctness is not eyeballed, because a code that is subtly wrong still
 * looks exactly like a QR code. scripts/qr-verify.js runs every version and
 * EC level through this encoder and checks two independent things: that
 * zxing-cpp — an outside decoder of the same lineage phone cameras use —
 * reads each one back as the exact input, and that every module matches the
 * reference `qrcode` implementation, so we are not quietly spending the
 * error-correction budget on damage a decoder happens to repair. (Modules are
 * compared at the reference's own mask: mask choice is a scoring tie-break
 * the two libraries legitimately disagree on, and everything that decides
 * what the code MEANS is compared exactly.)
 */
(function (root) {
  "use strict";

  // ---- GF(256), primitive polynomial 0x11D ----
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** Reed-Solomon generator polynomial of the given degree. */
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gfMul(poly[j], EXP[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    // Built lowest-degree-first above; rsEncode indexes it highest-first with
    // the monic leading term at [0], so hand it back in that order.
    return poly.reverse();
  }

  /** EC codewords for one data block. */
  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
    }
    return res;
  }

  // ---- spec tables, versions 1-10 ----
  // Total codewords (data + EC) per version.
  const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

  // [ecCodewordsPerBlock, group1Blocks, group1Data, group2Blocks, group2Data]
  // keyed by EC level then version index.
  const BLOCKS = {
    L: [
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0], [26, 1, 108, 0, 0],
      [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0], [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
    ],
    M: [
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
      [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
    ],
    Q: [
      [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0], [18, 2, 15, 2, 16],
      [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19], [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
    ],
    H: [
      [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0], [22, 2, 11, 2, 12],
      [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15], [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
    ],
  };

  // Alignment pattern centre coordinates per version (empty for v1).
  const ALIGN = [
    [], [6, 18], [6, 22], [6, 26], [6, 30],
    [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  const EC_BITS = { L: 1, M: 0, Q: 3, H: 2 }; // format-info encoding of the level
  const MAX_VERSION = 10;

  const dataCapacity = (version, ec) => {
    const [ecLen, b1, d1, b2, d2] = BLOCKS[ec][version - 1];
    return b1 * d1 + b2 * d2;
  };

  // ---- bit stream ----
  function buildBitStream(bytes, version, ec) {
    const bits = [];
    const push = (value, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);

    const capacityBits = dataCapacity(version, ec) * 8;
    // Terminator: up to four zeros, fewer if we are already near the end.
    push(0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }
    // Alternating pad bytes until the data capacity is filled.
    const pad = [0xec, 0x11];
    for (let i = 0; codewords.length < dataCapacity(version, ec); i++) codewords.push(pad[i % 2]);
    return codewords;
  }

  /** Split into blocks, add EC, and interleave as the spec requires. */
  function interleave(codewords, version, ec) {
    const [ecLen, b1, d1, b2, d2] = BLOCKS[ec][version - 1];
    const blocks = [];
    let at = 0;
    for (let i = 0; i < b1; i++) blocks.push(codewords.slice(at, (at += d1)));
    for (let i = 0; i < b2; i++) blocks.push(codewords.slice(at, (at += d2)));
    const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));

    const out = [];
    const maxData = Math.max(d1, d2);
    for (let i = 0; i < maxData; i++) {
      for (const b of blocks) if (i < b.length) out.push(b[i]);
    }
    for (let i = 0; i < ecLen; i++) {
      for (const b of ecBlocks) out.push(b[i]);
    }
    return out;
  }

  // ---- BCH codes for format and version information ----
  function bchFormat(data) {
    let value = data << 10;
    for (let i = 14; i >= 10; i--) if ((value >> i) & 1) value ^= 0x537 << (i - 10);
    return ((data << 10) | value) ^ 0x5412;
  }
  function bchVersion(version) {
    let value = version << 12;
    for (let i = 17; i >= 12; i--) if ((value >> i) & 1) value ^= 0x1f25 << (i - 12);
    return (version << 12) | value;
  }

  // ---- module placement ----
  const MASKS = [
    (i, j) => (i + j) % 2 === 0,
    (i) => i % 2 === 0,
    (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
    (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
  ];

  function blankMatrix(size) {
    const m = [];
    for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFunctionPatterns(m, version) {
    const size = m.length;
    const setFinder = (row, col) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = row + r;
          const cc = col + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          m[rr][cc] = onRing || inCore ? 1 : 0;
        }
      }
    };
    setFinder(0, 0);
    setFinder(0, size - 7);
    setFinder(size - 7, 0);

    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      const bit = i % 2 === 0 ? 1 : 0;
      m[6][i] = bit;
      m[i][6] = bit;
    }

    // Alignment patterns, skipping the three finder corners.
    const centres = ALIGN[version - 1];
    for (const r of centres) {
      for (const c of centres) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
          }
        }
      }
    }

    m[size - 8][8] = 1; // dark module

    // Reserve format-info cells so data placement skips them.
    for (let i = 0; i < 9; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (let i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }

    // Version information blocks (v7+).
    if (version >= 7) {
      const bits = bchVersion(version);
      for (let i = 0; i < 18; i++) {
        const bit = (bits >> i) & 1;
        m[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        m[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }
  }

  /** Which cells are function modules — computed before any data lands. */
  function reservedMask(version, size) {
    const probe = blankMatrix(size);
    placeFunctionPatterns(probe, version);
    return probe.map((row) => row.map((v) => v !== null));
  }

  function placeData(m, reserved, codewords) {
    const size = m.length;
    const bits = [];
    for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

    let idx = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // column 6 is the vertical timing pattern
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (const col of [right, right - 1]) {
          if (reserved[row][col]) continue;
          m[row][col] = idx < bits.length ? bits[idx] : 0;
          idx++;
        }
      }
      upward = !upward;
    }
  }

  function applyMask(m, reserved, maskId) {
    const fn = MASKS[maskId];
    const out = m.map((row) => row.slice());
    for (let i = 0; i < m.length; i++) {
      for (let j = 0; j < m.length; j++) {
        if (!reserved[i][j] && fn(i, j)) out[i][j] ^= 1;
      }
    }
    return out;
  }

  // Format-info module positions, listed from the most significant of the 15
  // bits to the least. Two copies: one wrapped around the top-left finder,
  // one split between the other two. Written out longhand because the order
  // is irregular (it steps over the timing row and the dark module) and an
  // arithmetic shortcut here is exactly how the bits end up mirrored.
  function formatPositions(size) {
    return [
      [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
       [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]],
      [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8],
       [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6],
       [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]],
    ];
  }

  function writeFormat(m, ec, maskId) {
    const bits = bchFormat((EC_BITS[ec] << 3) | maskId);
    for (const copy of formatPositions(m.length)) {
      copy.forEach(([r, c], p) => {
        m[r][c] = (bits >> (14 - p)) & 1;
      });
    }
  }

  // ---- mask penalty scoring (spec rules 1-4) ----
  function penalty(m) {
    const size = m.length;
    let score = 0;

    const runScore = (line) => {
      let total = 0;
      let run = 1;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) total += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) total += 3 + (run - 5);
      return total;
    };

    const FINDERISH = [
      [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
      [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
    ];
    const patternScore = (line) => {
      let total = 0;
      for (let i = 0; i + 11 <= line.length; i++) {
        for (const pat of FINDERISH) {
          let hit = true;
          for (let k = 0; k < 11; k++) {
            if (line[i + k] !== pat[k]) { hit = false; break; }
          }
          if (hit) total += 40;
        }
      }
      return total;
    };

    for (let i = 0; i < size; i++) {
      const row = m[i];
      const col = m.map((r) => r[i]);
      score += runScore(row) + runScore(col);
      score += patternScore(row) + patternScore(col);
    }

    for (let i = 0; i < size - 1; i++) {
      for (let j = 0; j < size - 1; j++) {
        const v = m[i][j];
        if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
      }
    }

    let dark = 0;
    for (const row of m) for (const v of row) dark += v;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  function toBytes(text) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, "utf8"));
  }

  /**
   * Encode text as a QR module matrix.
   * @returns {number[][]} rows of 0/1, 1 = dark. No quiet zone — the caller adds it.
   */
  function encode(text, opts) {
    const ec = (opts && opts.ec) || "M";
    if (!BLOCKS[ec]) throw new Error(`unknown QR error-correction level: ${ec}`);
    const bytes = toBytes(String(text));
    if (!bytes.length) throw new Error("nothing to encode");

    let version = (opts && opts.version) || 0;
    if (!version) {
      for (let v = 1; v <= MAX_VERSION; v++) {
        // The character-count indicator is 8 bits up to v9 and 16 from v10.
        const overhead = v <= 9 ? 2 : 3;
        if (bytes.length + overhead <= dataCapacity(v, ec)) { version = v; break; }
      }
    }
    if (!version) {
      throw new Error(
        `${bytes.length} bytes is too long for this encoder (max ${dataCapacity(MAX_VERSION, ec)} at level ${ec}, QR version ${MAX_VERSION})`
      );
    }

    const size = version * 4 + 17;
    const codewords = interleave(buildBitStream(bytes, version, ec), version, ec);
    const reserved = reservedMask(version, size);

    const base = blankMatrix(size);
    placeFunctionPatterns(base, version);
    placeData(base, reserved, codewords);

    let best = null;
    // opts.mask pins the mask instead of scoring all eight — used by the
    // verifier to separate "wrong data placement" from "wrong penalty score".
    const masks = opts && opts.mask != null ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const mask of masks) {
      const candidate = applyMask(base, reserved, mask);
      writeFormat(candidate, ec, mask);
      const score = penalty(candidate);
      if (!best || score < best.score) best = { score, mask, matrix: candidate };
    }
    return best.matrix;
  }

  /** Render a matrix as a standalone SVG string, quiet zone included. */
  function svg(matrix, opts) {
    const o = opts || {};
    const quiet = o.quiet == null ? 4 : o.quiet;
    const scale = o.scale || 6;
    const n = matrix.length + quiet * 2;
    const px = n * scale;
    let path = "";
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix.length; j++) {
        if (matrix[i][j]) path += `M${(j + quiet) * scale} ${(i + quiet) * scale}h${scale}v${scale}h-${scale}z`;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges">` +
      `<rect width="${px}" height="${px}" fill="#ffffff"/>` +
      `<path d="${path}" fill="#000000"/></svg>`
    );
  }

  const api = { encode, svg, MAX_VERSION };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.KQR = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
