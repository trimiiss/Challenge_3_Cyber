import { describe, expect, it } from "vitest";
import { jcs, jcsSha256, sha256Hex } from "../src/index";

// Build JSON escape sequences programmatically so the test source never contains literal escape
// sequences that an editor or tool could silently decode.
const BS = "\\";
const u = (hex: string) => `${BS}u${hex}`;

describe("jcs (RFC 8785)", () => {
  it("matches the RFC 8785 §3.2.3 sample (numbers, string escaping, key order)", () => {
    const str = `${u("20ac")}$${u("000F")}${u("000a")}A'${u("0042")}${u("0022")}${u("005c")}${BS}${BS}${BS}"${BS}/`;
    const input = `{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "${str}",
      "literals": [null, true, false]
    }`;
    const expectedStr = `${String.fromCodePoint(0x20ac)}$${u("000f")}${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/`;
    const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${expectedStr}"}`;
    expect(jcs(JSON.parse(input))).toBe(expected);
  });

  it("sorts keys by UTF-16 code units (RFC 8785 §3.2.3 sorting example)", () => {
    const input = `{
      "${u("20ac")}": "Euro Sign",
      "${BS}r": "Carriage Return",
      "${u("fb33")}": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "${u("d83d")}${u("de00")}": "Emoji: Grinning Face",
      "${u("0080")}": "Control",
      "${u("00f6")}": "Latin Small Letter O With Diaeresis"
    }`;
    const out = jcs(JSON.parse(input));
    // Check order in the canonical TEXT: re-parsing into a JS object would move "1" to the front.
    const order = [
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ].map((label) => out.indexOf(`"${label}"`));
    expect(order.every((pos) => pos > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.startsWith(`{"${BS}r":`)).toBe(true);
  });

  it("is independent of input key order and whitespace", () => {
    const a = { b: 1, a: { d: [1, 2], c: "x" } };
    const b = JSON.parse('{ "a" : { "c":"x", "d":[1,2] }, "b":1 }');
    expect(jcs(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(jcs(b)).toBe(jcs(a));
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => jcs(undefined)).toThrow(TypeError);
  });
});

describe("sha256 helpers", () => {
  it("hashes the empty string to the well-known digest", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("jcsSha256 = sha256(utf8(JCS(value)))", () => {
    const e = String.fromCodePoint(0xe9);
    const v = { z: e, a: 1 };
    expect(jcsSha256(v)).toBe(sha256Hex(Buffer.from(`{"a":1,"z":"${e}"}`, "utf8")));
  });
});
