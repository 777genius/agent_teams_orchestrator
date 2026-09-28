#!/usr/bin/env python3
"""Build an inert, content-verified Linux root daemon release directory.

This creates files for independent review. It never installs or starts them.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
IMAGE_RECIPE = REPO / 'deploy' / 'hosted-opencode-image'
LOCK = IMAGE_RECIPE / 'artifact-lock.json'
DAEMON_ENTRY = REPO / 'src' / 'entrypoints' / 'hostedOpenCodeRootDaemon.ts'
HANDOFF_SOURCE = REPO / 'deploy' / 'hosted-opencode-fd3-handoff' / 'handoff.py'
BUN_ARCHIVE_SHA256 = '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913'
BUN_EXECUTABLE_SHA256 = 'a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c'
BUN_ARCHIVE_MEMBERS = {'bun-linux-x64/', 'bun-linux-x64/bun'}
SHA = re.compile(r'^[0-9a-f]{64}$')
DAEMON_NAME = 'hosted-opencode-root-daemon'
HANDOFF_NAME = 'hosted-opencode-fd3-handoff'
MANIFEST_NAME = 'manifest.json'
LOCK_NAME = 'official-opencode-image-lock.json'
RECEIPT_NAME = 'manifest.sha256'
PURPOSE = 'agent-teams.hosted-opencode-root-daemon.package/v1'
INSTALL_ROOT = '/usr/local/libexec/agentteams'
INSTALL_SHARE = '/usr/local/share/agentteams'
SCRIPT_SHA_AT_IMPORT = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n').encode()


def approved_image_lock(source_root=REPO):
    image_recipe = Path(source_root) / 'deploy' / 'hosted-opencode-image'
    spec = importlib.util.spec_from_file_location('hosted_image_recipe', image_recipe / 'prepare-context.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.approved_lock()


def source_path(source_root, relative_path):
    return Path(source_root) / relative_path


def exact_file(path, mode=None, unique=True):
    path = Path(path)
    entry = path.lstat()
    if not stat.S_ISREG(entry.st_mode) or (unique and entry.st_nlink != 1) or entry.st_size == 0:
        raise ValueError('hosted-root-package-file-invalid')
    if mode is not None and stat.S_IMODE(entry.st_mode) != mode:
        raise ValueError('hosted-root-package-mode-invalid')
    return path.read_bytes()


def owner_id(value):
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError('hosted-root-package-owner-id-invalid') from None
    if str(number) != str(value) or number < 1 or number > 2**31 - 1:
        raise ValueError('hosted-root-package-owner-id-invalid')
    return number


def extract_bun(archive_path, destination):
    archive = Path(archive_path)
    if not archive.is_absolute() or sha256(exact_file(archive)) != BUN_ARCHIVE_SHA256:
        raise ValueError('hosted-root-package-bun-archive-invalid')
    with zipfile.ZipFile(archive) as source:
        members = source.infolist()
        if len(members) != 2 or {member.filename for member in members} != BUN_ARCHIVE_MEMBERS:
            raise ValueError('hosted-root-package-bun-archive-layout-invalid')
        executable = source.getinfo('bun-linux-x64/bun')
        if executable.file_size < 1 or executable.file_size > 128 * 1024 * 1024:
            raise ValueError('hosted-root-package-bun-archive-layout-invalid')
        content = source.read(executable)
    if sha256(content) != BUN_EXECUTABLE_SHA256 or not content.startswith(b'\x7fELF'):
        raise ValueError('hosted-root-package-bun-executable-invalid')
    destination = Path(destination)
    destination.write_bytes(content)
    destination.chmod(0o555)
    return destination


def committed_snapshot(revision, destination):
    """Extract only Git objects from one commit, never source from the live worktree."""
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('hosted-root-package-revision-invalid')
    destination = Path(destination)
    destination.mkdir(mode=0o700)
    archive = destination.parent / 'source.tar'
    subprocess.run(['/usr/bin/git', 'archive', '--format=tar', f'--output={archive}', revision],
                   cwd=REPO, check=True, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    with tarfile.open(archive) as source:
        for member in source:
            relative = PurePosixPath(member.name)
            if (relative.is_absolute() or '..' in relative.parts or not relative.parts or
                    any(part in ('', '.') for part in relative.parts)):
                raise ValueError('hosted-root-package-archive-path-invalid')
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with source.extractfile(member) as input_file, target.open('xb') as output_file:
                    shutil.copyfileobj(input_file, output_file)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
            else:
                raise ValueError('hosted-root-package-archive-entry-invalid')
    archive.unlink()
    committed_script = source_path(destination, 'deploy/hosted-root-daemon/package.py')
    if sha256(exact_file(committed_script)) != SCRIPT_SHA_AT_IMPORT:
        raise ValueError('hosted-root-package-builder-source-mismatch')
    return destination


def copy_dependencies(snapshot):
    installed = (REPO / 'node_modules').resolve(strict=True)
    if not installed.is_dir() or installed == REPO:
        raise ValueError('hosted-root-package-dependencies-unavailable')
    destination = Path(snapshot) / 'node_modules'
    shutil.copytree(installed, destination, symlinks=True)
    for entry in destination.rglob('*'):
        if entry.is_symlink():
            if entry.readlink().is_absolute() or not entry.resolve().is_relative_to(destination):
                raise ValueError('hosted-root-package-dependency-link-escaped')


def render_manifest(daemon, handoff, lock_bytes, revision, owner_uid, owner_gid,
                    compiler_sha256, source_root=REPO):
    if (not daemon.startswith(b'\x7fELF') or not re.fullmatch(r'[0-9a-f]{40}', revision) or
            compiler_sha256 != BUN_EXECUTABLE_SHA256):
        raise ValueError('hosted-root-package-input-invalid')
    owner_uid, owner_gid = owner_id(owner_uid), owner_id(owner_gid)
    approved = approved_image_lock(source_root)
    source_lock = source_path(source_root, 'deploy/hosted-opencode-image/artifact-lock.json')
    source_handoff = source_path(source_root, 'deploy/hosted-opencode-fd3-handoff/handoff.py')
    if json.loads(lock_bytes) != approved or lock_bytes != exact_file(source_lock):
        raise ValueError('hosted-root-package-image-lock-invalid')
    if handoff != exact_file(source_handoff) or not handoff.startswith(b'#!/usr/bin/python3 -I\n'):
        raise ValueError('hosted-root-package-handoff-invalid')
    return {
        'schemaVersion': 1,
        'purpose': PURPOSE,
        'activation': 'disabled',
        'sourceRevision': revision,
        'buildTool': {'name': 'bun', 'version': '1.4.2', 'target': 'bun-linux-x64',
                      'archiveSha256': BUN_ARCHIVE_SHA256, 'executableSha256': compiler_sha256},
        'files': {
            DAEMON_NAME: {'sha256': sha256(daemon), 'mode': '0555'},
            HANDOFF_NAME: {'sha256': sha256(handoff), 'mode': '0555'},
            LOCK_NAME: {'sha256': sha256(lock_bytes), 'mode': '0444'},
        },
        'officialOpenCode': {
            'version': approved['opencodeVersion'],
            'sourceCommit': approved['sourceCommit'],
            'archiveSha256': approved['archiveSha256'],
            'binarySha256': approved['binarySha256'],
            'bootstrapSha256': approved['bootstrapSha256'],
            'pluginSha256': approved['pluginSha256'],
            'baseImage': approved['baseImage'],
            'runtimeMode': 'official-v1.18.32',
            'hostLocalBinaryFallback': False,
            'imageManifestDigest': None,
        },
        'installation': {
            'daemonPath': f'{INSTALL_ROOT}/{DAEMON_NAME}',
            'handoffHelperPath': f'{INSTALL_ROOT}/{HANDOFF_NAME}',
            'imageLockPath': f'{INSTALL_SHARE}/{LOCK_NAME}',
            'manifestPath': f'{INSTALL_SHARE}/{MANIFEST_NAME}',
            'rootConfigPath': '/etc/agentteams/hosted-opencode-root-daemon.json',
            'installedOwnerUid': 0,
            'installedOwnerGid': 0,
            'ownerUid': owner_uid,
            'ownerGid': owner_gid,
            'ownerMustBeUnprivileged': True,
            'rootConfigMode': '0400',
        },
    }


def verify(output, source_root=REPO):
    output = Path(output)
    if output.is_symlink() or not output.is_dir() or stat.S_IMODE(output.stat().st_mode) != 0o555:
        raise ValueError('hosted-root-package-directory-invalid')
    if {entry.name for entry in output.iterdir()} != {
        DAEMON_NAME, HANDOFF_NAME, LOCK_NAME, MANIFEST_NAME, RECEIPT_NAME,
    }:
        raise ValueError('hosted-root-package-files-invalid')
    daemon = exact_file(output / DAEMON_NAME, 0o555)
    handoff = exact_file(output / HANDOFF_NAME, 0o555)
    lock_bytes = exact_file(output / LOCK_NAME, 0o444)
    manifest_bytes = exact_file(output / MANIFEST_NAME, 0o444)
    receipt = exact_file(output / RECEIPT_NAME, 0o444)
    if receipt != f'{sha256(manifest_bytes)}  {MANIFEST_NAME}\n'.encode():
        raise ValueError('hosted-root-package-receipt-invalid')
    manifest = json.loads(manifest_bytes)
    expected = render_manifest(daemon, handoff, lock_bytes, manifest['sourceRevision'],
                               manifest['installation']['ownerUid'], manifest['installation']['ownerGid'],
                               manifest['buildTool']['executableSha256'], source_root)
    if manifest != expected or manifest_bytes != canonical(expected):
        raise ValueError('hosted-root-package-manifest-invalid')
    return sha256(manifest_bytes)


def assemble(daemon_path, output, revision, owner_uid, owner_gid, compiler_sha256,
             source_root=REPO):
    output = Path(output)
    if not output.is_absolute() or output.exists() or output.is_symlink():
        raise ValueError('hosted-root-package-output-invalid')
    daemon = exact_file(daemon_path)
    handoff = exact_file(source_path(source_root, 'deploy/hosted-opencode-fd3-handoff/handoff.py'))
    lock_bytes = exact_file(source_path(source_root, 'deploy/hosted-opencode-image/artifact-lock.json'))
    manifest = render_manifest(daemon, handoff, lock_bytes, revision, owner_uid, owner_gid,
                               compiler_sha256, source_root)
    output.mkdir(mode=0o700)
    try:
        for name, data, mode in (
            (DAEMON_NAME, daemon, 0o555),
            (HANDOFF_NAME, handoff, 0o555),
            (LOCK_NAME, lock_bytes, 0o444),
            (MANIFEST_NAME, canonical(manifest), 0o444),
        ):
            with (output / name).open('xb') as target:
                target.write(data)
                target.flush()
                os.fsync(target.fileno())
            (output / name).chmod(mode)
        receipt = f'{sha256(canonical(manifest))}  {MANIFEST_NAME}\n'.encode()
        (output / RECEIPT_NAME).write_bytes(receipt)
        (output / RECEIPT_NAME).chmod(0o444)
        output.chmod(0o555)
        return verify(output, source_root)
    except Exception:
        output.chmod(0o700)
        shutil.rmtree(output)
        raise


def run(args):
    result = subprocess.run(args, cwd=REPO, capture_output=True, text=True, check=True,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC'})
    return result.stdout.strip()


def compile_repeated(bun_path, snapshot, binary, temporary):
    command = [
        str(bun_path), 'build', str(source_path(snapshot,
            'src/entrypoints/hostedOpenCodeRootDaemon.ts')), '--compile', '--target=bun-linux-x64',
        '--format=esm', '--packages=bundle', '--conditions=bun',
        '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
        '--compile-exec-argv=', '--outfile', str(binary),
    ]
    environment = {
        'PATH': f'{bun_path.parent}:/usr/bin:/bin', 'LANG': 'C',
        'LC_ALL': 'C', 'TZ': 'UTC', 'HOME': str(temporary),
    }
    first_digest = None
    for _ in range(2):
        if binary.exists():
            binary.unlink()
        subprocess.run(command, cwd=snapshot, check=True, env=environment)
        digest = sha256(exact_file(binary))
        if first_digest is not None and digest != first_digest:
            raise ValueError('hosted-root-package-compile-nondeterministic')
        first_digest = digest
    return first_digest


def build(output, owner_uid, owner_gid, bun_archive):
    owner_id(owner_uid)
    owner_id(owner_gid)
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise ValueError('hosted-root-package-build-host-invalid')
    revision = run(['/usr/bin/git', 'rev-parse', 'HEAD'])
    if run(['/usr/bin/git', 'status', '--porcelain', '--untracked-files=normal']):
        raise ValueError('hosted-root-package-source-dirty')
    with tempfile.TemporaryDirectory(prefix='hosted-root-daemon-build-') as temporary:
        bun_path = extract_bun(bun_archive, Path(temporary) / 'bun')
        if run([str(bun_path), '--version']) != '1.4.2':
            raise ValueError('hosted-root-package-bun-version-invalid')
        snapshot = committed_snapshot(revision, Path(temporary) / 'source')
        copy_dependencies(snapshot)
        binary = Path(temporary) / DAEMON_NAME
        compile_repeated(bun_path, snapshot, binary, temporary)
        return assemble(binary, output, revision, owner_uid, owner_gid,
                        BUN_EXECUTABLE_SHA256, snapshot)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--output-dir', help='new absolute output directory; compile but never install')
    action.add_argument('--verify', help='verify existing package directory without execution')
    parser.add_argument('--owner-uid', help='dedicated unprivileged Owner UID')
    parser.add_argument('--owner-gid', help='dedicated unprivileged Owner GID')
    parser.add_argument('--bun-archive', help='absolute path to official Bun v1.4.2 Linux x64 zip')
    args = parser.parse_args()
    if args.verify:
        print(verify(args.verify))
    else:
        if args.owner_uid is None or args.owner_gid is None or args.bun_archive is None:
            parser.error('--owner-uid, --owner-gid and --bun-archive are required')
        print(build(args.output_dir, args.owner_uid, args.owner_gid, args.bun_archive))
