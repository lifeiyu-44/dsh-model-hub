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
  it("reads the real nested structure (auth.accessToken / auth.domain)", () => {
    const doc = JSON.stringify({
      account: { uid: "u-1", nickname: { $wbEncrypted: 1, envelope: "nick" } },
      auth: {
        accessToken: "tok-abc",
        refreshToken: "ref-abc",
        domain: "www.workbuddy.ai",
        expiresIn: 3600,
        lastRefreshTime: 1793069057595,
      },
    });
    const parsed = parseAuthDocument(doc);
    expect(parsed.kind).toBe("plain");
    expect(parsed.token).toBe("tok-abc");
    expect(parsed.refreshToken).toBe("ref-abc");
    expect(parsed.region).toBe("global");
    expect(parsed.expiresAtMs).toBe(1793069057595 + 3600 * 1000);
  });

  it("still reads the legacy flat structure", () => {
    const doc = JSON.stringify({ domain: "www.workbuddy.ai", accessToken: "tok-123", expiresAt: 1900000000000 });
    const parsed = parseAuthDocument(doc);
    expect(parsed.kind).toBe("plain");
    expect(parsed.token).toBe("tok-123");
    expect(parsed.region).toBe("global");
    expect(parsed.expiresAtMs).toBe(1900000000000);
  });

  it("reports an encrypted token as such instead of pretending it is empty", () => {
    const doc = JSON.stringify({
      auth: { domain: "www.workbuddy.ai", accessToken: { $wbEncrypted: 1, envelope: "abc" } },
    });
    const parsed = parseAuthDocument(doc);
    expect(parsed.kind).toBe("encrypted");
    expect(parsed.token).toBeUndefined();
    expect(parsed.envelope).toBe("abc");
  });

  it("returns missing for malformed or empty documents", () => {
    expect(parseAuthDocument("not json").kind).toBe("missing");
    expect(parseAuthDocument("{}").kind).toBe("missing");
    expect(parseAuthDocument(JSON.stringify({ auth: { accessToken: "" } })).kind).toBe("missing");
  });
});
