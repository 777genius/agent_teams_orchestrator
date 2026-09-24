#!/usr/bin/env python3
"""Offline build context for official OpenCode, FD3 bootstrap, and Owner plugin."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tarfile

HERE = Path(__file__).resolve().parent
LOCK_PATH = HERE / 'artifact-lock.json'
ARCHIVE_SHA = '3046e0404fdc60fb80307e7a47824ba07477364178a4d09baa8548496dd6d43b'
BINARY_SHA = '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080'
PLUGIN_SHA = '805df9de2239792c47bb040961110ae44f9bbbd4afd6bb821dcf497be4357f4c'
BASE_IMAGE = 'docker.io/library/ubuntu@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3'
SOURCE_COMMIT = '545f51d26cc39a907d2867492d498d9607ea5fa4'
SHA = re.compile(r'^[0-9a-f]{64}$')
MAX_BINARY_BYTES = 256 * 1024 * 1024


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def approved_lock(path=LOCK_PATH):
    lock = json.loads(Path(path).read_text())
    expected = {'schemaVersion', 'status', 'opencodeVersion', 'sourceCommit', 'archiveName',
                'archiveSha256', 'binarySha256', 'baseImage', 'bootstrapSha256', 'pluginSha256'}
    if (type(lock) is not dict or set(lock) != expected or lock['schemaVersion'] != 1 or
            lock['status'] != 'reviewed' or lock['opencodeVersion'] != '1.18.32' or
            lock['sourceCommit'] != SOURCE_COMMIT or lock['archiveName'] != 'opencode-linux-x64.tar.gz' or
            lock['archiveSha256'] != ARCHIVE_SHA or lock['binarySha256'] != BINARY_SHA or
            lock['baseImage'] != BASE_IMAGE or type(lock['bootstrapSha256']) is not str or
            not SHA.fullmatch(lock['bootstrapSha256']) or lock['pluginSha256'] != PLUGIN_SHA):
        raise ValueError('hosted-opencode-image-lock-not-reviewed')
    return lock


def regular_absolute(path):
    source = Path(path)
    if not source.is_absolute() or source.is_symlink():
        raise ValueError('hosted-opencode-image-input-invalid')
    item = os.lstat(source)
    if not stat.S_ISREG(item.st_mode) or item.st_nlink != 1 or item.st_size < 1:
        raise ValueError('hosted-opencode-image-input-invalid')
    return source


def extract_exact_binary(archive, output):
    found = False
    with tarfile.open(archive, mode='r:gz') as source:
        for member in source:
            parts = Path(member.name).parts
            if member.name.startswith('/') or '..' in parts or member.issym() or member.islnk():
                raise ValueError('hosted-opencode-archive-member-invalid')
            if not member.isfile() or Path(member.name).name != 'opencode':
                continue
            if found or member.size < 1 or member.size > MAX_BINARY_BYTES:
                raise ValueError('hosted-opencode-archive-binary-ambiguous')
            found = True
            binary = source.extractfile(member)
            if binary is None:
                raise ValueError('hosted-opencode-archive-binary-unreadable')
            digest = hashlib.sha256()
            remaining = member.size
            with open(output, 'xb') as target:
                while remaining:
                    chunk = binary.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('hosted-opencode-archive-binary-truncated')
                    target.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                target.flush()
                os.fsync(target.fileno())
            if digest.hexdigest() != BINARY_SHA:
                raise ValueError('hosted-opencode-binary-digest-mismatch')
    if not found:
        raise ValueError('hosted-opencode-archive-binary-missing')
    os.chmod(output, 0o555)


def prepare(archive_path, bootstrap_path, plugin_path, output_dir, lock_path=LOCK_PATH):
    lock = approved_lock(lock_path)
    archive = regular_absolute(archive_path)
    bootstrap = regular_absolute(bootstrap_path)
    plugin = regular_absolute(plugin_path)
    output = Path(output_dir)
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise ValueError('hosted-opencode-image-output-invalid')
    if digest_file(archive) != ARCHIVE_SHA:
        raise ValueError('hosted-opencode-archive-digest-mismatch')
    if digest_file(bootstrap) != lock['bootstrapSha256']:
        raise ValueError('hosted-opencode-bootstrap-digest-mismatch')
    if digest_file(plugin) != lock['pluginSha256']:
        raise ValueError('hosted-opencode-plugin-digest-mismatch')
    with open(bootstrap, 'rb') as source:
        if source.read(4) != b'\x7fELF':
            raise ValueError('hosted-opencode-bootstrap-not-elf')
    output.mkdir(mode=0o700)
    extract_exact_binary(archive, output / 'opencode')
    target_bootstrap = output / 'hosted-opencode-fd3-bootstrap'
    with open(bootstrap, 'rb') as source, open(target_bootstrap, 'xb') as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
        target.flush()
        os.fsync(target.fileno())
    os.chmod(target_bootstrap, 0o555)
    if digest_file(target_bootstrap) != lock['bootstrapSha256']:
        raise ValueError('hosted-opencode-bootstrap-copy-mismatch')
    target_plugin = output / 'hosted-owner-plugin.mjs'
    with open(plugin, 'rb') as source, open(target_plugin, 'xb') as target:
        shutil.copyfileobj(source, target, 1024 * 1024)
        target.flush()
        os.fsync(target.fileno())
    os.chmod(target_plugin, 0o444)
    if digest_file(target_plugin) != lock['pluginSha256']:
        raise ValueError('hosted-opencode-plugin-copy-mismatch')
    template = (HERE / 'Dockerfile.template').read_text()
    if template.count('@BOOTSTRAP_SHA256@') != 1 or template.count('@PLUGIN_SHA256@') != 1:
        raise ValueError('hosted-opencode-dockerfile-template-invalid')
    dockerfile = (template.replace('@BOOTSTRAP_SHA256@', lock['bootstrapSha256'])
                  .replace('@PLUGIN_SHA256@', lock['pluginSha256']))
    with open(output / 'Dockerfile', 'x') as target:
        target.write(dockerfile)
    return {'archiveSha256': ARCHIVE_SHA, 'binarySha256': BINARY_SHA,
            'bootstrapSha256': lock['bootstrapSha256'], 'pluginSha256': lock['pluginSha256'], 'baseImage': BASE_IMAGE,
            'dockerfileSha256': hashlib.sha256(dockerfile.encode()).hexdigest()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--bootstrap', required=True)
    parser.add_argument('--plugin', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.archive, args.bootstrap, args.plugin, args.output_dir), sort_keys=True, separators=(',', ':')))
