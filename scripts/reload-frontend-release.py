#!/usr/bin/env python3
"""Remote half of reloadCloudCLI: verify, atomically activate, and roll back a release."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path('/home/ubuntu/apps/cloudcli-prod')
SERVICE = 'cloudcli-prod-frontend.service'
HEALTH_URL = 'http://172.17.0.1:33002/'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(directory, expected):
    manifest_path = directory / 'reload-manifest.json'
    if not manifest_path.is_file() or sha(manifest_path) != expected:
        raise RuntimeError('发布清单不匹配')
    manifest = json.loads(manifest_path.read_text())
    for name, digest in manifest['files'].items():
        file = directory / name
        if directory.resolve() not in file.resolve().parents or not file.is_file() or sha(file) != digest:
            raise RuntimeError('发布文件校验失败: ' + name)
    return manifest


def health(directory):
    """Verify served bytes, not just a possibly stale HTTP 200."""
    import re
    index = (directory / 'index.html').read_text()
    assets = re.findall(r'(?:src|href)=[\"\'](/cloudcli/assets/[^\"\']+)', index)
    if not assets:
        raise RuntimeError('index.html 缺少 /cloudcli/assets/ 入口')
    boot = json.loads((directory / 'boot-assets.json').read_text())
    paths = ['index.html', 'boot-assets.json'] + [x[len('/cloudcli/'):]  for x in assets]
    paths += [x['file'] for x in boot['assets']]
    for name in dict.fromkeys(paths):
        with urllib.request.urlopen(HEALTH_URL + name, timeout=5) as response:
            digest = hashlib.sha256(response.read()).hexdigest()
        if digest != sha(directory / name):
            raise RuntimeError('线上文件内容不匹配: ' + name)


def restart():
    subprocess.run(['sudo', '-n', 'systemctl', 'restart', SERVICE], check=True, capture_output=True, text=True, timeout=40)


def wait_health(directory):
    last = None
    for attempt in range(12):
        try:
            health(directory)
            return
        except Exception as error:
            last = error
            time.sleep(0.5)
    raise RuntimeError(str(last))


def point_current(target, suffix):
    link = ROOT / ('.current-' + suffix)
    link.symlink_to(target)
    os.replace(link, ROOT / 'current')


def deploy(archive, release_id, digest, restart_service=True):
    if not release_id.replace('-', '').isalnum():
        raise RuntimeError('非法版本名称')
    release = ROOT / 'releases' / release_id
    previous = (ROOT / 'current').resolve(strict=True)
    release.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            target = release / member.name
            if not member.isfile() or release.resolve() not in target.resolve().parents:
                raise RuntimeError('压缩包包含非法文件')
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source:
                target.write_bytes(source.read())
    verify(release, digest)
    switched = False
    try:
        point_current(release, release_id)
        switched = True
        if restart_service:
            restart()
            wait_health(release)
    except Exception as error:
        if switched:
            try:
                point_current(previous, release_id + '-rollback')
                restart()
                wait_health(previous)
            except Exception as rollback_error:
                raise RuntimeError(f'发布失败: {error}；回滚也失败: {rollback_error}；原版本: {previous}') from error
            raise RuntimeError(f'发布失败，已回滚并验证原版本 {previous}: {error}') from error
        raise
    print(json.dumps({'release': str(release), 'previous': str(previous), 'verified': True,
                      'restart_required': not restart_service}))


def main():
    mode, digest = sys.argv[1:3]
    # Serialize activation across invocations/hosts, including rollback.
    with (ROOT / '.reload-frontend.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if mode == 'check':
            try:
                current = (ROOT / 'current').resolve(strict=True)
                verify(current, digest)
                health(current)
            except Exception:
                print(json.dumps({'matches': False}))
            else:
                print(json.dumps({'matches': True, 'release': str(current)}))
        elif mode in ('deploy', 'deploy-no-restart'):
            deploy(Path(sys.argv[3]), sys.argv[4], digest, restart_service=(mode == 'deploy'))
        else:
            raise RuntimeError('Unknown mode')


if __name__ == '__main__':
    main()
