#!/usr/bin/env bash
# Run on a Linux backend as its service user. Leaves the system Docker daemon
# and the user's normal CLI context intact. Does not restart CloudCLI.
set -euo pipefail
if [[ $(uname -s) != Linux || $(id -u) == 0 ]]; then
  echo 'Run this script on Linux as the non-root CloudCLI backend user.' >&2
  exit 1
fi
for executable in docker dockerd-rootless-setuptool.sh newuidmap newgidmap; do
  if ! command -v "$executable" >/dev/null; then
    echo "Missing $executable. Install Docker CE rootless extras, uidmap and dbus-user-session first." >&2
    exit 1
  fi
done
isolation_cli_config="$HOME/.config/cloudcli-isolation/docker-cli"
mkdir -p "$isolation_cli_config"
chmod 700 "$isolation_cli_config"
DOCKER_CONFIG="$isolation_cli_config" dockerd-rootless-setuptool.sh install --force
socket="unix:///run/user/$(id -u)/docker.sock"
docker --host "$socket" info --format '{{json .SecurityOptions}} cgroup={{.CgroupVersion}}/{{.CgroupDriver}}'
echo "Use CLOUDCLI_ISOLATION_DOCKER_HOST=$socket for strict projects."
echo 'Ensure loginctl enable-linger is configured for this user. Restart CloudCLI manually when ready.'
