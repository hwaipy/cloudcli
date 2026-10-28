#!/usr/bin/env python3
"""Run the primary CloudCLI development instance with local provider history."""
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import time

root = Path(__file__).resolve().parent.parent
state = root / '.debug-local'
state.mkdir(exist_ok=True)
provider_home = Path.home()
node = os.environ.get('CLOUDCLI_DEBUG_NODE') or shutil.which('node')
if not node:
    raise SystemExit('Node.js 24 is required.')
for port in (3001, 3102, 9232):
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit(f'Port {port} is already in use; no process was stopped.')

secret = state / 'jwt-secret'
if not secret.exists():
    secret.write_text(secrets.token_hex(32))
    secret.chmod(0o600)
# Use the real home for provider credentials, configuration and session history.
# Keep the merged CloudCLI database in the repo-local runtime directory.
env = os.environ.copy()
# Preserve the provider environment used by the former standard launcher.
settings = provider_home / '.claude' / 'settings.json'
if settings.exists():
    import json
    env.update(json.loads(settings.read_text()).get('env', {}))
for key in ('CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
            'XDG_CACHE_HOME', 'NODE_OPTIONS', 'VITE_IS_PLATFORM', 'IS_PLATFORM'):
    env.pop(key, None)
env.update({
    'NODE_ENV': 'development',
    'CLOUDCLI_DEBUG_BASE': '/cloudcli',
    'SERVER_PORT': '3102', 'PORT': '3102', 'VITE_PORT': '3001',
    'DATABASE_PATH': str(state / 'auth.db'),
    'JWT_SECRET': secret.read_text().strip(),
    'PATH': str(Path(node).parent) + os.pathsep + env.get('PATH', ''),
})
commands = [
    ([node, 'node_modules/tsx/dist/cli.mjs', 'watch', '--inspect=127.0.0.1:9232',
      '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], '127.0.0.1'),
    ([node, 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--strictPort'], '127.0.0.1'),
]
children = []

def stop(signum, frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
exit_code = 0
try:
    for command, host in commands:
        # Keep stdin open: Vite exits when a background launcher's stdin ends.
        children.append(subprocess.Popen(command, cwd=root, env={**env, 'HOST': host},
                                         stdin=subprocess.PIPE, start_new_session=True))
    print('CloudCLI debug: http://localhost:3001/cloudcli/ (API 127.0.0.1:3102, inspector 127.0.0.1:9232)', flush=True)
    while all(child.poll() is None for child in children):
        time.sleep(0.5)
    exit_code = next((child.returncode or 1 for child in children if child.poll() is not None), 1)
    print(f'Development process exited: {[child.poll() for child in children]}', flush=True)
except KeyboardInterrupt:
    pass
finally:
    for child in children:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
    for child in children:
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
raise SystemExit(exit_code)
