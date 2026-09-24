import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('hosted_root_package', HERE / 'package.py')
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)
COMPILER_SHA256 = package.BUN_EXECUTABLE_SHA256


class RootDaemonPackageTest(unittest.TestCase):
    def test_inert_manifest_is_stable_and_verifies_exact_files(self):
        with tempfile.TemporaryDirectory(prefix='hosted-root-package-test-') as root:
            source = Path(root, 'daemon')
            source.write_bytes(b'\x7fELFsynthetic-daemon')
            output = Path(root, 'output')
            revision = 'a' * 40
            digest = package.assemble(source, output, revision, 1401, 1402, COMPILER_SHA256)
            self.assertEqual(digest, package.verify(output))
            self.assertEqual(stat.S_IMODE((output / package.DAEMON_NAME).stat().st_mode), 0o555)
            self.assertEqual((output / package.HANDOFF_NAME).read_bytes(), package.HANDOFF_SOURCE.read_bytes())
            manifest = json.loads((output / package.MANIFEST_NAME).read_bytes())
            self.assertEqual(manifest['activation'], 'disabled')
            self.assertEqual(manifest['installation']['ownerUid'], 1401)
            self.assertEqual(manifest['installation']['ownerGid'], 1402)
            self.assertEqual(manifest['installation']['installedOwnerUid'], 0)
            self.assertEqual(manifest['officialOpenCode']['runtimeMode'], 'official-v1.18.32')
            self.assertFalse(manifest['officialOpenCode']['hostLocalBinaryFallback'])
            self.assertIsNone(manifest['officialOpenCode']['imageManifestDigest'])
            self.assertEqual(manifest['officialOpenCode']['binarySha256'],
                             package.approved_image_lock()['binarySha256'])
            other = Path(root, 'other')
            self.assertEqual(package.assemble(source, other, revision, 1401, 1402, COMPILER_SHA256), digest)
            for name in (package.DAEMON_NAME, package.HANDOFF_NAME, package.LOCK_NAME, package.MANIFEST_NAME,
                         package.RECEIPT_NAME):
                self.assertEqual((output / name).read_bytes(), (other / name).read_bytes())

    def test_tampering_and_extra_files_fail_verification(self):
        with tempfile.TemporaryDirectory(prefix='hosted-root-package-test-') as root:
            source = Path(root, 'daemon')
            source.write_bytes(b'\x7fELFsynthetic-daemon')
            output = Path(root, 'output')
            package.assemble(source, output, 'b' * 40, 1401, 1402, COMPILER_SHA256)
            (output / package.DAEMON_NAME).chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'mode-invalid'):
                package.verify(output)
            (output / package.DAEMON_NAME).chmod(0o555)
            (output / package.DAEMON_NAME).chmod(0o755)
            (output / package.DAEMON_NAME).write_bytes(b'\x7fELFtampered-daemon')
            (output / package.DAEMON_NAME).chmod(0o555)
            with self.assertRaisesRegex(ValueError, 'manifest-invalid'):
                package.verify(output)
            output.chmod(0o755)
            (output / 'unexpected').write_text('x')
            output.chmod(0o555)
            with self.assertRaisesRegex(ValueError, 'files-invalid'):
                package.verify(output)

    def test_rejects_root_owner_identity_and_unreviewed_image_lock(self):
        daemon = b'\x7fELFsynthetic-daemon'
        handoff = package.HANDOFF_SOURCE.read_bytes()
        lock = package.LOCK.read_bytes()
        with self.assertRaisesRegex(ValueError, 'owner-id-invalid'):
            package.render_manifest(daemon, handoff, lock, 'c' * 40, 0, 1402, COMPILER_SHA256)
        modified = {**json.loads(lock), 'binarySha256': '0' * 64}
        with self.assertRaisesRegex(ValueError, 'image-lock-invalid'):
            package.render_manifest(daemon, handoff, package.canonical(modified), 'c' * 40, 1401, 1402,
                                    COMPILER_SHA256)
        with self.assertRaisesRegex(ValueError, 'input-invalid'):
            package.render_manifest(b'not an ELF', handoff, lock, 'c' * 40, 1401, 1402,
                                    COMPILER_SHA256)

    def test_build_refuses_dirty_source_before_compilation(self):
        with patch.object(package.platform, 'system', return_value='Linux'), \
             patch.object(package.platform, 'machine', return_value='x86_64'), \
             patch.object(package, 'run', side_effect=['d' * 40, ' M src/file.ts']):
            with self.assertRaisesRegex(ValueError, 'source-dirty'):
                package.build('/tmp/unused-hosted-root-package', 1401, 1402, '/tmp/unused-bun.zip')

    def test_committed_snapshot_ignores_later_worktree_edits(self):
        with tempfile.TemporaryDirectory(prefix='hosted-root-source-test-') as root:
            repo = Path(root, 'repo')
            repo.mkdir()
            subprocess.run(['/usr/bin/git', 'init', '-q', str(repo)], check=True)
            script = repo / 'deploy/hosted-root-daemon/package.py'
            script.parent.mkdir(parents=True)
            script.write_bytes((HERE / 'package.py').read_bytes())
            payload = repo / 'payload.txt'
            payload.write_text('committed\n')
            subprocess.run(['/usr/bin/git', '-C', str(repo), 'add', '.'], check=True)
            identity_env = {**os.environ, 'GIT_AUTHOR_NAME': 'iliya',
                            'GIT_AUTHOR_EMAIL': 'iliyazelenkog@gmail.com',
                            'GIT_COMMITTER_NAME': 'iliya',
                            'GIT_COMMITTER_EMAIL': 'iliyazelenkog@gmail.com'}
            for variable in ('GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT'):
                identity = subprocess.check_output(['/usr/bin/git', '-C', str(repo), 'var', variable],
                                                   text=True, env=identity_env)
                self.assertTrue(identity.startswith('iliya <iliyazelenkog@gmail.com> '))
            subprocess.run(['/usr/bin/git', '-C', str(repo), '-c', 'user.name=iliya',
                            '-c', 'user.email=iliyazelenkog@gmail.com', 'commit', '-qm',
                            'test: create snapshot fixture'], check=True,
                           env=identity_env)
            revision = subprocess.check_output(['/usr/bin/git', '-C', str(repo), 'rev-parse', 'HEAD'],
                                               text=True).strip()
            payload.write_text('changed after commit\n')
            with patch.object(package, 'REPO', repo):
                snapshot = package.committed_snapshot(revision, Path(root, 'snapshot'))
            self.assertEqual((snapshot / 'payload.txt').read_text(), 'committed\n')


if __name__ == '__main__':
    unittest.main()
