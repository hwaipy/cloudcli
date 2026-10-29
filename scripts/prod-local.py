#!/usr/bin/env python3
"""Run the compiled CloudCLI backend for the remote production frontend."""

import json
import os
from pathlib import Path
import shutil


root = Path(__file__).resolve().parent.parent
entry = root / 'dist-server/server/index.js'
if not entry.exists():
    raise SystemExit('Build the backend first: npm run build:server')

node = os.environ.get('CLOUDCLI_PROD_NODE') or shutil.which('node')
if not node:
    raise SystemExit('Node.js is required.')

env = os.environ.copy()
settings = Path.home() / '.claude/settings.json'
if settings.exists():
    env.update(json.loads(settings.read_text()).get('env', {}))

# Production uses the existing CloudCLI account database and its stored JWT secret.
for key in ('JWT_SECRET', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
            'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'NODE_OPTIONS',
            'VITE_IS_PLATFORM', 'IS_PLATFORM'):
    env.pop(key, None)
env.update({
    'NODE_ENV': 'production',
    'CLOUDCLI_CODEX_TRANSPORT': 'app-server',
    'HOST': '127.0.0.1',
    'SERVER_PORT': '3001',
    'PORT': '3001',
    'DATABASE_PATH': str(Path.home() / '.cloudcli/auth.db'),
})

os.chdir(root)
os.execve(node, [node, str(entry)], env)
