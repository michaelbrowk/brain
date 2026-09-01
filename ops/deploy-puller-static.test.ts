import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function source(name: string) {
  return fs.readFile(path.join(process.cwd(), "ops", name), "utf8");
}

describe("deploy puller operational boundaries", () => {
  it("keeps a recurring poll independent of oneshot duration", async () => {
    const timer = await source("brain-deploy-puller.timer");
    expect(timer).toContain("OnCalendar=*:0/2");
    expect(timer).toContain("RandomizedDelaySec=15s");
    expect(timer).toContain("AccuracySec=1s");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=brain-deploy-puller.service");
    expect(timer).not.toContain("OnActiveSec=");
    expect(timer).not.toContain("OnBootSec=");
    expect(timer).not.toContain("OnUnitActiveSec=");
    expect(timer).not.toContain("OnUnitInactiveSec=");
  });

  it("treats the Next.js graceful SIGTERM exit as a clean service stop", async () => {
    const service = await source("brain.service");
    expect(service).toContain("TimeoutStopSec=20");
    expect(service).toContain("KillSignal=SIGTERM");
    expect(service).toContain("KillMode=mixed");
    expect(service).toContain("SuccessExitStatus=143");
    expect(service).toContain(
      "ExecStart=/opt/brain/runtime/current/bin/node /opt/brain/current/server.js",
    );
    expect(service).not.toContain("--import=");
    expect(service).not.toContain("KillMode=control-group");
    expect(service).not.toContain("NEXT_MANUAL_SIG_HANDLE");

    const wrapper = await source("brain-server.cjs");
    const preload = wrapper.indexOf('require("./brain-shutdown-preload.mjs")');
    const next = wrapper.indexOf('require("./brain-next-server.js")');
    expect(preload).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(preload);
  });

  it("exits cleanly while current main waits for its CI run", async () => {
    const puller = await source("deploy-puller.sh");
    expect(puller).toContain(
      'commit="$(run_resolver resolve "$candidate" "$minimum_commit")" || \\\n  resolver_status=$?',
    );
    expect(puller).toContain('if [[ "$resolver_status" -eq 75 ]]; then');
    const wait = puller.indexOf('[[ "$resolver_status" -eq 75 ]]');
    const hardFail = puller.indexOf('[[ "$resolver_status" -eq 0 ]] || exit "$resolver_status"');
    expect(wait).toBeGreaterThan(-1);
    expect(hardFail).toBeGreaterThan(wait);

    const resolver = await source("resolve-deploy-candidate.mjs");
    expect(resolver).toContain('error?.code === "candidate_not_ready"');
    expect(resolver).toContain("process.exitCode = 75;");
  });

  it("contains untrusted work in transient systemd cgroups", async () => {
    const puller = await source("deploy-puller.sh");
    expect(puller).toContain("systemd-run");
    expect(puller).toContain("--property=KillMode=control-group");
    expect(puller).toContain("--property=SupplementaryGroups=");
    expect(puller).toContain("LoadCredential=deployer-env:$env_file");
    expect(puller).toContain("--property=MemoryMax=512M");
    expect(puller).toContain("--property=TasksMax=64");
    expect(puller).toContain("--property=LimitNOFILE=1024");
    expect(puller).toContain("--unit=\"$unit\"");
    expect(puller).toContain(
      "systemctl kill --kill-whom=all --signal=KILL \"$unit\"",
    );
    expect(puller).toContain('systemctl stop "$unit"');
    expect(puller).toMatch(
      /listing="\$\(systemctl list-units[\s\S]*?"\$unit"\)" \|\| return 1/,
    );
    expect(puller).not.toContain(
      "systemctl show --property=ActiveState --value \"$unit\"",
    );
    expect(puller).not.toMatch(/pgrep\s+-u/);
    expect(puller).not.toMatch(/\bsetpriv\b|\bsetsid\b|--init-groups/);
  });

  it("cleans stale workspaces and reserves dynamic disk and inode space", async () => {
    const puller = await source("deploy-puller.sh");
    const cleanup = puller.indexOf("-name '.pull.*'");
    const staleUploads = puller.indexOf("! -name '.pull.*' -mtime +7");
    const artifactSize = puller.indexOf(
      'artifact_bytes="$(run_resolver artifact-size "$candidate")"',
    );
    const budget = puller.indexOf("preextract_required_kb=");
    const inodeBudget = puller.indexOf(
      "preextract_required_inodes=$((max_release_files + 10000))",
    );
    const download = puller.indexOf('run_resolver download "$candidate"');
    const extract = puller.indexOf("run_extractor extract");
    expect(cleanup).toBeGreaterThan(-1);
    expect(staleUploads).toBeGreaterThan(cleanup);
    expect(staleUploads).toBeLessThan(artifactSize);
    expect(artifactSize).toBeGreaterThan(cleanup);
    expect(budget).toBeGreaterThan(-1);
    expect(budget).toBeGreaterThan(artifactSize);
    expect(inodeBudget).toBeGreaterThan(budget);
    expect(puller).toContain('df -Pi "$base"');
    expect(puller).toContain("BRAIN_DEPLOY_MAX_RELEASE_FILES=\"$max_release_files\"");
    expect(puller).toContain("BRAIN_DEPLOY_MAX_RELEASE_BYTES=\"$max_release_bytes\"");
    expect(download).toBeGreaterThan(budget);
    expect(extract).toBeGreaterThan(download);
  });

  it("recovers a durable transaction before any active no-op", async () => {
    const puller = await source("deploy-puller.sh");
    const serviceIdentity = puller.indexOf("\nassert_release_service_identity\n");
    const recovery = puller.indexOf("\nrecover_transaction\n");
    const pendingRecovery = puller.indexOf("\nrecover_pending_release\n");
    expect(serviceIdentity).toBeGreaterThan(-1);
    expect(serviceIdentity).toBeLessThan(recovery);
    expect(puller).toContain(
      'load_state="$(systemctl show --property=LoadState --value brain.service)"',
    );
    expect(puller).toContain(
      'service_user="$(systemctl show --property=User --value brain.service)"',
    );
    expect(recovery).toBeGreaterThan(-1);
    expect(pendingRecovery).toBeGreaterThan(recovery);
    expect(pendingRecovery).toBeLessThan(
      puller.indexOf("\nstop_stale_transient_units\n"),
    );
    expect(recovery).toBeLessThan(
      puller.indexOf("is already active and healthy"),
    );
    expect(recovery).toBeLessThan(
      puller.indexOf('assert_root_config "$env_file" 600'),
    );
    expect(puller.indexOf("stop_stale_transient_units\n")).toBeLessThan(
      puller.indexOf('assert_root_config "$env_file" 600'),
    );
    expect(recovery).toBeLessThan(
      puller.indexOf('fetch_uid="$(id -u "$fetch_user")"'),
    );
    expect(recovery).toBeLessThan(
      puller.indexOf('assert_root_program "$resolver_path"'),
    );
    expect(puller.indexOf('"$runtime" "$transaction" begin')).toBeLessThan(
      puller.indexOf('atomic_switch "$release" promote'),
    );
    const stageTree = puller.indexOf(
      '"$runtime" "$transaction" sync-tree "$base" "$stage"',
    );
    const pendingWrite = puller.indexOf(
      '"$runtime" "$transaction" write-pending "$base" "$release" "$commit"',
    );
    const move = puller.indexOf('mv "$stage" "$release"');
    const promoteTree = puller.indexOf(
      '"$runtime" "$transaction" sync-tree "$base" "$release"',
    );
    const finalRecheck = puller.indexOf(
      'candidate changed immediately before promotion',
    );
    const begin = puller.indexOf('"$runtime" "$transaction" begin');
    expect(stageTree).toBeGreaterThan(-1);
    expect(pendingWrite).toBeGreaterThan(stageTree);
    expect(move).toBeGreaterThan(pendingWrite);
    expect(promoteTree).toBeGreaterThan(move);
    expect(finalRecheck).toBeGreaterThan(promoteTree);
    expect(begin).toBeGreaterThan(finalRecheck);
    expect(promoteTree).toBeLessThan(
      begin,
    );
    expect(puller).toContain('"$runtime" "$transaction" clear "$base"');
    expect(puller).toContain('wait_for_release_health "$previous_commit"');
    expect(puller).toContain("wait_for_shallow_health");
    expect(puller).toContain(
      '"$runtime" "$transaction" write-bootstrap "$base" "$expected"',
    );
    expect(puller).toContain(
      '"$runtime" "$transaction" inspect-recovery-fields',
    );
    const removeCandidate = puller.indexOf(
      'remove_candidate_release "$release"',
      puller.indexOf("recover_transaction()"),
    );
    const clearRecoveredJournal = puller.indexOf(
      '"$runtime" "$transaction" clear "$base"',
      removeCandidate,
    );
    expect(removeCandidate).toBeGreaterThan(-1);
    expect(clearRecoveredJournal).toBeGreaterThan(removeCandidate);
    const successPendingClear = puller.lastIndexOf(
      '"$runtime" "$transaction" clear-pending "$base" "$release" "$commit"',
    );
    const successJournalClear = puller.lastIndexOf(
      '"$runtime" "$transaction" clear "$base"',
    );
    expect(successPendingClear).toBeGreaterThan(begin);
    expect(successJournalClear).toBeGreaterThan(successPendingClear);

    const rollback = puller.indexOf("\nrollback() {");
    const rollbackEnsure = puller.indexOf(
      '"$runtime" "$transaction" ensure',
      rollback,
    );
    const rollbackSwitch = puller.indexOf(
      'atomic_switch "$previous" rollback',
      rollback,
    );
    const rollbackHealth = puller.indexOf(
      'wait_for_release_health "$previous_commit"',
      rollback,
    );
    const rollbackClear = puller.indexOf(
      '"$runtime" "$transaction" clear "$base"',
      rollbackHealth,
    );
    expect(rollbackEnsure).toBeGreaterThan(rollback);
    expect(rollbackSwitch).toBeGreaterThan(rollbackEnsure);
    expect(rollbackHealth).toBeGreaterThan(rollbackSwitch);
    expect(rollbackClear).toBeGreaterThan(rollbackHealth);
  });

  it("rejects a Mail projector drift before creating deployment state", async () => {
    const puller = await source("deploy-puller.sh");
    const verifiedTree = puller.indexOf(
      'python3 "$extractor" verify-tree "$stage" >/dev/null',
    );
    const projectorGuard = puller.indexOf("cmp --silent", verifiedTree);
    const installedProjector = puller.indexOf(
      '"$mail_runtime_projector_path"',
      projectorGuard,
    );
    const candidateProjector = puller.indexOf(
      '"$candidate_mail_runtime_projector"',
      installedProjector + 1,
    );
    const metadata = puller.indexOf('release_nonce="$(openssl rand -hex 16)"');
    const transaction = puller.indexOf('"$runtime" "$transaction" begin');
    const promotion = puller.indexOf('atomic_switch "$release" promote');

    expect(puller).toContain(
      'mail_runtime_projector_path="$bin_dir/project_mail_runtime.py"',
    );
    expect(puller).toContain(
      'fail "Brain Mail runtime projector update is required before deployment"',
    );
    expect(verifiedTree).toBeGreaterThan(-1);
    expect(projectorGuard).toBeGreaterThan(verifiedTree);
    expect(installedProjector).toBeGreaterThan(projectorGuard);
    expect(candidateProjector).toBeGreaterThan(installedProjector);
    expect(projectorGuard).toBeLessThan(metadata);
    expect(projectorGuard).toBeLessThan(transaction);
    expect(projectorGuard).toBeLessThan(promotion);
  });

  it("treats an installed Mail service as part of the exact release identity", async () => {
    const puller = await source("deploy-puller.sh");
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );
    const installer = await source("install-deploy-puller.sh");

    for (const deploy of [puller, manual]) {
      expect(deploy).toContain("read_unit_load_state brain-mail.service");
      expect(deploy).toContain("read_unit_load_state brain-mail.socket");
      expect(deploy).toContain("read_unit_load_state brain-mail-mime.socket");
      expect(deploy).toContain(
        "read_unit_load_state brain-mail-mime@brain-deploy-probe.service",
      );
      expect(deploy).not.toContain(
        "read_unit_load_state brain-mail-mime@.service",
      );
      expect(deploy).toContain('*"/90-brain-mail-client.conf"*');
      expect(deploy).toContain("--property=SupplementaryGroups --value brain.service");
      expect(deploy).toContain(
        '" $brain_supplementary_groups " == *" brain-mail-client "*',
      );
      expect(deploy).toContain('"$service_user" == "brain-mail"');
      expect(deploy).toContain('"$mail_socket_load" == "not-found"');
      expect(deploy).toContain('"$mail_mime_socket_load" == "not-found"');
      expect(deploy).toContain('"$mail_mime_service_load" == "not-found"');
      expect(deploy).toContain(
        '" $brain_supplementary_groups " != *" brain-mail-client "*',
      );
      expect(deploy).toContain("--unix-socket /run/brain-mail/brain-mail.sock");
      expect(deploy).toContain("http://brain-mail/v1/health");
      expect(deploy).toContain('"$runtime" "$mail_health_parser"');
      expect(deploy).toContain('actual="$(mail_health | read_mail_health_commit)"');
      expect(deploy).toContain('[[ "$actual" == "$expected" ]] || return 1');
    }

    const mailIdentity = puller.indexOf("\nassert_release_service_identity\n");
    const parserTrust = puller.indexOf(
      'assert_root_program "$mail_health_parser_path"',
      mailIdentity,
    );
    const recovery = puller.indexOf("\nrecover_transaction\n");
    expect(parserTrust).toBeGreaterThan(mailIdentity);
    expect(parserTrust).toBeLessThan(recovery);
    expect(manual).toContain('if (( mail_managed == 1 )) && \\\n');
    expect(manual).toContain(
      '"$(stat -c \'%u:%a\' "$mail_health_parser")" != "0:644"',
    );
    expect(installer).toContain('"$bin_dir/read-mail-health-commit.mjs"');
    expect(installer).toContain('"$repo_root/ops/read-mail-health-commit.mjs"');

    const activeNoOp = puller.indexOf(
      'if [[ "$active_commit" == "$current_main" ]]; then',
    );
    const exactHealth = puller.indexOf(
      'verify_release_health "$active_commit"',
      activeNoOp,
    );
    const success = puller.indexOf("is already active and healthy", activeNoOp);
    expect(exactHealth).toBeGreaterThan(activeNoOp);
    expect(success).toBeGreaterThan(exactHealth);
  });

  it("restarts Mail before Brain and verifies both before committing puller state", async () => {
    const puller = await source("deploy-puller.sh");
    const restartFunction = puller.slice(
      puller.indexOf("restart_release_services() {"),
      puller.indexOf("\nstop_stale_transient_units()", puller.indexOf("restart_release_services() {")),
    );
    expect(restartFunction.indexOf("systemctl restart brain-mail.service")).toBeGreaterThan(-1);
    expect(restartFunction.indexOf("systemctl restart brain.service")).toBeGreaterThan(
      restartFunction.indexOf("systemctl restart brain-mail.service"),
    );
    expect(puller.match(/systemctl restart brain-mail\.service/g)).toHaveLength(1);
    expect(puller.match(/systemctl restart brain\.service/g)).toHaveLength(1);

    const recovery = puller.slice(
      puller.indexOf("recover_transaction() {"),
      puller.indexOf("\nrecover_pending_release()"),
    );
    const recoverySwitch = recovery.indexOf('atomic_switch "$previous" recovery');
    const recoveryRestart = recovery.indexOf("restart_release_services");
    const recoveryHealth = recovery.indexOf('wait_for_release_health "$previous_commit"');
    const recoveryRemove = recovery.indexOf('remove_candidate_release "$release"');
    const recoveryClear = recovery.indexOf('"$runtime" "$transaction" clear "$base"');
    expect(recoveryRestart).toBeGreaterThan(recoverySwitch);
    expect(recoveryHealth).toBeGreaterThan(recoveryRestart);
    expect(recoveryRemove).toBeGreaterThan(recoveryHealth);
    expect(recoveryClear).toBeGreaterThan(recoveryRemove);

    const rollback = puller.slice(
      puller.indexOf("\nrollback() {"),
      puller.indexOf("\ntrap 'rollback $?'")
    );
    const rollbackSwitch = rollback.indexOf('atomic_switch "$previous" rollback');
    const rollbackRestart = rollback.indexOf("restart_release_services");
    const rollbackHealth = rollback.indexOf('wait_for_release_health "$previous_commit"');
    const rollbackRemove = rollback.indexOf('remove_candidate_release "$release"');
    const rollbackClear = rollback.indexOf('"$runtime" "$transaction" clear "$base"');
    expect(rollbackRestart).toBeGreaterThan(rollbackSwitch);
    expect(rollbackHealth).toBeGreaterThan(rollbackRestart);
    expect(rollbackRemove).toBeGreaterThan(rollbackHealth);
    expect(rollbackClear).toBeGreaterThan(rollbackRemove);

    const promote = puller.lastIndexOf('atomic_switch "$release" promote');
    const promoteRestart = puller.indexOf("restart_release_services", promote);
    const promoteHealth = puller.indexOf('verify_release_health "$commit"', promoteRestart);
    const pendingClear = puller.indexOf(
      '"$runtime" "$transaction" clear-pending "$base" "$release" "$commit"',
      promoteHealth,
    );
    const journalClear = puller.indexOf(
      '"$runtime" "$transaction" clear "$base"',
      pendingClear,
    );
    expect(promoteRestart).toBeGreaterThan(promote);
    expect(promoteHealth).toBeGreaterThan(promoteRestart);
    expect(pendingClear).toBeGreaterThan(promoteHealth);
    expect(journalClear).toBeGreaterThan(pendingClear);
  });

  it("keeps the manual fallback on the same Mail-aware rollback boundary", async () => {
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );
    const restartFunction = manual.slice(
      manual.indexOf("restart_release_services() {"),
      manual.indexOf("\nif ! assert_release_service_identity", manual.indexOf("restart_release_services() {")),
    );
    expect(restartFunction.indexOf("systemctl restart brain-mail.service")).toBeGreaterThan(-1);
    expect(restartFunction.indexOf("systemctl restart brain.service")).toBeGreaterThan(
      restartFunction.indexOf("systemctl restart brain-mail.service"),
    );
    expect(manual.match(/systemctl restart brain-mail\.service/g)).toHaveLength(1);
    expect(manual.match(/systemctl restart brain\.service/g)).toHaveLength(1);

    const rollback = manual.slice(
      manual.indexOf("\nrollback()"),
      manual.indexOf("\ntrap 'rollback $?'"),
    );
    const rollbackSwitch = rollback.indexOf('atomic_switch "$previous" rollback');
    const rollbackRestart = rollback.indexOf("restart_release_services");
    const rollbackHealth = rollback.indexOf("wait_for_previous_health");
    const rollbackRemove = rollback.indexOf("remove_candidate_release");
    const rollbackClear = rollback.indexOf('"$runtime" "$transaction" clear "$base"');
    expect(rollbackRestart).toBeGreaterThan(rollbackSwitch);
    expect(rollbackHealth).toBeGreaterThan(rollbackRestart);
    expect(rollbackRemove).toBeGreaterThan(rollbackHealth);
    expect(rollbackClear).toBeGreaterThan(rollbackRemove);

    const promote = manual.lastIndexOf('atomic_switch "$release" promote');
    const promoteRestart = manual.indexOf("restart_release_services", promote);
    const promoteHealth = manual.indexOf(
      'verify_release_health "$expected_commit"',
      promoteRestart,
    );
    const pendingClear = manual.indexOf(
      '"$runtime" "$transaction" clear-pending',
      promoteHealth,
    );
    const journalClear = manual.indexOf(
      '"$runtime" "$transaction" clear "$base"',
      pendingClear,
    );
    expect(promoteRestart).toBeGreaterThan(promote);
    expect(promoteHealth).toBeGreaterThan(promoteRestart);
    expect(pendingClear).toBeGreaterThan(promoteHealth);
    expect(journalClear).toBeGreaterThan(pendingClear);
  });

  it("bounds only the first cold readiness probe generously", async () => {
    const puller = await source("deploy-puller.sh");
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );

    for (const [deploy, expectedCommit] of [
      [puller, 'verify_release_health "$commit"'],
      [manual, 'verify_release_health "$expected_commit"'],
    ] as const) {
      expect(deploy).toContain("deep_health_max_time=120");
      expect(deploy).toContain("deep_health_max_time=10");
      expect(deploy).toMatch(
        /if \(\( [_a-z]+ == 1 \)\); then[\s\S]*?deep_health_max_time=120[\s\S]*?else[\s\S]*?deep_health_max_time=10[\s\S]*?fi/,
      );

      const promotion = deploy.lastIndexOf('atomic_switch "$release" promote');
      const coldBudget = deploy.indexOf("deep_health_max_time=120", promotion);
      const retryBudget = deploy.indexOf("deep_health_max_time=10", coldBudget);
      const health = deploy.indexOf(expectedCommit, retryBudget);
      expect(coldBudget).toBeGreaterThan(promotion);
      expect(retryBudget).toBeGreaterThan(coldBudget);
      expect(health).toBeGreaterThan(retryBudget);
    }
  });

  it("makes the manual fallback refuse an active automatic transaction", async () => {
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );
    expect(manual).toContain('transaction_journal="$base/.deploy-transaction.json"');
    expect(manual).toContain('pending_marker="$base/.deploy-pending.json"');
    expect(manual).toContain('-e "$pending_marker"');
    const lock = manual.lastIndexOf('exec 9>"$base/.deploy.lock"');
    const refusal = manual.lastIndexOf('[[ -e "$transaction_journal"');
    expect(lock).toBeGreaterThan(-1);
    expect(refusal).toBeGreaterThan(lock);
    const prepare = manual.indexOf("<<'PREPARE'");
    const staleUploads = manual.indexOf(
      "! -name '.pull.*' -mtime +7",
      prepare,
    );
    const diskGate = manual.indexOf(
      'available_kb="$(df -Pk "$base"',
      prepare,
    );
    expect(staleUploads).toBeGreaterThan(prepare);
    expect(diskGate).toBeGreaterThan(staleUploads);
  });

  it("uses the durable transaction protocol for the manual fallback", async () => {
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );
    const remote = manual.indexOf("<<'REMOTE'");
    const stageSync = manual.indexOf(
      '"$runtime" "$transaction" sync-tree "$base" "$incoming"',
      remote,
    );
    const pending = manual.indexOf(
      '"$runtime" "$transaction" write-pending',
      stageSync,
    );
    const move = manual.indexOf('mv "$incoming" "$release"', pending);
    const releaseSync = manual.indexOf(
      '"$runtime" "$transaction" sync-tree "$base" "$release"',
      move,
    );
    const journal = manual.indexOf(
      '"$runtime" "$transaction" begin',
      releaseSync,
    );
    const promote = manual.indexOf('atomic_switch "$release" promote', journal);
    const successPendingClear = manual.lastIndexOf(
      '"$runtime" "$transaction" clear-pending',
    );
    const successJournalClear = manual.lastIndexOf(
      '"$runtime" "$transaction" clear "$base"',
    );
    const rollback = manual.indexOf("\nrollback()", remote);
    const restoreBootstrap = manual.indexOf(
      "could not restore the bootstrap deployment authority",
      rollback,
    );
    expect(stageSync).toBeGreaterThan(remote);
    expect(pending).toBeGreaterThan(stageSync);
    expect(move).toBeGreaterThan(pending);
    expect(releaseSync).toBeGreaterThan(move);
    expect(journal).toBeGreaterThan(releaseSync);
    expect(promote).toBeGreaterThan(journal);
    expect(successPendingClear).toBeGreaterThan(promote);
    expect(successJournalClear).toBeGreaterThan(successPendingClear);
    expect(restoreBootstrap).toBeGreaterThan(rollback);
  });

  it("normalizes a manual upload before it can become transaction authority", async () => {
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );
    const remote = manual.indexOf("<<'REMOTE'");
    const specialGate = manual.indexOf(
      "manual release contains a special filesystem entry",
      remote,
    );
    const hardlinkGate = manual.indexOf(
      "manual release contains a hard-linked file",
      specialGate,
    );
    const chown = manual.indexOf(
      'chown -R --no-dereference root:brain "$incoming"',
      hardlinkGate,
    );
    const directoryMode = manual.indexOf(
      'find "$incoming" -xdev -type d -exec chmod 0550 {} +',
      chown,
    );
    const fileMode = manual.indexOf(
      'find "$incoming" -xdev -type f -exec chmod 0440 {} +',
      directoryMode,
    );
    const ownershipGate = manual.indexOf(
      'ownership_mismatch="$(find "$incoming" -xdev',
      fileMode,
    );
    const modeGate = manual.indexOf(
      'mode_mismatch="$(find "$incoming" -xdev',
      ownershipGate,
    );
    const stageSync = manual.indexOf(
      '"$runtime" "$transaction" sync-tree "$base" "$incoming"',
      modeGate,
    );
    const treeVerifier = manual.indexOf(
      'python3 "$extractor" verify-tree "$incoming"',
      modeGate,
    );
    const pending = manual.indexOf(
      '"$runtime" "$transaction" write-pending',
      stageSync,
    );
    expect(specialGate).toBeGreaterThan(remote);
    expect(hardlinkGate).toBeGreaterThan(specialGate);
    expect(chown).toBeGreaterThan(hardlinkGate);
    expect(directoryMode).toBeGreaterThan(chown);
    expect(fileMode).toBeGreaterThan(directoryMode);
    expect(ownershipGate).toBeGreaterThan(fileMode);
    expect(modeGate).toBeGreaterThan(ownershipGate);
    expect(treeVerifier).toBeGreaterThan(modeGate);
    expect(stageSync).toBeGreaterThan(treeVerifier);
    expect(stageSync).toBeGreaterThan(modeGate);
    expect(pending).toBeGreaterThan(stageSync);
  });

  it("rolls back an active manual candidate even after journal unlink", async () => {
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );
    const rollback = manual.indexOf("\nrollback()");
    const current = manual.indexOf(
      'current_target="$(readlink -f "$current")"',
      rollback,
    );
    const inMemoryAuthority = manual.indexOf(
      '"$current_target" == "$release"',
      current,
    );
    const outside = manual.indexOf(
      "current points outside the manual deployment transaction",
      current,
    );
    const restore = manual.indexOf(
      'atomic_switch "$previous" rollback',
      inMemoryAuthority,
    );
    const ensureAuthority = manual.indexOf(
      '"$runtime" "$transaction" ensure',
      inMemoryAuthority,
    );
    const bootstrap = manual.indexOf(
      "could not restore the bootstrap deployment authority",
      restore,
    );
    expect(current).toBeGreaterThan(rollback);
    expect(outside).toBeGreaterThan(current);
    expect(inMemoryAuthority).toBeGreaterThan(outside);
    expect(ensureAuthority).toBeGreaterThan(inMemoryAuthority);
    expect(restore).toBeGreaterThan(ensureAuthority);
    expect(restore).toBeGreaterThan(inMemoryAuthority);
    expect(bootstrap).toBeGreaterThan(restore);
    expect(manual).not.toContain(
      "active manual release has no durable transaction journal",
    );
  });

  it("documents recover-first behavior for a manual rollback", async () => {
    const operations = await fs.readFile(
      path.join(process.cwd(), "docs", "operations.md"),
      "utf8",
    );
    const rollback = operations.indexOf("## Rollback");
    const lockFailure = operations.indexOf("if ! flock -w 300 9; then", rollback);
    const lockExit = operations.indexOf("exit 75", lockFailure);
    const journal = operations.indexOf(".deploy-transaction.json", rollback);
    const pending = operations.indexOf(".deploy-pending.json", rollback);
    const recoverFirst = operations.indexOf(
      "run the automatic puller recovery first",
      rollback,
    );
    expect(lockFailure).toBeGreaterThan(rollback);
    expect(lockExit).toBeGreaterThan(lockFailure);
    expect(lockExit).toBeLessThan(journal);
    expect(
      operations.indexOf(
        "timed out waiting for the Brain deployment lock",
        rollback,
      ),
    ).toBeGreaterThan(lockFailure);
    expect(journal).toBeGreaterThan(lockFailure);
    expect(pending).toBeGreaterThan(lockFailure);
    expect(recoverFirst).toBeGreaterThan(journal);
  });

  it("verifies the resolved Node chain before executing Node", async () => {
    const puller = await source("deploy-puller.sh");
    const trust = puller.indexOf('runtime="$(assert_root_chain "$runtime_link")"');
    const execute = puller.indexOf('"$("$runtime" --version)"');
    expect(trust).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(trust);
  });

  it("installs only while units are stopped and both deploy locks are held", async () => {
    const installer = await source("install-deploy-puller.sh");
    const inactive = installer.indexOf(
      "systemctl is-active --quiet brain-deploy-puller.service",
    );
    const pollLock = installer.indexOf("exec 8>/opt/brain/.deploy-poll.lock");
    const deployLock = installer.indexOf("exec 9>/opt/brain/.deploy.lock");
    const accountMutation = installer.indexOf("\nusermod \\\n");
    const groupGate = installer.indexOf(
      'brain-deploy group must be unprivileged',
    );
    const userCreate = installer.indexOf("\n  useradd \\\n");
    const firstHelperInstall = installer.indexOf(
      '"$repo_root/ops/deploy-puller.sh"',
    );
    expect(inactive).toBeGreaterThan(-1);
    expect(pollLock).toBeGreaterThan(-1);
    expect(deployLock).toBeGreaterThan(pollLock);
    expect(inactive).toBeGreaterThan(deployLock);
    expect(installer.indexOf(".deploy-transaction.json")).toBeGreaterThan(
      deployLock,
    );
    expect(installer.indexOf(".deploy-transaction.json")).toBeLessThan(inactive);
    expect(installer.indexOf(".deploy-pending.json")).toBeGreaterThan(deployLock);
    expect(installer.indexOf(".deploy-pending.json")).toBeLessThan(inactive);
    expect(accountMutation).toBeGreaterThan(inactive);
    expect(groupGate).toBeGreaterThan(inactive);
    expect(groupGate).toBeLessThan(userCreate);
    expect(firstHelperInstall).toBeGreaterThan(deployLock);
    expect(installer).toContain("--groups ''");
    expect(installer).toContain("passwd --lock brain-deploy");
    expect(installer).toContain(
      'brain_deploy_uid" == "$brain_uid"',
    );
    expect(installer).toContain(
      '"$brain_deploy_gid" == "$sensitive_gid"',
    );
    expect(installer).toContain(
      "for trusted_dir in / /etc /etc/brain /etc/systemd/system /opt /opt/brain",
    );
    expect(installer).toContain(
      '"$bin_dir" /opt/brain/incoming /opt/brain/releases',
    );
    expect(installer).toContain('assert_safe_destination "$destination"');
  });

  it("rejects numeric fetch aliases of every Brain owner or group", async () => {
    const puller = await source("deploy-puller.sh");
    const fetchUid = puller.indexOf('fetch_uid="$(id -u "$fetch_user")"');
    const brainUid = puller.indexOf('brain_uid="$(id -u brain)"', fetchUid);
    const brainGroups = puller.indexOf(
      'brain_sensitive_gids <<<"$(id -G brain)"',
      brainUid,
    );
    const uidGate = puller.indexOf(
      '"$fetch_uid" != "$brain_uid"',
      brainGroups,
    );
    const gidLoop = puller.indexOf(
      'for sensitive_gid in "${brain_sensitive_gids[@]}"',
      uidGate,
    );
    const gidGate = puller.indexOf(
      '"$fetch_gid" != "$sensitive_gid"',
      gidLoop,
    );
    const transient = puller.indexOf("systemd-run", gidGate);
    expect(fetchUid).toBeGreaterThan(-1);
    expect(brainUid).toBeGreaterThan(fetchUid);
    expect(brainGroups).toBeGreaterThan(brainUid);
    expect(uidGate).toBeGreaterThan(brainGroups);
    expect(gidLoop).toBeGreaterThan(uidGate);
    expect(gidGate).toBeGreaterThan(gidLoop);
    expect(transient).toBeGreaterThan(gidGate);
  });

  it("validates the installed manual tree verifier before remote authority", async () => {
    const manual = await fs.readFile(
      path.join(process.cwd(), "scripts", "deploy-release.sh"),
      "utf8",
    );
    const preflight = manual.indexOf("<<'PREFLIGHT'");
    const verifierFile = manual.indexOf(
      'test -f "$base/bin/extract_release.py"',
      preflight,
    );
    const verifierOwner = manual.indexOf(
      'stat -c \'%u:%a\' "$base/bin/extract_release.py"',
      verifierFile,
    );
    const python = manual.indexOf("command -v python3", verifierOwner);
    const remote = manual.indexOf("<<'REMOTE'", python);
    expect(verifierFile).toBeGreaterThan(preflight);
    expect(verifierOwner).toBeGreaterThan(verifierFile);
    expect(python).toBeGreaterThan(verifierOwner);
    expect(remote).toBeGreaterThan(python);
  });

  it("validates the deploy credential parent chain before LoadCredential", async () => {
    const puller = await source("deploy-puller.sh");
    const trust = puller.indexOf('env_file="$(assert_root_chain "$env_file")"');
    const config = puller.indexOf('assert_root_config "$env_file" 600');
    const credential = puller.indexOf('LoadCredential=deployer-env:$env_file');
    expect(trust).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(trust);
    expect(credential).toBeGreaterThan(config);
  });

  it("keeps the root service free of token environment and identity capabilities", async () => {
    const service = await source("brain-deploy-puller.service");
    expect(service).not.toContain("EnvironmentFile=");
    expect(service).not.toMatch(/CAP_KILL|CAP_SETUID|CAP_SETGID/);
  });

  it("never takes an unverified active-release no-op", async () => {
    const puller = await source("deploy-puller.sh");
    const activeNoOp = puller.indexOf(
      'if [[ "$active_commit" == "$current_main" ]]; then',
    );
    const provenanceGate = puller.indexOf(
      'fail "active managed release provenance is invalid"',
      activeNoOp,
    );
    const verifiedReplacement = puller.indexOf(
      "active release lacks provenance; preparing a verified replacement",
      activeNoOp,
    );
    const healthyNoOp = puller.indexOf(
      "is already active and healthy",
      activeNoOp,
    );
    expect(activeNoOp).toBeGreaterThan(-1);
    expect(provenanceGate).toBeGreaterThan(activeNoOp);
    expect(provenanceGate).toBeLessThan(healthyNoOp);
    expect(verifiedReplacement).toBeGreaterThan(healthyNoOp);
  });

  it("creates reserved release metadata exclusively instead of following artifact links", async () => {
    const puller = await source("deploy-puller.sh");
    const reservedGate = puller.indexOf(
      "release artifact contains a reserved metadata path",
    );
    const writer = puller.indexOf('"$runtime" "$metadata_writer"', reservedGate);
    const immutableGate = puller.indexOf(
      "release metadata was not created as an immutable root file",
      writer,
    );
    expect(reservedGate).toBeGreaterThan(-1);
    expect(writer).toBeGreaterThan(reservedGate);
    expect(immutableGate).toBeGreaterThan(writer);
    expect(puller).not.toContain(
      'cp -- "$candidate" "$stage/deploy-provenance.json"',
    );
  });

  it("asks the resolver for the source's target and moves shipped metadata aside before the reserved gate", async () => {
    const puller = await source("deploy-puller.sh");
    expect(puller).toContain('current_main="$(run_resolver target)"');
    const targetCall = puller.indexOf('current_main="$(run_resolver target)"');
    const targetWait = puller.indexOf(
      '[[ "$resolver_status" -eq 75 ]]',
      targetCall,
    );
    const targetQuietExit = puller.indexOf("exit 0", targetWait);
    const targetHardFail = puller.indexOf(
      '[[ "$resolver_status" -eq 0 ]] || exit "$resolver_status"',
      targetCall,
    );
    const targetValidate = puller.indexOf(
      '[[ "$current_main" =~ ^[0-9a-f]{40}$ ]]',
      targetCall,
    );
    expect(targetWait).toBeGreaterThan(targetCall);
    expect(targetQuietExit).toBeGreaterThan(targetWait);
    expect(targetHardFail).toBeGreaterThan(targetQuietExit);
    expect(targetValidate).toBeGreaterThan(targetHardFail);
    const verifiedTree = puller.indexOf(
      'python3 "$extractor" verify-tree "$stage" >/dev/null',
    );
    const moveAside = puller.indexOf(
      'mv -- "$stage/release.json" "$shipped_release_metadata"',
      verifiedTree,
    );
    const reservedGate = puller.indexOf(
      "release artifact contains a reserved metadata path",
      moveAside,
    );
    const writer = puller.indexOf(
      '"$candidate" "$stage/deploy-provenance.json" "$shipped_release_metadata"',
      reservedGate,
    );
    expect(verifiedTree).toBeGreaterThan(-1);
    expect(moveAside).toBeGreaterThan(verifiedTree);
    expect(reservedGate).toBeGreaterThan(moveAside);
    expect(writer).toBeGreaterThan(reservedGate);
    const resolver = await source("resolve-deploy-candidate.mjs");
    expect(resolver).toContain('"BRAIN_DEPLOY_SOURCE"');
    expect(resolver).toContain('"BRAIN_DEPLOY_RELEASE_TAG"');
  });
});
