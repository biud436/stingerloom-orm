import { extractMentions } from "../src/modules/notifications/mention-parser";

describe("[UNIT] mention-parser — extractMentions()", () => {
  it("extracts a single handle", () => {
    expect(extractMentions("hi @alice")).toEqual(["alice"]);
  });

  it("extracts multiple handles", () => {
    expect(extractMentions("hi @alice and @bob")).toEqual(["alice", "bob"]);
  });

  it("ignores email addresses (preceded by a word char)", () => {
    expect(extractMentions("email someone@example.com")).toEqual([]);
  });

  it("ignores @@-prefixed strings", () => {
    expect(extractMentions("@@notamention")).toEqual([]);
  });

  it("dedupes repeated handles", () => {
    expect(extractMentions("@alice @alice")).toEqual(["alice"]);
  });

  it("respects punctuation as a word boundary", () => {
    expect(extractMentions("@alice.")).toEqual(["alice"]);
    expect(extractMentions("Hey @bob, please review")).toEqual(["bob"]);
  });

  it("supports handles starting at column 0", () => {
    expect(extractMentions("@alice on the case")).toEqual(["alice"]);
  });

  it("supports underscores and hyphens in handles", () => {
    expect(extractMentions("ping @alice_smith and @bob-jones")).toEqual([
      "alice_smith",
      "bob-jones",
    ]);
  });

  it("returns [] for empty / falsy input", () => {
    expect(extractMentions("")).toEqual([]);
    expect(extractMentions(undefined as unknown as string)).toEqual([]);
    expect(extractMentions(null as unknown as string)).toEqual([]);
  });

  it("rejects handles longer than 32 characters (no partial match — \\b enforces a clean boundary)", () => {
    const long = "a".repeat(40);
    expect(extractMentions(`hi @${long}`)).toEqual([]);
    // Exactly 32 chars is the cap, with a non-word char after — accepted.
    expect(extractMentions(`hi @${"a".repeat(32)} ok`)).toEqual([
      "a".repeat(32),
    ]);
  });
});
