#!/usr/bin/env python3
"""Emit one deterministic, credential-free OpenCode config for an admitted mode."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import stat

SPEC = {'schemaVersion': 1, 'mode': 'deny-all-inert'}
CONFIG = {'plugin': [], 'permission': {'*': 'deny'}, 'share': 'disabled'}
OWNER_PLUGIN_SHA = '805df9de2239792c47bb040961110ae44f9bbbd4afd6bb821dcf497be4357f4c'
OWNER_PLUGIN_URL = 'file:///usr/local/lib/agentteams/hosted-owner-plugin.mjs'
OWNER_SPEC = {'schemaVersion': 1, 'mode': 'owner-fd3-tools', 'pluginSha256': OWNER_PLUGIN_SHA}
OWNER_TOOLS = ('hosted_task_get', 'hosted_task_start', 'hosted_task_complete',
               'hosted_task_add_comment', 'hosted_message_send')
OWNER_CONFIG = {'plugin': [OWNER_PLUGIN_URL],
                'permission': {'*': 'deny', **{name: 'allow' for name in OWNER_TOOLS}},
                'share': 'disabled'}


def render(spec):
    if type(spec) is not dict:
        raise ValueError('hosted-opencode-config-spec-invalid')
    if spec == SPEC:
        selected = CONFIG
    elif spec == OWNER_SPEC:
        lock = json.loads((Path(__file__).resolve().parent / 'artifact-lock.json').read_text())
        if lock.get('pluginSha256') != OWNER_PLUGIN_SHA or lock.get('status') != 'reviewed':
            raise ValueError('hosted-opencode-owner-plugin-lock-invalid')
        selected = OWNER_CONFIG
    else:
        raise ValueError('hosted-opencode-config-spec-invalid')
    return (json.dumps(selected, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def trusted_directory(directory_fd, uid=0, gid=0):
    info = os.fstat(directory_fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_gid != gid or
            info.st_mode & 0o022):
        raise ValueError('hosted-opencode-config-parent-invalid')


def descend_trusted(anchor_fd, components, uid=0, gid=0):
    """Return an open parent fd; caller owns it and keeps anchor_fd open."""
    current = os.dup(anchor_fd)
    try:
        trusted_directory(current, uid, gid)
        for component in components:
            if component in ('', '.', '..'):
                raise ValueError('hosted-opencode-config-parent-invalid')
            next_fd = os.open(component, DIRECTORY_FLAGS, dir_fd=current)
            try:
                trusted_directory(next_fd, uid, gid)
            except Exception:
                os.close(next_fd)
                raise
            os.close(current)
            current = next_fd
        return current
    except Exception:
        os.close(current)
        raise


def build(spec_path, output_dir):
    if os.geteuid() != 0:
        raise PermissionError('hosted-opencode-config-builder-requires-root')
    source = Path(spec_path)
    target = Path(output_dir)
    if (not source.is_absolute() or not target.is_absolute() or
            any(part in ('.', '..') for part in target.parts) or not target.name):
        raise ValueError('hosted-opencode-config-path-invalid')
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_size > 4096:
            raise ValueError('hosted-opencode-config-spec-file-invalid')
        with os.fdopen(source_fd, 'r') as source_file:
            source_fd = -1
            spec = json.load(source_file)
    finally:
        if source_fd >= 0:
            os.close(source_fd)
    content = render(spec)
    with ExitStack() as stack:
        root_fd = os.open('/', DIRECTORY_FLAGS)
        stack.callback(os.close, root_fd)
        parent_fd = descend_trusted(root_fd, target.parts[1:-1])
        stack.callback(os.close, parent_fd)
        # The parent remains open throughout creation. No path is resolved again.
        os.mkdir(target.name, mode=0o700, dir_fd=parent_fd)
        target_fd = os.open(target.name, DIRECTORY_FLAGS, dir_fd=parent_fd)
        stack.callback(os.close, target_fd)
        target_stat = os.fstat(target_fd)
        if target_stat.st_uid != 0 or target_stat.st_gid != 0:
            raise ValueError('hosted-opencode-config-output-owner-invalid')
        fd = os.open('opencode.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                     os.O_NOFOLLOW | os.O_CLOEXEC, 0o400, dir_fd=target_fd)
        stack.callback(os.close, fd)
        file_stat = os.fstat(fd)
        if (not stat.S_ISREG(file_stat.st_mode) or file_stat.st_uid != 0 or
                file_stat.st_gid != 0 or file_stat.st_nlink != 1):
            raise ValueError('hosted-opencode-config-output-file-invalid')
        try:
            cursor = 0
            while cursor < len(content):
                cursor += os.write(fd, content[cursor:])
            os.fsync(fd)
            os.fchmod(fd, 0o444)
            os.fchmod(target_fd, 0o555)
            os.fsync(target_fd)
            os.fsync(parent_fd)
        except Exception:
            # Leave an incomplete directory for explicit root cleanup; never emit a receipt.
            raise
        return {'configSha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec', required=True)
    parser.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.spec, args.output_dir), sort_keys=True, separators=(',', ':')))
