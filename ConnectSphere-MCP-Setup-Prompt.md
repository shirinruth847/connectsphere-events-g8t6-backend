# ConnectSphere MCP Setup Prompt

Give this prompt to each developer's coding agent. It checks existing connections before installing anything and configures project-scoped Supabase write access for development. Setup verifies permissions; application migrations, test accounts and seed data are created during the relevant development task.

Updated: 22 September 2026 · Access policy: every developer uses their own authenticated, write-enabled connection to the ConnectSphere development project.

---

Set up and verify the MCP connections for my coding agent so I can work on the ConnectSphere project.

Perform installation and configuration where you have access. Do not stop at generic instructions. Ask me only for information you cannot discover, authentication actions I must complete, or permissions required by this environment. Complete independent setup work while another connection is blocked.

## Project context

- React frontend and Node.js monolithic backend.
- Two separate Git repositories, one for frontend and one for backend.
- Supabase provides the database and authentication.
- All developers are permitted to write development data and apply task-related schema migrations in the project specified below; effective permissions must still be verified for each connection.
- Jira contains development tasks, acceptance criteria and test-case specifications.
- This task is MCP setup and connection verification only.

## Project details

- Jira site: https://yvery.atlassian.net
- Jira project key: SPM
- Example Jira issue for verification: SPM-32
- Supabase development project reference: rvwiflsedoujspmzfrbq

If a placeholder is unfilled, complete the independent setup work first, then ask for the missing value. Do not guess a Jira project or connect Supabase without a project scope. Do not put credentials in these placeholders.

## 1. Identify my environment

Determine:

- The coding agent and MCP client actually being used.
- Operating system, shell, and whether execution is native, WSL, a container or remote.
- Installed Node.js/npm versions.
- Existing MCP connections and applicable configuration locations.

Do not confuse VS Code's own MCP configuration with the configuration used by an agent extension inside VS Code.

Use the installed client's help and current official documentation to determine the correct configuration format and commands. Use the client configuration for the environment that will actually run the agent and servers.

Client references, as applicable:

- Codex: https://developers.openai.com/codex/mcp
- Claude Code: https://code.claude.com/docs/en/mcp
- For other clients, use their official MCP setup documentation.

## 2. Check existing MCP connections before installing

For each requested server—Jira/Atlassian, Playwright, Context7, Sequential Thinking and Supabase:

- Inspect the MCP tools available in the current session and the client's applicable configuration.
- Identify equivalent connections by endpoint, package and exposed capabilities, not just the server name. An existing connection may use a different name.
- Never display stored credentials or secret configuration values.
- Perform the verification in each server section before deciding whether installation is necessary. Supabase additionally requires checking effective write/schema permissions and, when feasible, an isolated rolled-back capability probe.

Classify each server and take the appropriate action:

| Existing state | Required action |
| --- | --- |
| Connected and verification succeeds | Reuse it. Do not reinstall, rename, duplicate or unnecessarily update it. |
| Configured but disabled or disconnected | Determine the cause, enable/reconnect where permitted, and verify again. |
| Configured but authentication is missing or expired | Start the supported authentication flow. Preserve the existing connection. |
| Connected to the wrong project or using unsuitable access settings | Explain the mismatch. Configure a separate correctly scoped connection if needed, preserving unrelated connections. |
| Configuration is invalid or incompatible | Back up the affected configuration, make the smallest necessary repair, and verify again. |
| No equivalent connection exists | Install and configure the official server. |

For Jira, verify access to the specified project and example issue.

For Supabase, verify the supplied development project and write-enabled configuration. If the existing ConnectSphere connection uses `read_only=true`, removing that restriction is authorised by this setup task. Preserve its name, authentication, project scope and unrelated settings; do not duplicate it just to enable writes. A successful read or an edited URL does not prove write access. Preserve unrelated/read-only monitoring connections used for other purposes.

Preserve unrelated settings and servers. Make a private local backup before directly editing an existing configuration, and protect backups that contain credentials.

Prefer user-level configuration where supported so connections work across both repositories. Check for project-level overrides that could hide or replace them. If project configuration is necessary, explain how each repository will receive the connection without duplicating secrets.

Do not install MCP packages into application dependencies. Do not modify application code, existing application data, Jira issues or repository instruction files during setup. The only permitted database mutation in this setup is the isolated capability probe described in section 7, which must be rolled back. Do not commit or push changes, apply application migrations, or create user accounts/seed data as part of onboarding.

Configure only the five servers below. Reuse verified existing connections and skip their installation steps.

## 3. Connect Jira through the official Atlassian MCP server

Official guide:
https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/

Hosted endpoint:
https://mcp.atlassian.com/v2/mcp

Use the supported remote HTTP connection and start the client's authentication flow so I can sign in with my own Atlassian account.

Verify that this connection supports our Jira deployment. If it requires organisational approval or our deployment is unsupported, explain the exact blocker.

For verification, read only the specified project and example issue. Retrieve its description, acceptance criteria and linked test cases where available.

If test cases are in custom fields or a separate test-management app and are inaccessible, identify that gap. Do not claim complete Jira access based only on reading the issue title. Do not create comments, change issue status or edit acceptance criteria during verification.

## 4. Install Playwright MCP

Official source:
https://github.com/microsoft/playwright-mcp

Official package: `@playwright/mcp`

Configure it using the method supported by my client. Check runtime and browser requirements and install the necessary browser if missing, within the environment's permissions.

Use a separate testing browser context, preferably isolated. Do not attach to my personal browser session.

Verify by opening a harmless page, reading its title or accessibility snapshot, and closing the test session. This check should not depend on ConnectSphere already running.

Install the MCP connection requested here. Do not silently substitute a CLI-only integration. Installing Playwright MCP is separate from adding automated Playwright tests to the application, which is outside this setup task.

## 5. Connect Context7 MCP

Official source:
https://github.com/upstash/context7

Hosted endpoint:
https://mcp.context7.com/mcp

Use the current documented MCP setup for my client. Reuse a working connection if present.

If authentication or an API key is needed, guide me through secure local configuration using the client's supported credential or environment-variable mechanism. Do not ask me to paste secrets into chat. Verify current authentication/header requirements against the official documentation.

Verify by resolving a library used by the project, such as React, and retrieving a small relevant documentation result. Match the installed library version where available. If that version is unavailable, report the limitation rather than assuming another version is equivalent.

## 6. Install Sequential Thinking MCP

Official source:
https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking

Official package: `@modelcontextprotocol/server-sequential-thinking`

Configure the local server using my client's supported process-launch method. Account for Windows or WSL differences where applicable.

Verify that the tool is discoverable and accepts a small, non-sensitive test call. Report whether the call succeeded; a detailed reasoning transcript is unnecessary.

## 7. Connect Supabase MCP with development write access

Official guide:
https://supabase.com/docs/guides/ai-tools/mcp

Use this hosted endpoint, scoped to the ConnectSphere development project:

```text
https://mcp.supabase.com/mcp?project_ref=rvwiflsedoujspmzfrbq&features=database,docs
```

Omit `read_only=true`. Quote the full URL correctly in shell commands. Keep `project_ref` and the `database,docs` feature restriction; account-wide, branching or deployment capabilities are not needed merely to write data. Check client/project overrides, reconnect/reload and reauthenticate if required.

Use the supported browser authentication flow with my own Supabase account. Do not request a database password, application service-role key or teammate credential for the MCP connection. If the standard flow is unsupported, report the limitation and the supported alternative.

### Verify the actual capability

1. Confirm the configured target is `rvwiflsedoujspmzfrbq`, the designated development project, and authentication succeeds.
2. Inspect table/schema metadata and migration history. Identify actual application schemas/tables rather than assuming everything is in `public`. An empty migration list does not mean the database is empty.
3. Check the effective database role, transaction read-only status, schema USAGE, relevant application-table INSERT/UPDATE/DELETE privileges, and required sequence privileges where applicable. Check schema CREATE and ownership/ALTER rights for intended migrations separately. These are capability checks, not instructions to grant privileges.
4. If the MCP SQL tool supports a complete transaction in one call and the target development schema allows CREATE, use a uniquely named ordinary scratch table in that schema for CREATE/INSERT/UPDATE/DELETE and end the same call with ROLLBACK. Do not use existing application/Auth tables, triggers, sequences or external side effects for this probe. Verify the scratch object is absent afterward. A temporary-table-only test does not establish application-schema write access. If the probe cannot be safely performed, report metadata-based permissions and mark execution unverified.
5. Clearly distinguish configuration checked, metadata privileges confirmed and actual write execution verified. A scratch-table probe demonstrates those operations on the probe table; it does not establish write/ALTER access to every existing table. Report actual-table privileges separately.

Database-level CREATE and membership in `pg_write_all_data` are not blanket prerequisites. Do not request them solely because a diagnostic returned false. Data writes may work even if schema changes remain blocked; report each capability independently.

If access is denied, distinguish MCP read-only configuration, expired authentication, account/project authorisation and database-object privileges. Identify the exact failing operation and the supported change the project owner must make. Do not self-elevate, grant broad roles, disable RLS, change application role policies or remove project scoping to get past the error. Continue independent server setup while an owner action is pending.

### Development use after setup

During an authorised development task, agents may use this connection to perform necessary development-data writes and apply migrations. Existing task authorisation covers routine required operations; do not ask for permission again merely because a database write is involved. Keep schema SQL in the backend repository's versioned migrations and apply it through the supported migration mechanism, preserving migration history. Coordinate overlapping changes on the shared development database. Broad resets, unrelated deletions and production changes require their own explicit scope.

Test data must be synthetic and reproducible, with a developer/run namespace and cleanup limited to the records created by that task. Create login-capable test accounts using the application's signup flow or the supported server-side Supabase Auth Admin API under the task's authorisation; a profile row alone is not a login account. MCP SQL write access does not by itself verify Auth Admin access. Do not directly insert/delete Auth-managed records through raw SQL. If an Auth Admin credential is required, configure it privately on the server/test runner, never in React or chat. No accounts or fixtures are created during this setup task.

MCP development access does not replace application runtime configuration or change end-user role/relationship permissions.

## 8. Verify and report

For newly installed local packages, prefer a compatible stable version and record the version used. Follow current official documentation if it differs from an example in this prompt. Keep working existing versions unless a concrete compatibility problem requires a change.

Never print authentication tokens, secret headers or full configuration files containing credentials. Do not weaken client approval settings or bypass access controls to finish setup.

After configuration:

- Reload/reconnect servers where the client supports it.
- Confirm tool discovery and perform the verification calls above.
- Treat "configuration saved," "authenticated," "read verified," "write privileges confirmed" and "write execution verified" as different states.
- If a client restart is necessary, finish all possible setup first, then give precise restart instructions and a short continuation prompt.
- Continue setting up other servers when one is blocked.
- Do not claim a connection works unless its verification call succeeds.

Label each connection as one of:

- Reused and verified
- Reconnected and verified
- Repaired and verified
- Newly configured and verified
- Configured but awaiting authentication/restart
- Blocked, with the specific reason

Finish with a table containing:

| Server | Outcome | Configuration scope/location | Version or hosted endpoint | Authentication status | Verification result | Remaining user action |
| --- | --- | --- | --- | --- | --- | --- |
| Jira/Atlassian | | | | | | |
| Playwright | | | | | | |
| Context7 | | | | | | |
| Sequential Thinking | | | | | | |
| Supabase | | | | | | |

For Supabase, additionally report project reference, effective role/read-only status, existing application-table DML permissions, schema-change permissions, probe result/rollback cleanup, and Auth provisioning capability as verified or not checked. Do not label a read-only connection fully verified for this write-enabled setup. Mark partial access explicitly, for example “data writes available; schema migrations blocked”.

Use "not required" for authentication where appropriate. Redact any secret-bearing endpoint parameters.

Also explain how to check that the connections are available when working in either Git repository. State whether that was actually tested in both repositories or remains a follow-up check.

### Credential handling

* Existing credentials stored in private local configuration are expected. Their presence alone does not mean they have been exposed.
* Inspect only the configuration needed for setup. Do not print complete configuration files, API keys, tokens, passwords, secret headers or credential-bearing URLs.
* When showing configuration or errors, replace secret values with `[REDACTED]`. Report only whether the credential is present and whether authentication succeeds.
* Never ask me to paste credentials into chat. Guide me to enter them locally or through the supported authentication flow.
* If a credential was previously displayed only in this private agent session, briefly note the possibility of retention in transcripts or logs, then continue setup. I understand this risk and do not want repeated rotation reminders.
* Do not rotate, revoke or replace working credentials without my explicit instruction.
* If you discover a separate exposure in a public repository, shared file or externally accessible log, report its location without repeating the secret and recommend the appropriate corrective action.
* Keep credentials out of Git commits and setup reports.
