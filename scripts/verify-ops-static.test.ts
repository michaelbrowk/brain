import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const script = readFileSync(path.join(root, "scripts", "verify-ops.sh"), "utf8");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

describe("operational verification gate", () => {
  it("keeps every verification block the workflow used to run inline", () => {
    for (const marker of [
      "verify_scripts()",
      "verify_deploy_puller_units()",
      "verify_mail_units()",
      "verify_mail_accounts()",
      "verify_mail_runtime_ownership()",
      "verify_mail_key()",
      "verify_nginx_reference()",
    ]) {
      expect(script).toContain(marker);
    }
    expect(script).toContain("systemd-analyze verify");
    expect(script).toContain('systemd-analyze calendar "$schedule" --iterations=3');
    expect(script).toContain("test \"$schedule\" = '*:0/2'");
    expect(script).toContain('sudo systemd-sysusers --root="$sandbox"');
    expect(script).toContain('sudo systemd-tmpfiles --create --root="$sandbox"');
    expect(script).toContain(
      'sudo sed -i "s/g:brain-mail-runtime:--x/g:$runtime_gid:--x/" \\\n  "$sandbox/usr/lib/tmpfiles.d/brain-mail.conf"\n',
    );
    expect(script).toContain("sudo env PYTHONDONTWRITEBYTECODE=1 python3 ops/project_mail_runtime_test.py");
    expect(script).toContain("sudo env PYTHONDONTWRITEBYTECODE=1 python3 ops/create_brain_mail_key_test.py");
    expect(script).toContain('nginx -t -q -c "$sandbox/nginx.conf" -p "$sandbox"');
    expect(script).toContain("shellcheck \\\n  scripts/verify-ops.sh \\\n");
    expect(script.match(/ops\/create-brain-mail-key\.sh/g)).toHaveLength(2);
  });

  it("is the only verification step of the push workflow", () => {
    expect(workflow).toContain(
      "- name: Verify operational contracts\n        if: github.event_name == 'push'\n        run: bash scripts/verify-ops.sh\n",
    );
    for (const removed of [
      "Check operational scripts",
      "Verify deploy puller systemd units",
      "Verify staged Brain Mail systemd units",
      "Verify Brain Mail sysusers, tmpfiles, and ACL contract",
      "Verify Brain Mail runtime ownership isolation",
      "Verify Brain Mail key creation",
    ]) {
      expect(workflow).not.toContain(removed);
    }
  });
});
