import { describe, expect, it } from "vitest";
import { parseAuthDocument, regionOfDomain } from "../src/channels/workbuddy/auth.js";

describe("regionOfDomain", () => {
  it("classifies brand domains", () => {
    expect(regionOfDomain("www.workbuddy.ai")).toBe("global");
    expect(regionOfDomain("codebuddy.ai")).toBe("global");
    expect(regionOfDomain("www.workbuddy.cn")).toBe("cn");
    expect(regionOfDomain("copilot.tencent.com")).toBe("cn");
  });

  it("does not let a lookalike domain qualify", () => {
    expect(regionOfDomain("codebuddy.ai.evil.com")).toBeUndefined();
    expect(regionOfDomain("notworkbuddy.ai")).toBeUndefined();
  });
});

describe("parseAuthDocument", () => {
  it("reads a plain-text token", () => {
    const doc = JSON.stringify({ domain: "www.workbuddy.ai", accessToken: "tok-123", refreshToken: "ref-1", expiresAt: 1900000000000 });
    const parsed = parseAuthDocument(doc);
    expect(parsed.kind).toBe("plain");
    expect(parsed.token).toBe("tok-123");
    expect(parsed.region).toBe("global");
    expect(parsed.expiresAtMs).toBe(1900000000000);
  });

  it("reports an encrypted token as such instead of pretending it is empty", () => {
    const doc = JSON.stringify({ domain: "www.workbuddy.ai", accessToken: { $wbEncrypted: 1, envelope: "abc" } });
    const parsed = parseAuthDocument(doc);
    expect(parsed.kind).toBe("encrypted");
    expect(parsed.token).toBeUndefined();
    expect(parsed.envelope).toBe("abc");
  });

  it("returns missing for malformed or empty documents", () => {
    expect(parseAuthDocument("not json").kind).toBe("missing");
    expect(parseAuthDocument("{}").kind).toBe("missing");
    expect(parseAuthDocument(JSON.stringify({ accessToken: "" })).kind).toBe("missing");
  });
});
