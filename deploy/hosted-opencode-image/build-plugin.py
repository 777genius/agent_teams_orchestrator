#!/usr/bin/env python3
"""Build the reviewed, self-contained official OpenCode FD3 plugin offline."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ENTRY = ROOT / 'src/services/hostedControl/openCodePlugin/HostedOwnerPluginEntry.ts'
EXPECTED_BUN = '1.3.11'
EXPECTED_ZOD = '4.3.6'
EXPECTED_SHA = '805df9de2239792c47bb040961110ae44f9bbbd4afd6bb821dcf497be4357f4c'


def build(output_path):
    output = Path(output_path)
    if not output.is_absolute() or output.exists() or output.is_symlink() or not output.parent.is_dir():
        raise ValueError('hosted-owner-plugin-output-invalid')
    lock = json.loads((HERE / 'artifact-lock.json').read_text())
    if lock.get('pluginSha256') != EXPECTED_SHA:
        raise ValueError('hosted-owner-plugin-lock-invalid')
    bun_lock = (ROOT / 'bun.lock').read_text()
    if len(re.findall(r'^\s*"zod": \["zod@([^" ]+)"', bun_lock, re.MULTILINE)) != 1 or not re.search(
            rf'^\s*"zod": \["zod@{re.escape(EXPECTED_ZOD)}"', bun_lock, re.MULTILINE):
        raise ValueError('hosted-owner-plugin-zod-lock-invalid')
    if json.loads((ROOT / 'node_modules/zod/package.json').read_text())['version'] != EXPECTED_ZOD:
        raise ValueError('hosted-owner-plugin-zod-install-invalid')
    bun = shutil.which('bun')
    if not bun or subprocess.check_output([bun, '--version'], text=True).strip() != EXPECTED_BUN:
        raise ValueError('hosted-owner-plugin-bun-version-invalid')
    with tempfile.TemporaryDirectory(prefix='hosted-owner-plugin-build-') as temp:
        artifact = Path(temp) / 'hosted-owner-plugin.mjs'
        subprocess.run([bun, 'build', str(ENTRY), '--target=bun', '--format=esm',
                        '--minify', '--outfile', str(artifact)], cwd=ROOT, check=True,
                       capture_output=True, text=True)
        content = artifact.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest != EXPECTED_SHA:
            raise ValueError('hosted-owner-plugin-digest-mismatch')
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
        try:
            cursor = 0
            while cursor < len(content):
                cursor += os.write(fd, content[cursor:])
            os.fsync(fd)
            os.fchmod(fd, 0o444)
        finally:
            os.close(fd)
        return {'pluginSha256': digest, 'bytes': len(content)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.output), sort_keys=True, separators=(',', ':')))
