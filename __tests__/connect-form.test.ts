import { describe, expect, it } from "vitest";
import { CONNECT_FORM_HTML } from "../src/caldav";

const ACTION = "https://os.example.com/gatekeeper/caldav/abc/def";

describe("connect form", () => {
  it("offers both connection kinds, defaulting to a calendar account", () => {
    const html = CONNECT_FORM_HTML({ actionUrl: ACTION });
    expect(html).toContain('<fieldset data-mode="caldav">');
    expect(html).toContain('<fieldset data-mode="ics">');
    expect(html).toContain('name="mode" value="caldav" checked');
    expect(html).not.toContain('name="mode" value="ics" checked');
  });

  it("marks no field required, so choosing a published link can be submitted", () => {
    // Browser-enforced `required` on the account fields blocked submitting the other half of the
    // form; the POST handler validates the fields of the chosen mode instead.
    expect(CONNECT_FORM_HTML({ actionUrl: ACTION })).not.toMatch(/<input[^>]*\srequired/);
  });

  it("keeps the chosen mode and typed values when it comes back with an error", () => {
    const html = CONNECT_FORM_HTML({
      actionUrl: ACTION, mode: "ics", feedUrl: "https://example.com/a.ics", error: "That link is not public.",
    });
    expect(html).toContain('name="mode" value="ics" checked');
    expect(html).toContain('value="https://example.com/a.ics"');
    expect(html).toContain("That link is not public.");
  });

  it("escapes what it echoes back", () => {
    const html = CONNECT_FORM_HTML({ actionUrl: ACTION, mode: "ics", feedUrl: '"><script>alert(1)</script>' });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
