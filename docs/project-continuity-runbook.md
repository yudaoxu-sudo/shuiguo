# Fruit Store Project Continuity

## Boundaries

- Active Codex conversation workspace: `/Users/xuyufan/Documents/shuiguo`
- Canonical source repository: `/Users/xuyufan/Documents/shuiguo`
- Legacy conversation workspace alias: `/Users/xuyufan/Documents/New project`
- Git remote: `git@github.com:yudaoxu-sudo/shuiguo.git`
- Production deployment: user `ubuntu`, host `43.134.121.205`
- Production path: `/opt/fruit-store-report-bot`
- SSH identity path: `~/.ssh/shuiguo_server_ed25519`
- Project memory: `/Users/xuyufan/Documents/Codex/projects/fruit-store-automation.md`

The continuity configuration uses the canonical source repository as
`project_root`, so thread selection, checkpoints, resume packets, and Git
verification resolve against the same repository. `thread_roots` retains the
legacy workspace only for matching its existing unarchived tasks; it is never
used as the checkpoint or Git root.

## Recovery

1. Run the continuity `resume` and `audit` commands from the latest handoff.
2. Read only the context and health files listed in the resume packet.
3. Inspect `git -C /Users/xuyufan/Documents/shuiguo status --short --branch`.
4. Verify the server service, cron daemon, login health, and listener health.
5. Continue the newest unresolved user request without replaying completed work.

## Production Verification

Use fixed, secret-free paths. Do not print `.env`, browser profiles, cookies,
tokens, webhook values, account credentials, or private-key contents.

```bash
ssh -i ~/.ssh/shuiguo_server_ed25519 \
  -o BatchMode=yes ubuntu@43.134.121.205 \
  'cd /opt/fruit-store-report-bot &&
   git status --short --branch &&
   systemctl is-enabled fruit-store-listener.service &&
   systemctl is-active fruit-store-listener.service &&
   systemctl is-active cron &&
   pnpm healthcheck &&
   pnpm login-healthcheck'
```

For a full data-path check without sending DingTalk:

```bash
ssh -i ~/.ssh/shuiguo_server_ed25519 \
  -o BatchMode=yes ubuntu@43.134.121.205 \
  'cd /opt/fruit-store-report-bot &&
   NO_DINGTALK=1 REPORT_FAILURE_ALERTS=false pnpm report'
```

## Current Operating Rules

- Formal report begins at 22:05 Asia/Shanghai and retries until 23:50.
- A successful scheduled report writes `output/scheduled-report-state.json`.
- `@666` is an independent live report and does not consume the nightly state.
- Zhimadi login health runs every two hours and requests local ddddocr repair.
- Lemeng offline revenue uses month-to-date revenue excluding vouchers.
- Douyin online revenue uses settled plus pending merchant receipt from the
  Laike month summary; those amounts already include platform deductions.
- Only Lemeng offline revenue receives the configured 0.30% fee.
- Store rows are ordered by gross-profit amount descending.

## Safety

- Never add `.env`, output profiles, login state, screenshots containing
  credentials, private keys, or access tokens to Git or continuity artifacts.
- The old conversation contains user-supplied credentials. Resume from the
  compact packet and project memory; never import or replay the raw rollout.
