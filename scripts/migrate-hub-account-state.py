#!/usr/bin/env python3
"""Migrate snapshot preferences into stopped Hub; verify resource drafts stay with owners."""
import argparse, hashlib, json, pathlib, shutil
p = argparse.ArgumentParser()
p.add_argument('--auth', required=True, type=pathlib.Path)
p.add_argument('--office', required=True, type=pathlib.Path)
p.add_argument('--vm', required=True, type=pathlib.Path)
p.add_argument('--apply', action='store_true')
a = p.parse_args()
state = json.loads(a.auth.read_text())
sources = [json.loads(a.office.read_text()), json.loads(a.vm.read_text())]
owners = {}
for source in sources:
    for user in source['users']:
        for kind in ('projects', 'sessions'):
            for resource in user[kind]:
                key = (user['hubUserId'], kind, resource)
                if key in owners and owners[key] != source['backendId']:
                    raise SystemExit('Conflicting resource ownership; snapshots retained')
                owners[key] = source['backendId']
retained = 0
for source in sources:
    for user in source['users']:
        for draft in user['drafts']:
            scope = draft['draft_scope']
            kind, resource = ('projects', scope[8:]) if scope.startswith('project:') else ('sessions', scope)
            owner = owners.get((user['hubUserId'], kind, resource))
            if owner != source['backendId']:
                raise SystemExit('Draft ownership needs manual reconciliation; no data changed')
            retained += 1
users = {u['id']: u for u in state['users']}
preferences = dict(state.get('preferences', {}))
for source in sources:  # Office is authoritative; VM can only fill missing settings.
    for user in source['users']:
        identity = user['hubUserId']
        if identity not in users:
            raise SystemExit('Snapshot account is not a Hub account; no account created')
        current = preferences.setdefault(identity, {})
        for key, value in user['preferences'].items():
            if key not in current:
                current[key] = value
receipt = {
    'version': 1, 'retained_backend_drafts': retained,
    'resource_counts': {s['backendId']: {
        k: sum(len(u[k]) for u in s['users']) for k in ['projects', 'sessions']
    } for s in sources},
    'source_sha256': {str(f.name): hashlib.sha256(f.read_bytes()).hexdigest() for f in [a.office, a.vm]},
    'accounts': len(preferences),
}
if a.apply:
    if not state.get('accountStateMigration'):
        shutil.copy2(a.auth, a.auth.with_suffix('.pre-account-state-migration.json'))
        state['preferences'] = preferences
        original = sources[0]['users']
        if len(original) == 1:
            state['legacyCacheOwner'] = original[0]['hubUserId']
        state['accountStateMigration'] = receipt
        temp = a.auth.with_suffix('.migration.tmp')
        temp.write_text(json.dumps(state, indent=2))
        temp.chmod(0o600)
        temp.replace(a.auth)
    else:
        print('Account migration already applied; current Hub preferences preserved')
print(json.dumps(receipt))
