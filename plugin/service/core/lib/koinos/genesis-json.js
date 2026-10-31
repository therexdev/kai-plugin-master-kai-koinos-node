"use strict";
// Compare genesis values without depending on checkout line endings, object-key
// order or a JSON parser's floating-point rounding. Never discard duplicate keys.
const { TextDecoder } = require("node:util");
const MAX_BYTES = 8 * 1024 * 1024, MAX_DEPTH = 64, MAX_NUMBER_LENGTH = 512, MAX_VALUES = 200000;
function canonicalGenesis(input) {
  if (!Buffer.isBuffer(input) || input.length > MAX_BYTES) throw Error("Genesis JSON exceeds its supported size limit.");
  let source;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input); }
  catch { throw Error("Genesis JSON is not valid UTF-8."); }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let index = 0, values = 0;
  const invalid = () => { throw Error("Genesis JSON is malformed."); };
  const space = () => { while (index < source.length && /[\x20\t\r\n]/.test(source[index])) index++; };
  function string() {
    if (source[index] !== '"') invalid();
    const start = index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === "\\") { index++; continue; }
      if (char === '"') {
        let value; try { value = JSON.parse(source.slice(start, index)); } catch { invalid(); }
        // Escaped lone UTF-16 surrogates have no valid UTF-8 value and different
        // JSON consumers can interpret them differently. Genesis never needs them.
        for (let at = 0; at < value.length; at++) {
          const code = value.charCodeAt(at);
          if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++at); if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(); }
          else if (code >= 0xdc00 && code <= 0xdfff) invalid();
        }
        return value;
      }
    }
    invalid();
  }
  function number() {
    const start = index;
    if (source[index] === "-") index++;
    if (source[index] === "0") index++;
    else { if (!/[1-9]/.test(source[index] || "")) invalid(); while (/[0-9]/.test(source[index] || "")) index++; }
    let fraction = "";
    if (source[index] === ".") { index++; const begin = index; while (/[0-9]/.test(source[index] || "")) index++; if (begin === index) invalid(); fraction = source.slice(begin, index); }
    let exponent = "0";
    if (source[index] === "e" || source[index] === "E") { index++; const begin = index; if (source[index] === "+" || source[index] === "-") index++; const digits = index; while (/[0-9]/.test(source[index] || "")) index++; if (digits === index) invalid(); exponent = source.slice(begin, index); }
    if (index - start > MAX_NUMBER_LENGTH) throw Error("Genesis JSON contains an unsupported numeric length.");
    const token = source.slice(start, index), negative = token.startsWith("-");
    let digits = token.split(/[.eE]/, 1)[0].replace(/^-/, "") + fraction;
    digits = digits.replace(/^0+/, ""); if (!digits) return ["number", "0", "0"];
    const trimmed = digits.replace(/0+$/, ""), power = BigInt(exponent) - BigInt(fraction.length) + BigInt(digits.length - trimmed.length);
    return ["number", (negative ? "-" : "") + trimmed, power.toString()];
  }
  function value(depth) {
    if (depth > MAX_DEPTH) throw Error("Genesis JSON nesting exceeds its supported limit.");
    if (++values > MAX_VALUES) throw Error("Genesis JSON contains too many values.");
    space(); const char = source[index];
    if (char === '"') return ["string", string()];
    if (char === "{") {
      index++; space(); const members = [], seen = new Set();
      if (source[index] !== "}") for (;;) {
        space(); const name = string(); if (seen.has(name)) throw Error("Genesis JSON contains a duplicate object key."); seen.add(name);
        space(); if (source[index++] !== ":") invalid(); members.push([name, value(depth + 1)]); space();
        if (source[index] === "}") break; if (source[index++] !== ",") invalid();
      }
      index++; members.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); return ["object", members];
    }
    if (char === "[") {
      index++; space(); const items = [];
      if (source[index] !== "]") for (;;) { items.push(value(depth + 1)); space(); if (source[index] === "]") break; if (source[index++] !== ",") invalid(); }
      index++; return ["array", items];
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]]) if (source.startsWith(literal, index)) { index += literal.length; return [literal === "null" ? "null" : "boolean", parsed]; }
    if (char === "-" || /[0-9]/.test(char || "")) return number();
    invalid();
  }
  const parsed = value(0); space(); if (index !== source.length || parsed[0] !== "object") invalid();
  return JSON.stringify(parsed);
}
module.exports = { canonicalGenesis, MAX_BYTES };
