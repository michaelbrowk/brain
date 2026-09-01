import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OAuthConsent } from "./oauth-consent";

describe("OAuth consent", () => {
  it("shows the unverified client warning and the complete exact redirect URI", () => {
    const redirectUri =
      "https://client.example/oauth/callback?workspace=private&return=brain";
    const html = renderToStaticMarkup(
      <OAuthConsent
        request={{
          clientId: "brain_client_test",
          clientName: "Helpful Brain App",
          redirectUri,
          redirectHost: "client.example",
          scopes: ["brain:read", "brain:write"],
          resource: "https://brain.example/api/mcp",
          codeChallenge: "a".repeat(43),
        }}
        requestToken="signed-request"
      />,
    );

    expect(html).toContain("Unverified client name");
    expect(html).toContain(
      "https://client.example/oauth/callback?workspace=private&amp;return=brain",
    );
    expect(html).toContain("Exact redirect after approval");
  });
});
