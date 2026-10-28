#!/usr/bin/env python3
"""Publish source drafts only after their exact stable binary delivery is public."""
import argparse
import json
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor

SOURCE = '777genius/agent_teams_orchestrator'
BINARIES = '777genius/agent_teams_orchestrator_binaries'


def command(*args):
    return subprocess.check_output(args, text=True).strip()


def gh_json(path):
    return json.loads(command('gh', 'api', path))


def releases(repo):
    pages = json.loads(command('gh', 'api', '--paginate', '--slurp',
                               f'repos/{repo}/releases?per_page=100'))
    return [release for page in pages for release in page]


def public_json(url):
    # curl has no GitHub authentication. Never forward GH_TOKEN to a download.
    return json.loads(command('curl', '--fail', '--silent', '--show-error',
                              '--location', '--retry', '3', url))


def verify_delivery(tag):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError(f'Unsupported stable tag: {tag}')
    version = tag[1:]
    binary_tag = f'runtime-{tag}'
    release = public_json(f'https://api.github.com/repos/{BINARIES}/releases/tags/{binary_tag}')
    if release['draft'] or release['prerelease'] or release['tag_name'] != binary_tag:
        raise ValueError('Binary release is not the matching published stable release')
    base = f'https://github.com/{BINARIES}/releases/download/{binary_tag}/'
    manifest_name = f'agent-teams-runtime-manifest-{tag}.json'
    sums_name = f'agent-teams-runtime-SHA256SUMS-{tag}'
    manifest = public_json(base + manifest_name)
    source_commit = gh_json(f'repos/{SOURCE}/commits/{tag}')['sha']
    if (manifest.get('version') != version
            or manifest.get('sourceRepository') != SOURCE
            or manifest.get('sourceRef') != tag
            or manifest.get('sourceCommit') != source_commit):
        raise ValueError('Binary manifest does not identify the exact source tag commit')
    assets = manifest['assets']
    required = {'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'}
    # Older delivered versions predate Windows ARM64 support.
    if not required.issubset(assets) or set(assets) - (required | {'win32-arm64'}):
        raise ValueError('Binary manifest has an incomplete or unknown platform set')
    expected = {manifest_name, sums_name}
    for platform, asset in assets.items():
        extension = 'zip' if platform.startswith('win32-') else 'tar.gz'
        name = f'agent-teams-runtime-{platform}-{tag}.{extension}'
        if asset['file'] != name or not re.fullmatch(r'[a-f0-9]{64}', asset['sha256']):
            raise ValueError(f'Invalid manifest asset for {platform}')
        expected.add(name)
    actual = {asset['name'] for asset in release['assets'] if asset['size'] > 0}
    if not expected.issubset(actual):
        raise ValueError(f'Missing uploaded assets: {sorted(expected - actual)}')
    sums = command('curl', '--fail', '--silent', '--show-error', '--location',
                   '--retry', '3', base + sums_name)
    checksums = {line.split()[1].lstrip('*'): line.split()[0]
                 for line in sums.splitlines() if len(line.split()) == 2}
    for asset in assets.values():
        if checksums.get(asset['file']) != asset['sha256']:
            raise ValueError(f'Checksum list disagrees with manifest: {asset["file"]}')
    # HEAD follows the real anonymous asset URL without downloading gigabytes.
    def check(name):
        command('curl', '--fail', '--silent', '--show-error', '--location',
                '--head', '--output', '/dev/null', '--retry', '3', base + name)
    with ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(check, sorted(expected)))
    return source_commit


def promote(tag, apply=False, source_id=None):
    commit = verify_delivery(tag)
    # Check current state after validation. Do not change existing public releases.
    if source_id is None:
        matches = [r for r in releases(SOURCE) if r['tag_name'] == tag]
        if len(matches) != 1:
            raise ValueError(f'Expected one source release for {tag}, found {len(matches)}')
        source_id = matches[0]['id']
    source = gh_json(f'repos/{SOURCE}/releases/{source_id}')
    if source['tag_name'] != tag:
        raise ValueError('Source release tag changed during validation')
    if not source['draft']:
        return {'tag': tag, 'status': 'already-public', 'commit': commit}
    if source['prerelease']:
        raise ValueError('Source draft is marked prerelease; refusing stable promotion')
    if apply:
        command('gh', 'api', '--method', 'PATCH',
                f'repos/{SOURCE}/releases/{source["id"]}',
                '-F', 'draft=false', '-f', 'make_latest=false')
        published = public_json(f'https://api.github.com/repos/{SOURCE}/releases/tags/{tag}')
        if published['draft'] or published['prerelease']:
            raise ValueError('Source publication did not become public and stable')
    return {'tag': tag, 'status': 'published' if apply else 'ready', 'commit': commit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Publish verified source drafts')
    parser.add_argument('--tag', help='Check one exact source tag instead of all eligible drafts')
    args = parser.parse_args()
    if args.tag:
        tags = [args.tag]
        source_ids = {}
    else:
        stable = {r['tag_name'] for r in releases(BINARIES)
                  if not r['draft'] and not r['prerelease']}
        source_ids = {r['tag_name']: r['id'] for r in releases(SOURCE)
                      if r['draft'] and not r['prerelease'] and f'runtime-{r["tag_name"]}' in stable}
        tags = list(source_ids)
        tags.sort(key=lambda t: tuple(map(int, t[1:].split('.'))))
    failed = False
    for tag in tags:
        try:
            result = promote(tag, args.apply, source_ids.get(tag))
        except (ValueError, KeyError, subprocess.CalledProcessError) as error:
            failed = True
            result = {'tag': tag, 'status': 'blocked', 'reason': str(error)}
        print(json.dumps(result), flush=True)
    if failed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
