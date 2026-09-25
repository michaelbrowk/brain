import { readReleaseInfo } from "@/lib/release-info";
import { LoginForm } from "./login-form";

// The release is read per request rather than at build time: `release.json` is
// written beside the app by the deploy and the dev server has none, so a value
// baked into a static page would be the builder's answer and not the running
// instance's.
export const dynamic = "force-dynamic";

/** /login — the form is an island, and this is the one thing the server knows
 *  that the island does not: which release is running. A development server has
 *  no `release.json`, the version is null, and the foot of the screen stays
 *  empty rather than printing a word like "unknown". */
export default async function LoginPage() {
  const { version } = await readReleaseInfo();
  return <LoginForm version={version} />;
}
