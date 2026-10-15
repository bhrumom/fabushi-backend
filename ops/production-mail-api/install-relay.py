#!/usr/bin/env python3
"""Narrow operational installer; credentials never enter command arguments."""
import datetime
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

SENDER = 'amitabha@ombhrum.com'
HOST = 'smtp.email.us-phoenix-1.oci.oraclecloud.com'
ENDPOINT = '[' + HOST + ']:587'
MAPS = {
    'sender_dependent_relayhost_maps': 'texthash:/etc/postfix/fabushi-relayhosts',
    'smtp_sasl_password_maps': 'texthash:/etc/postfix/fabushi-sasl-passwd',
    'smtp_tls_policy_maps': 'texthash:/etc/postfix/fabushi-tls-policy',
}
SETTINGS = dict(MAPS, smtp_sasl_auth_enable='yes',
                smtp_sender_dependent_authentication='yes',
                smtp_sasl_security_options='noanonymous',
                smtp_sasl_tls_security_options='noanonymous')

def validate_existing(settings):
    for key, expected in MAPS.items():
        if settings.get(key, '').strip() not in ('', expected):
            raise ValueError('unowned existing mail map: ' + key)

def render_maps(credentials):
    if set(credentials) != {'username', 'password'}:
        raise ValueError('unexpected credential fields')
    user, password = credentials['username'], credentials['password']
    if not isinstance(user, str) or not re.fullmatch(r'[A-Za-z0-9_.@/-]{16,512}', user):
        raise ValueError('invalid relay username')
    if not isinstance(password, str) or not re.fullmatch(r'[A-Za-z0-9+/=_-]{16,512}', password):
        raise ValueError('invalid relay password')
    return {
        '/etc/postfix/fabushi-relayhosts': SENDER + ' ' + ENDPOINT + '\n',
        '/etc/postfix/fabushi-sasl-passwd': SENDER + ' ' + user + ':' + password + '\n',
        '/etc/postfix/fabushi-tls-policy': ENDPOINT + ' secure match=' + HOST + '\n',
    }

def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()

def atomic_write(path, data, mode=0o600):
    path = pathlib.Path(path)
    if path.is_symlink():
        raise ValueError('symlink target rejected')
    fd, name = tempfile.mkstemp(prefix='.fabushi-mail-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def install(source, credential_path):
    if os.geteuid() != 0:
        raise ValueError('root administration required')
    if 'texthash' not in command(['postconf', '-m']).split():
        raise ValueError('texthash is unavailable')
    if not pathlib.Path('/etc/ssl/certs').is_dir():
        raise ValueError('system trust store is unavailable')
    ca_path = command(['postconf', '-h', 'smtp_tls_CApath'])
    if ca_path != '/etc/ssl/certs':
        raise ValueError('unexpected existing SMTP trust configuration')
    settings = {k: command(['postconf', '-h', k]) for k in SETTINGS}
    validate_existing(settings)
    maps = render_maps(json.loads(pathlib.Path(credential_path).read_text()))
    app = pathlib.Path('/opt/fabushi-mail-api/app.py')
    files = [pathlib.Path('/etc/postfix/main.cf'), app] + [pathlib.Path(p) for p in maps]
    for p in files:
        if p.is_symlink() or (p.exists() and not p.is_file()):
            raise ValueError('unsafe existing target')
    backup = pathlib.Path('/var/backups/fabushi-mail') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup.mkdir(parents=True, mode=0o700)
    os.chmod(backup.parent, 0o700)
    originals = {}
    original_modes = {}
    for i, p in enumerate(files):
        originals[p] = p.exists()
        if p.exists():
            original_modes[p] = p.stat().st_mode & 0o777
            shutil.copy2(p, backup / str(i))
            os.chmod(backup / str(i), 0o600)
    try:
        for path, value in maps.items():
            atomic_write(path, value)
        for key, value in SETTINGS.items():
            command(['postconf', '-e', key + '=' + value])
        atomic_write(app, pathlib.Path(source).read_text(), 0o644)
        command(['systemctl', 'reload', 'postfix'])
        command(['systemctl', 'restart', 'fabushi-mail-api'])
        command(['systemctl', 'is-active', '--quiet', 'fabushi-mail-api'])
    except Exception:
        for i, p in enumerate(files):
            if originals[p]:
                shutil.copy2(backup / str(i), p)
                os.chmod(p, original_modes[p])
            elif p.exists():
                p.unlink()
        subprocess.run(['systemctl', 'reload', 'postfix'], capture_output=True)
        subprocess.run(['systemctl', 'restart', 'fabushi-mail-api'], capture_output=True)
        raise RuntimeError('mail installation failed; previous files restored') from None
    print(json.dumps({'installed': True, 'sender': SENDER, 'relay': ENDPOINT,
                      'credentialLogged': False, 'unrelatedQueuesFlushed': False,
                      'backupPath': str(backup)}))

if __name__ == '__main__':
    install(sys.argv[1], sys.argv[2])
