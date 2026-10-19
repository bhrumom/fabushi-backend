#!/usr/bin/env python3
"""Build the files-only transfer archive that the delivery workflow accepts.

`deliver-dandelion-package.py` refuses any member whose path has an empty
segment, which is exactly how `zip -r` records directories (`pkg/`). A
directory-entry archive therefore fails at `phase=preparation-integrity`
before the signer is ever called. This writes the same content with file
entries only and prints the digest the workflow input needs.
"""
import argparse
import hashlib
from pathlib import Path
import sys
import zipfile

MAX_MEMBERS = 256
MAX_BYTES = 16 * 1024 * 1024


def collect(source):
    entries = sorted(path for path in source.rglob('*') if path.is_file())
    if not entries:
        raise ValueError('nothing to archive')
    if len(entries) > MAX_MEMBERS:
        raise ValueError('too many files for the delivery validator')
    for path in entries:
        name = path.relative_to(source).as_posix()
        if (not name.isascii() or '\\' in name
                or any(part in ('', '.', '..') for part in name.split('/'))):
            raise ValueError(f'unsupported member name: {name}')
    return entries


def build(source, destination):
    if destination.exists():
        raise ValueError('refusing to overwrite an existing transfer archive')
    entries = collect(source)
    with zipfile.ZipFile(destination, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in entries:
            archive.write(path, path.relative_to(source).as_posix())
    raw = destination.read_bytes()
    if len(raw) > MAX_BYTES:
        raise ValueError('transfer archive is too large')
    # Re-read the archive the way the workflow will, so a directory entry can
    # never slip through unnoticed.
    with zipfile.ZipFile(destination) as archive:
        for item in archive.infolist():
            if any(part in ('', '.', '..') for part in item.filename.split('/')):
                raise ValueError(f'unsafe archive member: {item.filename!r}')
    return hashlib.sha256(raw).hexdigest(), len(entries), len(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True,
                        help='directory holding the downloaded preparation files')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    digest, count, size = build(args.source, args.output)
    print(f'files={count} bytes={size}')
    print(f'sha256={digest}')
    print('pass this value as preparation_digest')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'preparation archive failed: {error}', file=sys.stderr)
        sys.exit(1)
