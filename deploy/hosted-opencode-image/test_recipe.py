import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


config = module('hosted_inert_config', 'build-config.py')
image = module('hosted_image_context', 'prepare-context.py')
plugin = module('hosted_owner_plugin_build', 'build-plugin.py')


class ImageAndConfigContractTest(unittest.TestCase):
    def test_inert_config_is_exact_deterministic_and_denies_every_tool(self):
        spec = json.loads((HERE / 'inert-config-spec.json').read_text())
        first = config.render(spec)
        second = config.render(dict(reversed(list(spec.items()))))
        self.assertEqual(first, second)
        self.assertEqual(hashlib.sha256(first).hexdigest(),
                         '7de5c79fd8fcb2ba249f1ef0bd18a23e48cf417ef9fd9ecc310c96ce51cc3367')
        self.assertEqual(json.loads(first), {'permission': {'*': 'deny'}, 'plugin': [], 'share': 'disabled'})

    def test_config_rejects_provider_credentials_or_unknown_spec_fields(self):
        for extra in ({'provider': {'local': {}}}, {'apiKey': 'secret'}, {'mode': 'local-model'}):
            with self.subTest(extra=extra):
                with self.assertRaisesRegex(ValueError, 'spec-invalid'):
                    config.render({'schemaVersion': 1, 'mode': 'deny-all-inert', **extra})

    def test_owner_config_references_only_locked_plugin_and_five_allowed_tools(self):
        spec = json.loads((HERE / 'owner-plugin-config-spec.json').read_text())
        rendered = config.render(spec)
        parsed = json.loads(rendered)
        self.assertEqual(parsed['plugin'], [config.OWNER_PLUGIN_URL])
        self.assertEqual(parsed['share'], 'disabled')
        self.assertEqual(parsed['permission'], {
            '*': 'deny', **{name: 'allow' for name in config.OWNER_TOOLS},
        })
        self.assertEqual(set(parsed), {'plugin', 'permission', 'share'})
        self.assertEqual(spec['pluginSha256'], image.approved_lock()['pluginSha256'])
        self.assertEqual(rendered, config.render(dict(reversed(list(spec.items())))))
        for extra in ({'provider': {'local': {}}}, {'pluginSha256': '0' * 64},
                      {'plugin': ['npm:unreviewed']}):
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'spec-invalid'):
                config.render({**spec, **extra})

    def test_local_qwen_config_pins_one_model_bounded_output_and_owner_tools(self):
        spec = json.loads((HERE / 'owner-local-qwen-config-spec.json').read_text())
        gateway = 'http://172.27.0.1:19017/v1'
        rendered = config.render(spec, gateway)
        self.assertEqual(rendered, config.render(dict(reversed(list(spec.items()))), gateway))
        parsed = json.loads(rendered)
        self.assertEqual(parsed, {
            **config.OWNER_CONFIG,
            'autoupdate': False,
            'snapshot': False,
            'enabled_providers': ['local-llama'],
            'model': 'local-llama/qwen3-8b',
            'provider': {'local-llama': {
                'npm': '@ai-sdk/openai-compatible',
                'name': 'Lease-local Qwen',
                'options': {'baseURL': gateway},
                'models': {'qwen3-8b': {
                    'name': 'Qwen3 8B', 'tool_call': True,
                    'limit': {'context': 8192, 'output': 128},
                }},
            }},
        })
        self.assertEqual(spec['pluginSha256'], image.approved_lock()['pluginSha256'])
        self.assertEqual(parsed['permission'], {
            '*': 'deny', **{name: 'allow' for name in config.OWNER_TOOLS},
        })
        self.assertTrue(0 < parsed['provider']['local-llama']['models']['qwen3-8b']['limit']['output'] < 8192)
        self.assertNotIn('apiKey', rendered.decode())

    def test_local_qwen_config_rejects_unclaimed_or_mutable_endpoint(self):
        spec = json.loads((HERE / 'owner-local-qwen-config-spec.json').read_text())
        with self.assertRaisesRegex(ValueError, 'gateway-url-invalid'):
            config.render(spec)
        for gateway in (
            'http://127.0.0.1:18993/v1', 'http://169.254.1.1:19017/v1',
            'http://8.8.8.8:19017/v1', 'https://172.27.0.1:19017/v1',
            'http://172.27.0.1:19017/v1?apiKey=secret',
            'http://user@172.27.0.1:19017/v1', 'http://172.27.0.1:0/v1',
            'http://172.27.0.1:19017/v1/extra', 'http://172.027.0.1:19017/v1',
        ):
            with self.subTest(gateway=gateway), self.assertRaisesRegex(ValueError, 'gateway-url-invalid'):
                config.render(spec, gateway)
        with self.assertRaisesRegex(ValueError, 'gateway-url-unexpected'):
            config.render(config.OWNER_SPEC, 'http://172.27.0.1:19017/v1')
        with self.assertRaisesRegex(ValueError, 'spec-invalid'):
            config.render({**spec, 'output': 8192}, 'http://172.27.0.1:19017/v1')

    def test_plugin_bundle_is_exact_and_loads_only_five_hooks_without_fd3(self):
        with tempfile.TemporaryDirectory(prefix='hosted-plugin-build-test-') as root:
            artifact = Path(root, 'hosted-owner-plugin.mjs')
            receipt = plugin.build(str(artifact))
            self.assertEqual(receipt['pluginSha256'], image.approved_lock()['pluginSha256'])
            self.assertEqual(stat.S_IMODE(artifact.stat().st_mode), 0o444)
            script = '''const { default: plugin } = await import(process.argv[1]);
const hooks = await plugin();
console.log(JSON.stringify(Object.keys(hooks.tool).sort()));
'''
            result = subprocess.run(['bun', '-e', script, artifact.as_uri()],
                                    capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout), sorted(config.OWNER_TOOLS))

    def test_image_context_copies_exact_plugin_read_only_and_rejects_tampering(self):
        with tempfile.TemporaryDirectory(prefix='hosted-plugin-context-test-') as root:
            root = Path(root)
            archive = root / 'opencode-linux-x64.tar.gz'
            binary = b'\x7fELFsynthetic-official-test-binary'
            with tarfile.open(archive, 'w:gz') as tar:
                member = tarfile.TarInfo('opencode')
                member.size = len(binary)
                tar.addfile(member, io.BytesIO(binary))
            bootstrap = root / 'bootstrap'
            bootstrap.write_bytes(b'\x7fELFsynthetic-reviewed-bootstrap')
            artifact = root / 'hosted-owner-plugin.mjs'
            plugin.build(str(artifact))
            lock = image.approved_lock()
            lock.update({
                'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
                'binarySha256': hashlib.sha256(binary).hexdigest(),
                'bootstrapSha256': hashlib.sha256(bootstrap.read_bytes()).hexdigest(),
            })
            lock_path = root / 'lock.json'
            lock_path.write_text(json.dumps(lock))
            output = root / 'context'
            with patch.object(image, 'ARCHIVE_SHA', lock['archiveSha256']), \
                 patch.object(image, 'BINARY_SHA', lock['binarySha256']):
                receipt = image.prepare(str(archive), str(bootstrap), str(artifact), str(output), lock_path)
                copied = output / 'hosted-owner-plugin.mjs'
                self.assertEqual(copied.read_bytes(), artifact.read_bytes())
                self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o444)
                self.assertEqual(receipt['pluginSha256'], lock['pluginSha256'])
                self.assertIn(lock['pluginSha256'], (output / 'Dockerfile').read_text())
                tampered = root / 'tampered.mjs'
                tampered.write_bytes(artifact.read_bytes() + b'\n')
                with self.assertRaisesRegex(ValueError, 'plugin-digest-mismatch'):
                    image.prepare(str(archive), str(bootstrap), str(tampered),
                                  str(root / 'tampered-context'), lock_path)
                self.assertFalse((root / 'tampered-context').exists())

    def test_config_parent_walk_rejects_mutable_or_symlinked_ancestor(self):
        with tempfile.TemporaryDirectory(prefix='hosted-config-parent-test-') as root:
            anchor = Path(root)
            mutable = anchor / 'mutable'
            mutable.mkdir(mode=0o700)
            link = anchor / 'link'
            link.symlink_to(mutable, target_is_directory=True)
            anchor_fd = os.open(anchor, config.DIRECTORY_FLAGS)
            try:
                mutable.chmod(0o777)
                with self.assertRaisesRegex(ValueError, 'parent-invalid'):
                    config.descend_trusted(anchor_fd, ['mutable'], os.getuid(), os.getgid())
                with self.assertRaises(OSError):
                    config.descend_trusted(anchor_fd, ['link'], os.getuid(), os.getgid())
            finally:
                os.close(anchor_fd)

    def test_config_dirfd_remains_bound_after_path_swap(self):
        with tempfile.TemporaryDirectory(prefix='hosted-config-swap-test-') as root:
            anchor = Path(root)
            original = anchor / 'original'
            moved = anchor / 'moved'
            bait = anchor / 'bait'
            original.mkdir(mode=0o700)
            bait.mkdir(mode=0o700)
            anchor_fd = os.open(anchor, config.DIRECTORY_FLAGS)
            try:
                parent_fd = config.descend_trusted(anchor_fd, ['original'], os.getuid(), os.getgid())
                try:
                    original.rename(moved)
                    original.symlink_to(bait, target_is_directory=True)
                    os.mkdir('config', mode=0o700, dir_fd=parent_fd)
                    self.assertTrue((moved / 'config').is_dir())
                    self.assertFalse((bait / 'config').exists())
                finally:
                    os.close(parent_fd)
            finally:
                os.close(anchor_fd)

    def test_image_context_rejects_unreviewed_bootstrap_lock(self):
        with tempfile.TemporaryDirectory(prefix='hosted-image-recipe-test-') as root:
            archive = Path(root, 'archive')
            bootstrap = Path(root, 'bootstrap')
            output = Path(root, 'context')
            lock_path = Path(root, 'lock.json')
            lock = json.loads((HERE / 'artifact-lock.json').read_text())
            lock['status'] = 'inactive-pending-bootstrap-review'
            lock['bootstrapSha256'] = None
            lock_path.write_text(json.dumps(lock))
            archive.write_bytes(b'not-an-official-archive')
            bootstrap.write_bytes(b'not-a-reviewed-bootstrap')
            with self.assertRaisesRegex(ValueError, 'lock-not-reviewed'):
                image.prepare(str(archive), str(bootstrap), str(bootstrap), str(output), lock_path)
            self.assertFalse(output.exists())

    def test_image_lock_accepts_only_reviewed_current_bootstrap_digest(self):
        lock = image.approved_lock()
        self.assertEqual(lock['bootstrapSha256'],
                         'af0644070946ef34bef205c1940b02bd76a09ffcef4b5cffb8b072ae04ca32e6')
        self.assertEqual(lock['pluginSha256'], plugin.EXPECTED_SHA)
        dockerfile = (HERE / 'Dockerfile.template').read_text()
        self.assertIn('COPY --chown=0:0 --chmod=0444 hosted-owner-plugin.mjs ' +
                      '/usr/local/lib/agentteams/hosted-owner-plugin.mjs', dockerfile)
        self.assertEqual(dockerfile.count('@PLUGIN_SHA256@'), 1)

    def test_image_lock_rejects_archive_or_base_drift(self):
        lock = json.loads((HERE / 'artifact-lock.json').read_text())
        lock['status'] = 'reviewed'
        lock['bootstrapSha256'] = 'a' * 64
        with tempfile.TemporaryDirectory(prefix='hosted-image-lock-test-') as root:
            path = Path(root, 'lock.json')
            for field, value in [('archiveSha256', 'b' * 64),
                                 ('pluginSha256', 'd' * 64),
                                 ('baseImage', 'ubuntu:latest'),
                                 ('sourceCommit', 'c' * 40)]:
                with self.subTest(field=field):
                    changed = {**lock, field: value}
                    path.write_text(json.dumps(changed))
                    with self.assertRaisesRegex(ValueError, 'lock-not-reviewed'):
                        image.approved_lock(path)


if __name__ == '__main__':
    unittest.main()
