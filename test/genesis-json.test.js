"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const { canonicalGenesis, MAX_BYTES } = require("../plugin/service/core/lib/koinos/genesis-json");
const canonical = text => canonicalGenesis(Buffer.from(text));

test("genesis comparison ignores only JSON representation differences", () => {
  const expected = canonical('{"entries":[{"space":{"id":1,"system":true},"value":"alpha"}],"empty":null}');
  assert.equal(canonical('\ufeff{\r\n "empty": null, "entries": [ { "value":"\\u0061lpha", "space": {"system": true, "id": 10e-1} } ]\r\n}\r\n'), expected);
  assert.equal(canonical('{"a":"😀"}'), canonical('{"a":"\\ud83d\\ude00"}'));
  assert.equal(canonical('{"__proto__":{},"constructor":1}'), canonical('{"constructor":1,"__proto__":{}}'));
});

test("number comparison is lossless and does not expand extreme exponents", () => {
  for (const [left, right] of [["1", "1.00e0"], ["-125.00", "-1.25e2"], ["0.0012", "12e-4"], ["0", "-0.000e999"], ["1e99999999999999999999", "10e99999999999999999998"]]) {
    assert.equal(canonical(`{"value":${left}}`), canonical(`{"value":${right}}`));
  }
  for (const [left, right] of [["9007199254740992", "9007199254740993"], ["1", "1.0000000000000001"], ["1e400", "1e401"], ["-1", "1"]]) {
    assert.notEqual(canonical(`{"value":${left}}`), canonical(`{"value":${right}}`));
  }
});

test("types, array order, strings and membership remain significant", () => {
  for (const [left, right] of [["1", '"1"'], ["true", "1"], ["null", '"null"'], ["[1,2]", "[2,1]"], ["[]", "{}"], ['"a "', '"a"'], ['"é"', '"é"']]) {
    assert.notEqual(canonical(`{"value":${left}}`), canonical(`{"value":${right}}`));
  }
  assert.notEqual(canonical('{"a":null}'), canonical("{}"));
});

test("malformed or ambiguous JSON is rejected instead of normalized", () => {
  for (const source of ['{"a":1,"a":1}', '{"a":1,"\\u0061":1}', '{"nested":{"a":1,"a":2}}']) assert.throws(() => canonical(source), /duplicate object key/);
  for (const source of ["", "[]", "null", "{} extra", "\ufeff\ufeff{}", "{\ufeff}", '{"a":01}', '{"a":+1}', '{"a":.1}', '{"a":1.}', '{"a":1e}', '{"a":1e+}', '{"a":NaN}', '{"a":Infinity}', '{"a":trueX}', '{"a":1,}', '{"a":[1,]}', '{"a":"\\q"}', '{"a":"\n"}', '{"a":"\\ud800"}', '{"a":"\\udc00"}', '{"a":/*comment*/1}']) assert.throws(() => canonical(source), /malformed/);
  assert.throws(() => canonicalGenesis(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), /valid UTF-8/);
});

test("genesis parsing bounds size, depth, values and numeric complexity", () => {
  assert.throws(() => canonicalGenesis(Buffer.alloc(MAX_BYTES + 1)), /size limit/);
  assert.throws(() => canonical('{"a":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}'), /nesting/);
  assert.throws(() => canonical('{"a":[' + "0,".repeat(200000) + '0]}'), /too many values/);
  assert.throws(() => canonical('{"a":1e' + '9'.repeat(513) + '}'), /numeric length/);
});
