#!/usr/bin/env bash
# Install the project SSH broker as the Linux backend user. No conversation backend restart.
set -euo pipefail
if [[ $(uname -s) != Linux || $(id -u) == 0 ]]; then echo 'Run as the non-root Linux backend user.' >&2; exit 1; fi
backend_root="${CLOUDCLI_BACKEND_ROOT:-$(cd -- "$(dirname -- "$0")/.." && pwd)}"
node_bin="${CLOUDCLI_NODE_BIN:-$(command -v node)}"
agent_socket="${CLOUDCLI_ISOLATION_SSH_AUTH_SOCK:-${SSH_AUTH_SOCK:-/run/host-services/ssh-auth.sock}}"
state_root="${CLOUDCLI_ISOLATION_STATE_DIR:-$HOME/.cloudcli/isolated-projects}"
backend_service="${CLOUDCLI_BACKEND_SERVICE:-cloudcli-vm-backend.service}"
[[ -f "$backend_root/dist-server/server/isolation-ssh.js" ]] || { echo 'Deploy the SSH broker build first.' >&2; exit 1; }
[[ -S "$agent_socket" ]] || { echo 'The authorized SSH agent socket is unavailable.' >&2; exit 1; }
config_dir="$HOME/.config/cloudcli-isolation"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$config_dir" "$unit_dir/$backend_service.d"
chmod 700 "$config_dir"
cat > "$config_dir/ssh-broker.env" <<EOF
CLOUDCLI_ISOLATION_SSH_AUTH_SOCK=$agent_socket
CLOUDCLI_ISOLATION_STATE_DIR=$state_root
CLOUDCLI_ISOLATION_DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
EOF
# Optional operator-managed HTTP(S) upstream, shared with the conversation backend egress.
if [[ -n "${CLOUDCLI_ISOLATION_UPSTREAM_PROXY:-}" ]]; then
  [[ "$CLOUDCLI_ISOLATION_UPSTREAM_PROXY" != *$'\n'* && "$CLOUDCLI_ISOLATION_UPSTREAM_PROXY" != *$'\r'* && "$CLOUDCLI_ISOLATION_UPSTREAM_PROXY" != *' '* ]] || { echo 'Invalid upstream proxy URL.' >&2; exit 1; }
  printf 'CLOUDCLI_ISOLATION_UPSTREAM_PROXY=%s\n' "$CLOUDCLI_ISOLATION_UPSTREAM_PROXY" >> "$config_dir/ssh-broker.env"
fi
chmod 600 "$config_dir/ssh-broker.env"
cat > "$unit_dir/cloudcli-isolation-ssh.service" <<EOF
[Unit]
Description=CloudCLI isolated SSH signing and public SSH proxy
Wants=docker.service
After=docker.service
[Service]
Type=simple
WorkingDirectory=$backend_root
EnvironmentFile=$config_dir/ssh-broker.env
ExecStart="$node_bin" "$backend_root/dist-server/server/isolation-ssh.js"
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
UMask=0077
MemoryMax=256M
TasksMax=128
[Install]
WantedBy=default.target
EOF
cat > "$unit_dir/$backend_service.d/ssh-agent.conf" <<EOF
[Unit]
Wants=cloudcli-isolation-ssh.service
After=cloudcli-isolation-ssh.service
[Service]
Environment=CLOUDCLI_ISOLATION_SSH_AGENT=1
EOF
systemctl --user daemon-reload
systemctl --user enable cloudcli-isolation-ssh.service
systemctl --user restart cloudcli-isolation-ssh.service
systemctl --user is-active cloudcli-isolation-ssh.service
echo 'SSH broker enabled. Existing running strict containers are prepared without rebuilding them.'
echo 'Conversation backend was not restarted; future backend startups also enable new containers.'
