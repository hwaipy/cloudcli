# Project-level strict file isolation

Strict isolation is selected when creating a new project. The project database stores `strict_file_isolation`; API clients cannot opt a strict project out at execution time. Existing projects retain their current mode. This initial implementation supports Linux backends with a local Unix-socket Rootless Docker engine, seccomp and delegated cgroup v2 resource controls. It supports Codex App Server, including streaming, steering, queued/scheduled runs, continuation, edits and forks. Other providers are rejected for strict projects.

## Execution boundary

Each project gets a managed container and a private Docker volume. Only the chosen project directory is bind mounted read/write. Its canonical absolute path is preserved inside the container so Codex history and tools do not require path translation. System and home roots, symlinked roots, nested mounts, external hard links, sockets, devices, FIFOs and external Git worktree metadata are rejected during preflight. Internal hard links are allowed when all links are inside the project. Symlinks resolve in the container namespace, without making their host targets visible.

The other bind mount is a read-only directory containing a narrow HTTP egress proxy socket. No Docker socket, host home, main Codex home, CloudCLI database, Hub registration key or host process environment is exposed. The container runs as UID 0 inside a Rootless user namespace, mapped to the backend’s ordinary host UID. Its private system layer is writable for apt. It drops all capabilities and restores only CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETUID, SETGID, SETFCAP and KILL within that namespace. It keeps `no-new-privileges`, Docker's default seccomp profile, CPU/memory/PID limits and private temporary directories.

The container has `--network none`. A local proxy forwarder relays HTTP/HTTPS to the backend over the Unix socket. The backend resolves and pins public addresses for arbitrary destinations, denies private/loopback/link-local/reserved destinations and supports HTTP 80 and HTTPS CONNECT 443. Fake-IP DNS is resolved through authenticated public DoH before applying those checks. A fixed list of OpenAI-operated HTTPS service hosts may use the trusted host TUN’s fake-IP route after public DNS validation, so domain-based VPN routing remains functional. Container input cannot extend that list. Direct TCP networking, SSH and private network services are intentionally unavailable in this first version. Container root access or a Codex “full access” permission selection does not expand the outer mounts or network policy.

The initial strict-project UI exposes chat, files and the isolated terminal. Native-host Git, worktree and TaskMaster workflows are rejected; Git can be used in the isolated terminal, preventing project-controlled hooks from executing on the host. Browser and plugin tabs are not offered for strict projects. A project terminal also executes inside the same container. Its active lease prevents idle shutdown. Idle Codex connections close using the existing App Server lifecycle; unused containers stop after a further ten minutes. Background programs inside an idle container may be stopped with it. Startup detects a previous dead backend owner and restarts that project's container to clear orphaned processes. A live second backend cannot take over the same project state.

Docker/container-kernel vulnerabilities and a trusted host administrator changing mounts or files remain outside this boundary. Selected project contents and deliberately injected credentials are accessible to the project processes. This is execution isolation, not a guarantee that an agent cannot transmit the project data through permitted network destinations. Normal, non-isolated projects retain their existing host access.

## Credentials and history

Only the selected provider configuration and its required key/header values are copied. `auth.json` can seed a ChatGPT file-based login; keychain-only authentication is not silently exported. API keys from the provider's configured environment key are converted into private provider configuration. Secrets are piped over stdin into the private volume, never written into image layers, Docker arguments, Docker inspect environment values or logs. A source fingerprint prevents every turn from overwriting refreshed container credentials. Updated source credentials are imported when no execution lease is held. Independent copied ChatGPT logins can require renewed source credentials if the account revokes a refresh token; changes are not blindly written back over the backend's main auth file.

Codex's writable home lives in a Docker volume, not a host state bind mount. After turns and forks, a bounded export of regular transcript/index files creates atomic host-only snapshots. Symlinks are never extracted onto the host. This prevents container-controlled auth, PID, or history files from redirecting privileged host writes. Watchers/indexing consume these snapshots, check their project identity, and constrain inherited history to the same private Codex home. Attachments are copied individually after upload ownership validation; the global upload store is never mounted.

Snapshots currently have a 128 MiB per-export limit and 4,000-file limit. Private volumes remain intact if export fails. A fresh container can resume from the same volume. Project creation failure removes the newly created managed runtime and project row; it does not delete the selected workspace. Archiving preserves the runtime data. Permanent project deletion removes its managed container and volume before deleting application records.

## Writable Rootless runtime (v2)

Only the isolation adapters use the dedicated endpoint from `CLOUDCLI_ISOLATION_DOCKER_HOST`, defaulting to `unix:///run/user/<backend UID>/docker.sock`. The regular Docker CLI context and system daemon are unchanged. A rootful endpoint is rejected even if configured explicitly. Resource limits must be enforceable through systemd cgroup v2. There is no fallback to rootful Docker or native execution.

On Linux, install Docker CE rootless extras plus `uidmap`, `dbus-user-session`, `slirp4netns` and (where needed) `fuse-overlayfs`. Run `scripts/setup-project-isolation-rootless.sh` as the backend user and enable that user’s lingering for startup. The setup tool keeps its CLI context under a separate `DOCKER_CONFIG`, leaving existing containers and the ordinary CLI context alone. No global unprivileged-user-namespace restriction is disabled.

Installed apt packages live in each project container’s writable layer. They survive normal container stop/start, idle shutdown and backend restarts. Deliberately removing/replacing the container resets installed system software; the separate Codex volume and project files remain. Image/policy mismatch fails visibly instead of deleting an environment automatically. Back up the container layer before an intentional image upgrade. A project root process can alter its own tools and credentials, and downloaded packages run their installation scripts with that same project-local authority. Rootless mitigates host-root consequences but does not eliminate runtime/kernel vulnerability risks.

On first v2 access after the old backend has exited, an existing v1 rootful project is validated, stopped and its private volume copied through stdin into a Rootless volume using temporary helpers with no project/host-state binds or network. Ownership is translated to namespace root. The original stopped container and volume remain as rollback copies. Failed copies remove the incomplete destination. A live previous backend prevents takeover. If an existing credential marker has no recoverable volume, startup fails rather than creating an apparently empty history. The legacy source endpoint defaults to `unix:///var/run/docker.sock` and can be set with `CLOUDCLI_ISOLATION_LEGACY_DOCKER_HOST`.

Credential source tracking separately fingerprints auth and configuration. Changing runtime instructions does not overwrite refreshed private auth when the source credentials themselves are unchanged. The v1 combined fingerprint is recognized during migration. Retained v1 rollback volumes are backups: remove them manually after accepting the migration, including if deleting a project permanently.

## Operations

- `GET /api/projects/isolation-capabilities` reports backend support.
- `POST /api/projects/create-project` accepts `strictFileIsolation: true`.
- The first strict project prepares `cloudcli-codex-isolated:v2-<CLI version>`. CLI binaries are copied from the backend's installed official package, keeping them at exactly that version. The base image supplies Node, Git, Python, curl and ripgrep. Codex can install system packages directly with `apt-get`, without sudo. Apt uses the managed egress proxy. Packages requiring host kernel modules, privileged devices or a host service manager remain outside the container’s scope.
- Set `CLOUDCLI_ISOLATION_APT_MIRROR=tuna` on deployments that need the Tsinghua signed-Debian mirror during image preparation. The default uses Debian's official CDN. No TLS or package-signature verification is disabled.
- Private snapshot state defaults to `~/.cloudcli/isolated-projects`; `CLOUDCLI_ISOLATION_STATE_DIR` can select a dedicated backend-owned directory.
- Container names are `cloudcli-isolated-<project ID>`; volumes are `cloudcli-codex-state-<project ID>`. They are labeled with their owning project ID. Do not share this directory or its Docker engine between mutually untrusted administrative processes.
- Resource defaults are 2 CPUs, 2 GiB memory and 256 processes, with private 512 MiB temporary and home filesystems. Project/volume disk consumption still follows the host filesystem's quota policy.

The feature does not require a Hub code change. Deploy the frontend and backend artifacts; the backend must be manually restarted to apply the database migration and expose capability detection. Never auto-restart conversation backends during deployment.

## Verification

`server/modules/project-isolation/tests/` covers persisted policy, conflicting request paths, unsafe mount roots, external hard links and private network rejection. Related tests cover creation rollback, strict file APIs, provider dispatch, App Server lifecycle and the creation checkbox.

On a Linux backend, `node scripts/verify-project-isolation.mjs <staged dist-server path>` uses a separate temporary SQLite DB, disposable projects/containers/volumes and the configured credentials. Select a currently available model with `ISOLATION_VERIFY_MODEL`. It verifies real filesystem writes, outside-file denial, private egress denial, public HTTPS, a real Codex turn, a recreated container's continuation, forks and exported history. It never restarts a business backend. Set `ISOLATION_KEEP_FAILED=1` only while debugging; it retains credential-bearing private volumes, which must be removed afterward.

## Initial deployment verification (2026-11-01)

The local Lima Ubuntu backend was tested using separate temporary databases and runtime state. Both the configured API-key provider and a copied ChatGPT file login passed real Codex App Server execution with project file writes, container recreation and continuation, fork creation, exported history indexing and inherited-history reading. Filesystem probes denied sibling files, outside symlink targets, the host SSH directory, the Docker socket and writes to the old read-only system image. That last restriction is superseded by the v2 writable Rootless policy below. Public HTTPS succeeded and the private metadata-address HTTP probe was rejected. Disposable credential-bearing test volumes and temporary login copies were removed afterward. Production backends were not restarted by the deployment.

## Rootless apt verification (2026-11-02)

The Ubuntu VM has a parallel Rootless Docker daemon and its original system Docker context remains unchanged. The isolated fixture installed KiCad, ngspice and Gmsh using apt and verified namespace-root mapping and denial of host sibling files, outside symlinks, SSH files, Docker sockets and private metadata HTTP access. `scripts/verify-isolation-migration.mjs` verifies synthetic private auth/history migration across the two engines, translated ownership, and preservation of the stopped legacy rollback copy. No business conversation is used as a test fixture.

The v2 live App Server fixture also makes Codex install `jq` itself, confirms software survives normal stop/start, and checks that a configuration-only update preserves a synthetic refreshed-auth sentinel in the private volume. A separate fixture removes/recreates its container to verify history continuation; installed packages are intentionally reset by that explicit destructive action.

## Migration stream correction (2026-11-02)

A production v1 volume exposed an archive-tail race: GNU tar can finish extracting before the Node-to-Docker stdin pipeline has consumed all trailing padding, causing `ERR_STREAM_PREMATURE_CLOSE`. The import helper now drains stdin after tar exits while preserving tar’s exit status. Copy helpers have explicit temporary names and are removed before failed destination-volume cleanup. An 8 MiB fixture reproduces the failure with the previous implementation and passes with the corrected importer. The affected production volume was copied using the corrected importer; SHA-256 file manifests and symlink targets matched across all 72 entries. The original v1 volume was retained. No business turn was sent or resent for this verification.

## Snapshot activity and archiving correction (2026-11-02)

Old exports rewrote every host snapshot on every completed turn, changing mtimes even for other conversations whose bytes had not changed. The session indexer interpreted those artificial timestamps as new activity and reactivated app-archived sessions. Exports now include each source file's mtime, publish only changed bytes, set source timestamps before atomic rename, and serialize publication per project. Unchanged files retain both inode and mtime. The existing rule that real new transcript activity can reactivate a session is unchanged. Regression tests cover snapshot publication, archive/reindex across two sessions, invalid paths/timestamps, and a real Docker export followed by archive and re-export.

## Optional host SSH signing for strict containers (2026-11-02)

Explicit operator opt-in can delegate the backend's authorized host SSH agent to strict projects. `scripts/setup-isolation-ssh.sh` installs `cloudcli-isolation-ssh.service` as the ordinary backend user, with the source agent Unix socket in a private EnvironmentFile. It leaves private key files on the original host. This is a backend-wide credential grant to strict projects using that backend, including projects belonging to other UI accounts; it is not a per-account SSH credential store. Those keys can authorize remote accounts with privileges beyond the local workspace. Local mount isolation cannot constrain what an authorized remote account permits.

The broker exposes `ssh-agent.sock` and `ssh-proxy.sock` through the already mounted read-only `.egress` directory. No new host bind mounts or container recreation are needed, preserving installed software. The agent relay parses bounded SSH agent frames and permits only key enumeration, signing and OpenSSH session binding. Add/remove identity, lock/unlock, unknown extensions and malformed/oversized requests are refused before forwarding. Payloads and signatures are not logged. The raw host agent socket, private keys and Docker socket remain unmounted.

SSH uses a managed ProxyCommand over the egress Unix socket, with real public-IP validation and any valid TCP port (1–65535). Loopback, private and link-local targets remain blocked. This adds an explicit public SSH capability when the broker is enabled; the general HTTP proxy's default port policy is unchanged. Host-key checking is not disabled and no remote host is automatically trusted.

Startup prepares existing running policy-v2 containers, installing `openssh-client` if absent and adding managed public proxy/agent configuration. Discovery repeats every 15 seconds for newly started containers without touching the conversation backend. Future backend starts read `CLOUDCLI_ISOLATION_SSH_AGENT=1` and prepare the client during project startup too. The writable container's `/etc/profile.d` exports its relay path, so already running Codex App Servers can use the agent in new login shells without a process restart. Source host-agent key additions/removals are reflected dynamically.

On Ubuntu, run the setup script with `CLOUDCLI_NODE_BIN=/opt/node-v24.22.1/bin/node`, `CLOUDCLI_BACKEND_ROOT=/home/example/cloudcli` and `CLOUDCLI_ISOLATION_SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock`. Do not copy the private keys. Stop/disable `cloudcli-isolation-ssh.service` and remove the SSH opt-in backend drop-in to revoke this broker. Already executed remote actions cannot be undone by revocation. Restarting the broker disconnects SSH tunnels it carries; ordinary backend restarts do not require restarting it.

Protocol tests use a fake agent to verify forbidden management requests never reach it; they never attempt to remove real host identities. `scripts/verify-isolation-ssh.mjs` uses a disposable Rootless container for real key listing/signing, private-host/socket denial and public SSH transport. Set `ISOLATION_VERIFY_SSH_DESTINATION` to an operator-approved SSH destination (for example `user@ssh.example.com`) and optionally `ISOLATION_VERIFY_SSH_PORT` (default `223`). These are examples, not live test targets. Its public-network test deliberately fails closed at host-key verification before offering any authentication identity to the remote server.

Activation verification on Ubuntu: the existing project container retained its exact container ID and image, listed the same host-agent identities and completed a real signing challenge. A new disposable policy-v2 container was automatically discovered and configured by the broker and could use the agent without a backend restart. The conversation backend process was unchanged; the broker, backend and Hub connection health checks passed. The protocol/lifecycle test set passed 42 tests. No real host identity-management operation or remote-account login was performed for validation.

SSH port policy update: the operator removed the SSH port whitelist. Both the managed ProxyCommand and dedicated broker now accept valid custom TCP ports, including `ssh.example.com:223`; invalid ports and private destinations remain rejected. The general HTTP proxy keeps its original policy.


### Explicit upstream proxy for isolated egress

Set the operator-managed `CLOUDCLI_ISOLATION_UPSTREAM_PROXY` to an HTTP(S) proxy URL,
for example `http://192.168.1.2:7897` on the Lima Ubuntu backend. Configure it in the
conversation backend's systemd environment and the standalone SSH broker's environment
(`~/.config/cloudcli-isolation/ssh-broker.env`); the installer also accepts this variable.
Restart those services to apply it. Never assume Docker or a remote SSH command inherits
macOS Clash settings. This does not configure remote servers' downloads.

Egress still resolves and validates public destination addresses first, then sends CONNECT
with the pinned numeric IP to the upstream for both HTTP and HTTPS (and authorized SSH
ports). The operator's upstream can be on a private address; container-requested private
addresses remain blocked. Original HTTP Host and end-to-end TLS verification are preserved.
Proxy credentials and non-root URL paths are not accepted. Failed upstream connections do
not fall back to direct access. No variable means the existing direct-host route is retained.
Do not edit Clash subscription rules or expose its port directly inside the container.

On this Mac, pinned-IP CONNECT originally matched Clash's final DIRECT rule because
there was no domain metadata. The managed Clash Verge global merge now enables HTTP/TLS
sniffing (`parse-pure-ip: true`) with `override-destination: false` globally and per protocol.
This restores domain-based routing while retaining the validated IP; it does not replace
the subscription or any rules. Backup files are stored beside the original Clash configs
with `.pre-cloudcli-sniff-<timestamp>`. Preserve this merge when maintaining Clash.
Verify with `CLOUDCLI_ISOLATION_UPSTREAM_PROXY=http://192.168.1.2:7897 node
scripts/verify-isolation-upstream.mjs dist-server` on Ubuntu. The disposable network-none
Rootless container downloads the affected homepage, CSS and subpage and checks private
addresses are still refused. This does not fix or configure SSH-remote Code downloads.

### SSH initialization readiness (2026-11-05)

New `v2-ssh1-<CLI version>` images preinstall `openssh-client` and `util-linux`; images contain no user SSH credentials. Existing policy-v2 containers built from the approved `v2-<same CLI version>` image remain valid and retain their installed packages and private state volumes. They are repaired in place rather than recreated. Other image or policy mismatches still fail validation.

Both project startup and the standalone broker use a container-local `flock` across the second tool check, proxy readiness and installation. Existing SSH tools skip the network probe. Missing tools require a bounded local-listener check and an HTTPS software-source probe through the existing proxy; apt update treats partial-index failures as errors. Initialization failures expose `ISOLATION_PROXY_NOT_READY`, `ISOLATION_PROXY_UPSTREAM_UNAVAILABLE`, `ISOLATION_SSH_LOCK_UNAVAILABLE`, or `ISOLATION_SSH_INSTALL_FAILED`, and do not submit Codex input. Retry within the existing session after recovery; never automatically replay a business request.

The opt-in `ssh-initialization.integration.test.ts` creates a disposable credential-free container with `network=none`. Set `CLOUDCLI_ISOLATION_TEST_EGRESS_DIR` to an existing egress directory and `CLOUDCLI_ISOLATION_TEST_LEGACY_IMAGE` to the approved old image lacking SSH tools. It tests bounded failure, delayed readiness, recovery, concurrent initialization and single installation. Without these explicit settings it skips.
