"""Linux/Python 3 offline OS-pipe regression, wired by runtime.status-stdout.test.ts.

Derived from /tmp/ariel-status-stdout-artifacts/reproduce.py. Run directly with:
python3 runtime-status-stalled-pipe.py /absolute/bun /absolute/fixture.ts /absolute/runtime.ts
"""
import json
import subprocess
import sys
import tempfile
import time


def probe(bun, fixture, handler, stalled):
    with tempfile.TemporaryDirectory(prefix='runtime-status-pipe-') as isolated:
        child = subprocess.Popen(
            [bun, fixture, handler, 'large'], cwd=isolated,
            env={'PATH': '', 'HOME': isolated, 'XDG_CONFIG_HOME': isolated,
                 'XDG_CACHE_HOME': isolated, 'NODE_ENV': 'test'},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        started = time.monotonic()
        try:
            if stalled:
                # No reader touches stdout during or beyond the two-second
                # drain deadline. Assert bounded exit BEFORE collecting bytes.
                time.sleep(3)
                child.wait(timeout=2)
            exited_before_drain = child.poll() is not None
            stdout, stderr = child.communicate(timeout=5)
            elapsed_ms = round((time.monotonic() - started) * 1000)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            child.stdout.close()
            child.stderr.close()

    try:
        payload = json.loads(stdout)
        valid_json = True
    except ValueError:
        payload = None
        valid_json = False
    result = {
        'exitCode': child.returncode, 'stdoutBytes': len(stdout),
        'stderr': stderr.decode(), 'validJson': valid_json,
        'exitedBeforeDrain': exited_before_drain, 'elapsedMs': elapsed_ms,
    }
    if stalled:
        assert exited_before_drain, result
        assert child.returncode == 1, result
        assert stderr == b'Runtime status failed: Timed out writing runtime command stdout\n', result
        assert 0 < len(stdout) < 2 * 1024 * 1024, result
        assert not valid_json, result
    else:
        assert child.returncode == 0 and stderr == b'', result
        assert valid_json, result
        assert payload['providers']['opencode']['models'] == ['x' * (2 * 1024 * 1024)], result
        assert stdout.endswith(b'\n'), result
    return result


if __name__ == '__main__':
    if sys.platform != 'linux':
        print('SKIP runtime status OS pipe regression: requires Linux')
        sys.exit(0)
    bun, fixture, handler = sys.argv[1:]
    print(json.dumps({
        'stalled': probe(bun, fixture, handler, True),
        'consumed': probe(bun, fixture, handler, False),
    }, indent=2))
