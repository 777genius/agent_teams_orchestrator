#!/usr/bin/env python3
"""Prove native Codex conversation persistence with a scripted local provider.

Usage: python3 scripts/codex-native-continuity-spike.py --codex /path/to/codex

Python standard library only. This is a native CLI/protocol/storage spike, not
an orchestrator E2E or a live-model recall test. It creates disposable TEST
projects/profiles, never reads personal auth, never changes system config, and
fails rather than disabling inherited managed configuration. Run on a clean CI
worker if the host's system config is incompatible with the pinned Codex CLI.
"""

import argparse
from contextlib import contextmanager
import gzip
import http.server
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid


class SpikeFailure(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise SpikeFailure(message)


class ScriptedResponses(http.server.ThreadingHTTPServer):
    """Capture exact model input and return one final text item per request."""

    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ResponsesHandler)
        self.requests = []
        self.replies = []
        self.errors = []
        self.lock = threading.Lock()
        self.worker = threading.Thread(target=self.serve_forever, daemon=True)
        self.worker.start()

    def prepare(self, replies):
        with self.lock:
            self.requests = []
            self.errors = []
            self.replies = list(replies)

    def close(self):
        self.shutdown()
        self.server_close()
        self.worker.join(timeout=5)


class ResponsesHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_error(404, "Only the local Responses fixture is available")

    def do_POST(self):
        try:
            require(self.path == "/v1/responses", "Unexpected provider request path")
            size = int(self.headers.get("content-length", "0"))
            require(0 < size <= 4 * 1024 * 1024, "Provider request body exceeds test budget")
            body = self.rfile.read(size)
            encoding = self.headers.get("content-encoding", "identity")
            if encoding == "gzip":
                body = gzip.decompress(body)
            else:
                require(encoding == "identity", f"Unsupported fixture encoding: {encoding}")
            request = json.loads(body)
            with self.server.lock:
                self.server.requests.append(request)
                require(bool(self.server.replies), "Unexpected extra model submission")
                answer = self.server.replies.pop(0)
                number = len(self.server.requests)
            response_id = f"resp_continuity_{number}"
            item = {
                "type": "message", "id": f"msg_continuity_{number}",
                "role": "assistant", "status": "completed", "phase": "final_answer",
                "content": [{"type": "output_text", "text": answer, "annotations": []}],
            }
            response = {
                "id": response_id, "object": "response", "status": "completed",
                "model": "test-continuity-model", "output": [item],
                "usage": {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25,
                          "input_tokens_details": {"cached_tokens": 0},
                          "output_tokens_details": {"reasoning_tokens": 0}},
            }
            events = [
                {"type": "response.created", "response": {
                    **response, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0,
                 "item": {**item, "status": "in_progress", "content": []}},
                {"type": "response.output_text.delta", "item_id": item["id"],
                 "output_index": 0, "content_index": 0, "delta": answer},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
            ]
            data = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                           for event in events).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as error:
            with self.server.lock:
                self.server.errors.append(str(error))
            self.send_error(400, "Continuity fixture rejected the request")


def child_env(home):
    env = dict(os.environ)
    for name in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL",
                 "CODEX_ACCESS_TOKEN", "OPENAI_ACCESS_TOKEN"):
        env.pop(name, None)
    # Override inherited SQLite location as well as profile location. Neither
    # the user profile nor a managed runtime's database is part of this test.
    env.update(CODEX_HOME=str(home), CODEX_SQLITE_HOME=str(home),
               NO_PROXY="127.0.0.1,localhost", no_proxy="127.0.0.1,localhost",
               RUST_LOG="error")
    return env


def provider_args(server, home):
    overrides = [
        'model="test-continuity-model"', 'model_provider="continuity_fixture"',
        'model_providers.continuity_fixture.name="Continuity Fixture"',
        f'model_providers.continuity_fixture.base_url="http://127.0.0.1:{server.server_port}/v1"',
        'model_providers.continuity_fixture.wire_api="responses"',
        'model_providers.continuity_fixture.requires_openai_auth=false',
        'model_providers.continuity_fixture.supports_websockets=false',
        'features.shell_tool=false', 'features.remote_models=false',
        'analytics.enabled=false',
        # A configured sqlite_home takes precedence over CODEX_SQLITE_HOME in
        # Codex 0.135.0. Keep the catalog private even with inherited config.
        'sqlite_home=' + json.dumps(str(home)),
    ]
    return [part for override in overrides for part in ("-c", override)]


@contextmanager
def fresh_overlay(case_root, sessions):
    home = Path(tempfile.mkdtemp(prefix="overlay-", dir=case_root))
    link = home / "sessions"
    try:
        if os.name == "nt":
            subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(link), str(sessions)],
                           check=True, capture_output=True, text=True, timeout=10)
        else:
            link.symlink_to(sessions, target_is_directory=True)
        require(sorted(p.name for p in home.iterdir()) == ["sessions"],
                "Fresh overlay unexpectedly imported a profile/database/index")
        yield home
    finally:
        # shutil.rmtree does not follow directory symlinks (or Windows junctions
        # on supported Python). The caller verifies persistent sentinels survive.
        shutil.rmtree(home)


def parse_exec_events(stdout):
    result = []
    for line in stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            raise SpikeFailure("Native exec emitted non-JSON stdout")
        require(isinstance(value, dict), "Native exec emitted a non-object event")
        result.append(value)
    return result


def run_exec(binary, home, project, server, prompt, resume_id, timeout):
    # Resume-specific arguments follow `resume`; shared options belong to exec.
    args = [str(binary), "exec", "--json", "--skip-git-repo-check", "-C", str(project),
            "--sandbox", "read-only", "--ignore-user-config",
            "-c", 'approval_policy="never"', *provider_args(server, home)]
    if resume_id:
        args.extend(["resume", resume_id])
    args.append("-")
    completed = subprocess.run(args, input=prompt, cwd=project, env=child_env(home),
                               capture_output=True, text=True, timeout=timeout)
    events = parse_exec_events(completed.stdout)
    started = [event.get("thread_id") for event in events if event.get("type") == "thread.started"]
    failed = completed.returncode != 0 or any(event.get("type") in ("turn.failed", "error")
                                            for event in events)
    return {"ok": not failed, "threadIds": started, "events": events,
            "diagnostic": completed.stderr[-2500:]}


class AppServer:
    def __init__(self, binary, home, project, server, timeout):
        self.timeout = timeout
        self.messages = queue.Queue()
        self.notifications = []
        self.stderr = []
        self.next_id = 0
        self.methods = []
        self.proc = subprocess.Popen(
            [str(binary), "app-server", "--listen", "stdio://", *provider_args(server, home)],
            cwd=project, env=child_env(home), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.error_reader = threading.Thread(target=self._read_errors, daemon=True)
        self.reader.start()
        self.error_reader.start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                self.messages.put(json.loads(line))
            except json.JSONDecodeError:
                self.messages.put({"invalid_json": True})
        self.messages.put({"transport_closed": True})

    def _read_errors(self):
        for line in self.proc.stderr:
            self.stderr.append(line)
            if len(self.stderr) > 40:
                self.stderr.pop(0)

    def send(self, message):
        self.methods.append(message.get("method"))
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def receive(self, deadline):
        remaining = deadline - time.monotonic()
        require(remaining > 0, "Native app-server protocol timeout")
        try:
            message = self.messages.get(timeout=remaining)
        except queue.Empty:
            raise SpikeFailure("Native app-server protocol timeout: " + "".join(self.stderr)[-2500:])
        require(not message.get("transport_closed"),
                "Native app-server closed: " + "".join(self.stderr)[-2500:])
        require(not message.get("invalid_json"), "Native app-server emitted non-JSON stdout")
        return message

    def call(self, method, params):
        self.next_id += 1
        request_id = self.next_id
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + self.timeout
        while True:
            message = self.receive(deadline)
            if message.get("id") == request_id:
                return message
            # This fixture never authorizes a model tool invocation. A native
            # request would otherwise wait indefinitely for an approval/tool.
            require(not ("id" in message and "method" in message),
                    "Unexpected native tool/approval request in text-only spike")
            self.notifications.append(message)

    def initialize(self):
        response = self.call("initialize", {
            "clientInfo": {"name": "agent-teams-continuity-spike", "version": "0.1.0"},
            "capabilities": {"experimentalApi": False},
        })
        require("error" not in response, f"Native initialize failed: {response.get('error')}")
        self.send({"method": "initialized"})

    def completed_turn(self):
        deadline = time.monotonic() + self.timeout
        while True:
            message = self.notifications.pop(0) if self.notifications else self.receive(deadline)
            if message.get("method") == "turn/completed":
                turn = message.get("params", {}).get("turn", {})
                require(turn.get("status") == "completed", f"Native turn failed: {turn.get('error')}")
                return

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
        self.reader.join(timeout=2)
        self.error_reader.join(timeout=2)


def run_appserver(binary, home, project, server, prompt, resume_id, timeout):
    client = AppServer(binary, home, project, server, timeout)
    try:
        client.initialize()
        params = {"cwd": str(project), "model": "test-continuity-model",
                  "approvalPolicy": "on-request", "approvalsReviewer": "user", "sandbox": "read-only"}
        if resume_id:
            method = "thread/resume"
            params["threadId"] = resume_id
        else:
            method = "thread/start"
            params.update(ephemeral=False, experimentalRawEvents=False, persistExtendedHistory=False)
        response = client.call(method, params)
        if "error" in response:
            return {"ok": False, "threadIds": [], "methods": client.methods,
                    "diagnostic": json.dumps(response["error"])}
        thread_id = response.get("result", {}).get("thread", {}).get("id")
        require(bool(thread_id), f"{method} returned no native thread UUID")
        if resume_id:
            require(thread_id == resume_id, "Native resume returned a different thread UUID")
        response = client.call("turn/start", {"threadId": thread_id,
            "input": [{"type": "text", "text": prompt, "text_elements": []}],
            "cwd": str(project), "model": "test-continuity-model",
            "approvalPolicy": "on-request", "approvalsReviewer": "user",
            "sandboxPolicy": {"type": "readOnly", "access": {"type": "fullAccess"}, "networkAccess": False}})
        require("error" not in response, f"turn/start failed: {response.get('error')}")
        client.completed_turn()
        return {"ok": True, "threadIds": [thread_id], "methods": client.methods, "diagnostic": ""}
    finally:
        client.close()


RUNNERS = {"exec": run_exec, "appserver": run_appserver}


def check_turn(result, expected_id=None):
    require(result["ok"], "Native turn failed: " + result["diagnostic"])
    ids = result["threadIds"]
    require(len(ids) == 1 and isinstance(ids[0], str), "Expected exactly one native thread identity")
    try:
        uuid.UUID(ids[0])
    except ValueError:
        raise SpikeFailure("Native thread identity is not a UUID")
    require(expected_id is None or ids[0] == expected_id, "Native resume changed thread UUID")
    return ids[0]


def run_pair(binary, root, server, first_transport, second_transport, timeout):
    case = root / f"{first_transport}-to-{second_transport}"
    case.mkdir()
    project = case / "TEST-project"
    project.mkdir()
    sessions = case / "owned-sessions"
    sessions.mkdir()
    sentinel = sessions / "cleanup-sentinel.txt"
    sentinel.write_text("owned history must survive overlay cleanup", encoding="utf-8")
    suffix = uuid.uuid4().hex
    first_marker, first_answer, next_marker = f"FIRST_{suffix}", f"ACK_{suffix}", f"NEXT_{suffix}"
    first_url = f"https://example.invalid/context/{suffix}"
    first_prompt = f"Запомни маркер {first_marker} и ссылку {first_url}. Подтверди получение."
    second_prompt = f"Какой маркер и ссылку я прислал раньше? Новый запрос: {next_marker}."
    server.prepare([first_answer, "SECOND_ACK_" + suffix])

    with fresh_overlay(case, sessions) as home:
        first = RUNNERS[first_transport](binary, home, project, server, first_prompt, None, timeout)
        native_id = check_turn(first)
    require(sentinel.read_text(encoding="utf-8") == "owned history must survive overlay cleanup",
            "First overlay cleanup removed/changed persistent target")
    require(any(sessions.rglob("*.jsonl")), "Native first turn did not persist a rollout")
    require(len(server.requests) == 1, "First turn made an unexpected number of provider submissions")

    with fresh_overlay(case, sessions) as home:
        second = RUNNERS[second_transport](binary, home, project, server, second_prompt, native_id, timeout)
        check_turn(second, native_id)
    require(not server.errors, "Local provider fixture failed: " + "; ".join(server.errors))
    require(len(server.requests) == 2, "Expected exactly one provider request per turn")
    request_input = json.dumps(server.requests[1].get("input"), ensure_ascii=False)
    counts = {
        "priorUserMarker": request_input.count(first_marker),
        "priorUserUrl": request_input.count(first_url),
        "priorAssistant": request_input.count(first_answer),
        "currentUserMarker": request_input.count(next_marker),
    }
    require(all(count == 1 for count in counts.values()),
            f"Second actual model input lost or duplicated conversation content: {counts}")
    require(sentinel.read_text(encoding="utf-8") == "owned history must survive overlay cleanup",
            "Second overlay cleanup removed/changed persistent target")
    return {"case": f"{first_transport}->{second_transport}", "sameNativeUuid": True,
            "modelRequests": len(server.requests), "secondInputOccurrences": counts,
            "sharedStorage": "owned sessions directory only", "cleanupTargetSurvived": True}


def check_missing_uuid(binary, root, server, transport, timeout):
    case = root / f"missing-{transport}"
    case.mkdir()
    project = case / "TEST-project"
    project.mkdir()
    sessions = case / "owned-sessions"
    sessions.mkdir()
    absent_id = str(uuid.uuid4())
    server.prepare([])
    with fresh_overlay(case, sessions) as home:
        result = RUNNERS[transport](binary, home, project, server,
            "This request must not reach the provider.", absent_id, timeout)
    require(not result["ok"], f"{transport} accepted an absent native UUID")
    require(not result["threadIds"], f"{transport} silently created a thread for an absent UUID")
    require(not server.requests and not server.errors,
            f"{transport} submitted model input after failed resume")
    require(not any(sessions.rglob("*.jsonl")), f"{transport} wrote a new rollout after failed resume")
    if transport == "appserver":
        require("thread/start" not in result["methods"] and "turn/start" not in result["methods"],
                "App-server failed resume unexpectedly admitted a fresh thread/turn")
    return {"case": f"missing-uuid/{transport}", "resumeRefused": True,
            "modelRequests": 0, "newThreadCreated": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, required=True, help="Real native Codex executable")
    parser.add_argument("--expect-version", help="Require exact output of codex --version")
    parser.add_argument("--timeout", type=float, default=45, help="Per-native-operation deadline in seconds")
    args = parser.parse_args()
    require(0 < args.timeout <= 180, "Timeout must be between zero and 180 seconds")
    binary = args.codex.resolve(strict=True)
    require(binary.is_file(), "--codex must identify the real native executable")
    version_result = subprocess.run([str(binary), "--version"], capture_output=True,
                                    text=True, check=True, timeout=15)
    version = version_result.stdout.strip()
    if args.expect_version:
        require(version == args.expect_version, "Unexpected Codex version: " + version)
    print(json.dumps({"stage": "start", "nativeVersion": version,
          "provider": "scripted localhost Responses SSE", "liveModel": False}), flush=True)
    with tempfile.TemporaryDirectory(prefix="TEST-codex-native-continuity-") as directory:
        root = Path(directory)
        server = ScriptedResponses()
        try:
            results = []
            for first, second in (("exec", "exec"), ("appserver", "appserver"),
                                  ("exec", "appserver"), ("appserver", "exec")):
                result = run_pair(binary, root, server, first, second, args.timeout)
                results.append(result)
                print(json.dumps(result), flush=True)
            for transport in ("exec", "appserver"):
                result = check_missing_uuid(binary, root, server, transport, args.timeout)
                results.append(result)
                print(json.dumps(result), flush=True)
            print(json.dumps({"stage": "complete", "passed": len(results),
                              "nativeVersion": version, "liveModel": False}), flush=True)
        finally:
            server.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"stage": "failed", "error": str(error)}), file=sys.stderr, flush=True)
        sys.exit(1)
