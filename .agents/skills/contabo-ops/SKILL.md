---
name: contabo-ops
description: Inspect and operate this food diary's Contabo VPS, SSH access, firewall, Docker Compose deployment and live PostgreSQL. Use for infrastructure work, not diary code or ChatGPT plugin packaging.
---

# Contabo operations

Read the current phase in [README.md](../../../README.md), the approved portion in [implementation-plan.md](../../../docs/implementation-plan.md), and [AGENTS.md](../../../AGENTS.md). This skill guides development operations; it does not approve implementation, deployment or provisioning.

## Establish the target

- Confirm this project's Contabo account and instance ID, hostname, SSH user/alias, server checkout, Compose project/file and data volumes before touching a server. Never reuse another project's instance identifiers or assume its configuration applies here.
- Check which tools and authenticated access are available in this session without printing credential configuration. Local CLI/SSH setup does not establish access from a cloud session. `cntb` is optional for provider operations; deployment uses SSH and Compose.
- Scope provider mutations to the confirmed instance. Existing authorization covers its stated scope; purchasing, reinstalling/cancelling an instance, deleting volumes or destructive database changes require authorization for that action. Missing access blocks dependent remote work, not independent local work.

## Inspect before changing

- Start with the target's running commit and checkout state, Compose service/health status, disk and memory, and bounded logs. Keep evidence free of diary text and account identifiers.
- Never dump `.env`, Firebase service-account files, `~/.cntb.yaml`, expanded Compose environment or unfiltered container inspection. These can expose secrets.
- Before SSH or firewall changes, keep the working session open and verify a new key-authenticated session and recovery access. Recheck connectivity after the change.
- For ad-hoc database diagnostics, use a read-only transaction, bounded result sets and a local timeout, such as `BEGIN READ ONLY; SET LOCAL statement_timeout = '30s'; … ROLLBACK;`. End the transaction promptly. This diagnostic limit is not an import or migration limit.
- Check waiting locks when a migration stalls; do not automatically terminate database sessions or roll back the schema.

## Execute and verify the approved work

- Use the actual implemented repository commands and Compose targets. Do not invent deployment helpers or health routes. Deploy the reviewed `main` commit only within the approved implementation portion.
- Keep secrets in the approved runtime settings: `.env` root-only (`0600`), and `.secrets/firebase-service-account.json` owned `root:1000` with mode `0440`, because the app container runs as uid 1000 and must read it. Preserve the v1 scope: no backup service, Terraform or other infrastructure copied from the example project.
- Verify the running commit, service health and public HTTPS after a deployment; check restart persistence when relevant. CI or a successful SSH command alone does not prove deployment.
- Keep target inventory and operational evidence in private operator records. Record only sanitized, non-identifying test results in [research.md](../../../docs/research.md). Report the verified commit and outcome, or the concrete missing access/target information. Stop when the authorized outcome is verified or dependent work is blocked; do not expand the operation.

The official [Contabo CLI](https://github.com/contabo/cntb) and [Compose production guide](https://docs.docker.com/compose/how-tos/production/) establish capabilities, not this project's access or deployed state. Research dates and limits belong in the research register.
