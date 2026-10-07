#!/usr/bin/env python3
"""MB-OPS-002-L1 credential-free tests for scripts/play-controls.py.

Run: python3 -B tests/play_controls_test.py

Every test builds an independent fake installation under a temp directory
whose path contains spaces: a fake "accepted artifact" (a tiny dist/cli.js
run by the REAL pinned Node, so `ps` shows the exact argv), a fake world
config with its own data dir, a fake profile, a dummy key and a fake creds
helper. Nothing here reads the real profile, config, auth, vault or helper,
joins Minecraft or calls a provider. A task-specific helper override always
points to a missing or fake helper; the real vault helper is never invoked.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
from typing import Any, Dict, List, Optional

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.realpath(__file__))
REPO = os.path.dirname(HERE)
CONTROLLER = os.path.join(REPO, "scripts", "play-controls.py")
WRAPPERS = ["play.command", "dashboard.command", "logout.command"]
PINNED_NODE = "/opt/homebrew/Cellar/node@24/24.21.0/bin/node"
NODE = PINNED_NODE if os.path.isfile(PINNED_NODE) else (shutil.which("node") or "")
DUMMY_KEY = "sk-or-v1-DUMMYTESTKEY0123456789abcdef"
HELPER_KEY = "sk-or-v1-HELPERDUMMY9876543210fedcba"

spec = importlib.util.spec_from_file_location("play_controls", CONTROLLER)
assert spec and spec.loader
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)  # type: ignore[union-attr]

FAKE_CLI = r"""
const fs = require('fs'), path = require('path'), net = require('net'), http = require('http');
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const obs = process.env.FAKE_OBS_DIR;
const keyEnv = 'OPENROUTER_API_KEY';
const note = (extra) => { if (obs) fs.writeFileSync(path.join(obs, `${cmd}-${process.pid}.json`), JSON.stringify({ pid: process.pid, cmd, argv: process.argv, keyPresent: !!process.env[keyEnv], keyLength: (process.env[keyEnv] || '').length, pathHead: (process.env.PATH || '').split(':')[0], ...extra })); };
if (cmd === 'doctor') { note({}); console.log('doctor: ok (fake)'); process.exit(Number(process.env.FAKE_DOCTOR_EXIT || 0)); }
const cfg = JSON.parse(fs.readFileSync(opt('--config'), 'utf8'));
const dataDir = cfg.storage.dataDir;
if (cmd === 'run') {
  note({});
  const mode = process.env.FAKE_RUN || 'ok';
  if (process.env.FAKE_LEAK_KEY === '1') console.log('fake app printed ' + process.env[keyEnv]);
  if (mode === 'crash') { console.log('fake run crashing'); process.exit(3); }
  const dir = path.join(dataDir, 'dashboard');
  fs.mkdirSync(dir, { recursive: true });
  const startedAtMs = Date.now();
  const runId = 'run-' + process.pid.toString(36);
  let state = 'running', conn = 'joining', seq = 0, sigints = 0;
  const readyAt = startedAtMs + Number(process.env.FAKE_READY_DELAY_MS || 300);
  let sock;
  if (process.env.FAKE_SERVER_PORT) { sock = net.connect(Number(process.env.FAKE_SERVER_PORT), '127.0.0.1'); sock.on('error', () => {}); }
  const publish = () => {
    if (mode !== 'hang' && state === 'running' && Date.now() >= readyAt) conn = 'ready';
    seq += 1;
    const st = { schema: 'fake', publisher: { runId, pid: process.pid, startedAtMs, seq, publishedAtMs: Date.now(), heartbeatIntervalMs: 150, state }, connection: { state: conn, botName: { known: true, value: 'Chunkbot' } } };
    const tmp = path.join(dir, 'status.json.tmp' + process.pid);
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, path.join(dir, 'status.json'));
  };
  const timer = setInterval(publish, 150);
  publish();
  process.on('SIGINT', () => {
    sigints += 1;
    if (mode === 'ignore_sigint' && sigints === 1) return;
    clearInterval(timer); state = 'stopped'; conn = 'ended'; publish();
    if (sock) sock.destroy();
    setTimeout(() => process.exit(0), 100);
  });
} else if (cmd === 'dashboard') {
  note({});
  if (process.env.FAKE_VIEWER === 'crash') { console.log('fake viewer crashing'); process.exit(2); }
  const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html>fake dashboard</html>'); });
  srv.listen(Number(opt('--port')), '127.0.0.1');
  process.on('SIGINT', () => { srv.close(); process.exit(0); });
}
"""

FAKE_HELPER = r"""
import json, os, sys
with open(os.path.join(os.environ['FAKE_OBS_DIR'], 'helper-argv.json'), 'w') as fh:
    json.dump(sys.argv[1:], fh)
if os.environ.get('FAKE_HELPER_FAIL') == '1':
    sys.stderr.write('creds: vault is locked\n')
    sys.exit(1)
sys.stdout.write(os.environ['FAKE_HELPER_VALUE'])
"""


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def ps_args(pid: int) -> str:
    return subprocess.run(["/bin/ps", "-ww", "-o", "args=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()


def alive(pid: int) -> bool:
    return pc.pid_exists(pid)


def http_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


def fixture_json(path: str):
    with open(path) as fh:
        return json.load(fh)


class FakeServer:
    """Loopback TCP listener standing in for the Minecraft server (connections held open)."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.conns: List[socket.socket] = []
        self.stop = False
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self) -> None:
        self.sock.settimeout(0.2)
        while not self.stop:
            try:
                c, _ = self.sock.accept()
                self.conns.append(c)
            except OSError:
                continue

    def close(self) -> None:
        self.stop = True
        for c in self.conns:
            c.close()
        self.sock.close()


@unittest.skipUnless(NODE, "Node is required for the fake artifact")
class PlayControlsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.base = tempfile.mkdtemp(prefix="chunkbot controls ")
        self.repo = os.path.join(self.base, "Repo With Spaces")
        self.artifact = os.path.join(self.base, "accepted artifact")
        self.config_dir = os.path.join(self.base, "world config")
        self.data_dir = os.path.join(self.base, "data dir")
        self.runtime = os.path.join(self.base, "run time")
        self.obs = os.path.join(self.base, "obs")
        self.home = os.path.join(self.base, "home")
        for d in (self.repo, os.path.join(self.artifact, "dist"), self.config_dir, self.data_dir, self.obs, self.home):
            os.makedirs(d)
        self.entry = os.path.join(self.artifact, "dist", "cli.js")
        with open(self.entry, "w") as fh:
            fh.write(FAKE_CLI)
        self.config = os.path.join(self.config_dir, "live world.json")
        with open(self.config, "w") as fh:
            json.dump({"storage": {"dataDir": self.data_dir}}, fh)
        self.port = free_port()
        self.profile_path = os.path.join(self.base, "operator profile.json")
        self.profile: Dict[str, Any] = {
            "schemaVersion": 1,
            "repoRoot": self.repo,
            "artifactDir": self.artifact,
            "releaseCommit": "d348" + "0" * 36,
            "buildDigest": pc.build_digest(os.path.join(self.artifact, "dist")),
            "configPath": self.config,
            "nodePath": NODE,
            "runtimeDir": self.runtime,
            "dashboardPort": self.port,
            "keyEnv": "OPENROUTER_API_KEY",
            "vaultItem": "Fake Item",
            "vaultSelector": "password",
            "restartPolicy": "explicit operator start only",
        }
        self.write_profile()
        self.server: Optional[FakeServer] = None

    def tearDown(self) -> None:
        for name in os.listdir(self.obs):
            if not name.endswith(".json") or name == "helper-argv.json":
                continue
            try:
                pid = fixture_json(os.path.join(self.obs, name))["pid"]
            except (OSError, ValueError, KeyError):
                continue
            # Only our own fakes: their command line contains this test's unique temp path.
            if alive(pid) and self.base in ps_args(pid):
                os.kill(pid, signal.SIGKILL)
        if self.server:
            self.server.close()
        shutil.rmtree(self.base, ignore_errors=True)

    # ------------------------------------------------------------- helpers

    def write_profile(self, mode: int = 0o600) -> None:
        with open(self.profile_path, "w") as fh:
            json.dump(self.profile, fh)
        os.chmod(self.profile_path, mode)

    def env(self, **extra: str) -> Dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_") and k not in ("OPENROUTER_API_KEY", "CHUNKBOT_CREDS_HELPER")}
        env.update({"CHUNKBOT_CREDS_HELPER": os.path.join(self.home, "missing helper.py"), "FAKE_OBS_DIR": self.obs, "CHUNKBOT_CONTROLS_NO_OPEN": "1", "PYTHONDONTWRITEBYTECODE": "1", "OPENROUTER_API_KEY": DUMMY_KEY})
        for k, v in extra.items():
            if v is None:
                env.pop(k, None)
            else:
                env[k] = v
        return env

    def ctl(self, action: str, *extra: str, env: Optional[Dict[str, str]] = None, timeout: float = 60) -> subprocess.CompletedProcess:
        argv = [sys.executable, "-B", CONTROLLER, action, "--profile", self.profile_path, "--no-open", "--start-timeout", "10", "--viewer-timeout", "10", "--logout-timeout", "10"] + list(extra)
        return subprocess.run(argv, env=env or self.env(), capture_output=True, text=True, timeout=timeout)

    def obs_files(self, cmd: str) -> List[Dict[str, Any]]:
        out = []
        for name in sorted(os.listdir(self.obs)):
            if name.startswith(cmd + "-") and name.endswith(".json"):
                out.append(fixture_json(os.path.join(self.obs, name)))
        return out

    def receipt(self, name: str = "current.json") -> Optional[Dict[str, Any]]:
        p = os.path.join(self.runtime, name)
        return fixture_json(p) if os.path.exists(p) else None

    def previous(self, prefix: str = "previous-") -> List[Dict[str, Any]]:
        if not os.path.isdir(self.runtime):
            return []
        return [fixture_json(os.path.join(self.runtime, n)) for n in sorted(os.listdir(self.runtime)) if n.startswith(prefix)]

    def assert_ok(self, r: subprocess.CompletedProcess, code: int = 0) -> None:
        self.assertEqual(r.returncode, code, "stdout:\n%s\nstderr:\n%s" % (r.stdout, r.stderr))

    def assert_no_secret_anywhere(self, *outputs: str, secret: str = DUMMY_KEY, include_bot_logs: bool = True) -> None:
        for o in outputs:
            self.assertNotIn(secret, o)
        for root, _, files in os.walk(self.runtime):
            for f in files:
                if not include_bot_logs and f.endswith(".log") and f != "play-controls.log":
                    continue
                with open(os.path.join(root, f), "rb") as fh:
                    self.assertNotIn(secret.encode(), fh.read(), "secret found in %s" % f)
        for o in self.obs_files("run") + self.obs_files("dashboard") + self.obs_files("doctor"):
            if alive(o["pid"]):
                self.assertNotIn(secret, ps_args(o["pid"]))
            self.assertNotIn(secret, " ".join(o["argv"]))

    def start_unrelated(self) -> subprocess.Popen:
        p = subprocess.Popen(["/bin/sleep", "120"])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        time.sleep(0.2)
        return p

    # ------------------------------------------------------------- tests

    def test_build_digest_matches_documented_algorithm(self) -> None:
        os.makedirs(os.path.join(self.artifact, "dist", "sub dir"))
        with open(os.path.join(self.artifact, "dist", "sub dir", "é.js"), "wb") as fh:
            fh.write(b"x")
        h = hashlib.sha256()
        dist = os.path.join(self.artifact, "dist")
        for rel in sorted(["cli.js", "sub dir/é.js"], key=lambda s: s.encode()):
            with open(os.path.join(dist, rel), "rb") as fh:
                h.update(rel.encode() + b"\0" + fh.read() + b"\0")
        self.assertEqual(pc.build_digest(dist), h.hexdigest())

    def test_play_starts_once_ready_viewer_receipts_private_and_no_secret(self) -> None:
        self.server = FakeServer()
        env = self.env(FAKE_SERVER_PORT=str(self.server.port))
        r = self.ctl("play", env=env)
        self.assert_ok(r)
        runs = self.obs_files("run")
        self.assertEqual(len(runs), 1)
        run = runs[0]
        self.assertTrue(run["keyPresent"])
        self.assertEqual(run["keyLength"], len(DUMMY_KEY))
        self.assertEqual(run["pathHead"], os.path.dirname(NODE), "pinned node directory first in the child PATH")
        self.assertEqual(ps_args(run["pid"]), " ".join([NODE, self.entry, "run", "--config", self.config, "--no-terminal"]))
        rec = self.receipt()
        assert rec
        self.assertEqual(rec["pid"], run["pid"])
        self.assertTrue(rec["ready"])
        self.assertTrue(rec["runId"].startswith("run-"))
        self.assertEqual(rec["processBirth"], pc.process_birth(run["pid"]))
        self.assertEqual(rec["keySource"], "inherited")
        self.assertFalse(rec["keyPersisted"])
        self.assertEqual(rec["buildDigest"], self.profile["buildDigest"])
        for name in ("current.json", "viewer.json", "play-controls.log", os.path.basename(rec["log"])):
            self.assertEqual(os.stat(os.path.join(self.runtime, name)).st_mode & 0o777, 0o600, name)
        self.assertEqual(len(self.obs_files("doctor")), 1, "read-only doctor ran before the start")
        viewers = self.obs_files("dashboard")
        self.assertEqual(len(viewers), 1)
        self.assertFalse(viewers[0]["keyPresent"], "the viewer never receives the key")
        self.assertIn("--no-openrouter-key", viewers[0]["argv"])
        self.assertTrue(http_ok("http://127.0.0.1:%d/" % self.port))
        self.assert_no_secret_anywhere(r.stdout, r.stderr)
        s = self.ctl("status", "--json")
        self.assert_ok(s)
        st = json.loads(s.stdout)
        self.assertEqual(st["bot"]["state"], "proven")
        self.assertTrue(st["bot"]["ready"])
        self.assertTrue(st["viewer"]["answering"])
        self.assertTrue(st["artifactDigestMatches"])

    def test_duplicate_start_preserves_process_and_budget(self) -> None:
        self.assert_ok(self.ctl("play"))
        first = self.receipt()
        r = self.ctl("play")
        self.assert_ok(r)
        self.assertIn("already running", r.stdout)
        self.assertEqual(len(self.obs_files("run")), 1)
        self.assertEqual(len(self.obs_files("doctor")), 1)
        self.assertEqual(len(self.obs_files("dashboard")), 1, "viewer reused")
        self.assertEqual(self.receipt(), first)

    def test_concurrent_starts_create_exactly_one_bot(self) -> None:
        argv = [sys.executable, "-B", CONTROLLER, "play", "--profile", self.profile_path, "--no-open", "--start-timeout", "10", "--lock-timeout", "30"]
        procs = [subprocess.Popen(argv, env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
        results = [p.communicate(timeout=90) + (p.returncode,) for p in procs]
        for out, err, code in results:
            self.assertEqual(code, 0, out + err)
        self.assertEqual(len(self.obs_files("run")), 1)
        self.assertEqual(len(self.obs_files("dashboard")), 1)
        self.assertEqual(sum("already running" in out for out, _, _ in results), 2)

    def test_dashboard_only_never_starts_the_bot(self) -> None:
        r = self.ctl("dashboard", env=self.env(OPENROUTER_API_KEY=None))
        self.assert_ok(r)
        self.assertEqual(self.obs_files("run"), [])
        self.assertEqual(self.obs_files("doctor"), [])
        self.assertIsNone(self.receipt())
        self.assertTrue(http_ok("http://127.0.0.1:%d/" % self.port))
        v = self.receipt("viewer.json")
        assert v
        self.assertTrue(v["readOnly"])
        r2 = self.ctl("dashboard")
        self.assert_ok(r2)
        self.assertIn("already running", r2.stdout)
        self.assertEqual(len(self.obs_files("dashboard")), 1)

    def test_logout_stops_only_the_bot_confirms_socket_and_leaves_viewer(self) -> None:
        self.server = FakeServer()
        env = self.env(FAKE_SERVER_PORT=str(self.server.port))
        self.assert_ok(self.ctl("play", env=env))
        bot = self.receipt()
        viewer = self.receipt("viewer.json")
        assert bot and viewer
        r = self.ctl("logout", env=self.env(OPENROUTER_API_KEY=None))
        self.assert_ok(r)
        self.assertFalse(alive(bot["pid"]))
        self.assertTrue(alive(viewer["pid"]), "the viewer stays open")
        self.assertTrue(http_ok(viewer["url"]))
        self.assertIsNone(self.receipt())
        prev = self.previous()
        self.assertEqual(len(prev), 1)
        self.assertEqual(prev[0]["pid"], bot["pid"])
        self.assertTrue(prev[0]["processStopped"])
        self.assertIs(prev[0]["serverSocketClosed"], True)
        self.assertEqual(prev[0]["serverConnectionsBefore"], 1)
        self.assertTrue(prev[0]["publisherStopped"])
        self.assertEqual(prev[0]["shutdownSignal"], "SIGINT")
        again = self.ctl("logout")
        self.assert_ok(again)
        self.assertIn("not running", again.stdout)

    def test_explicit_start_after_logout_is_a_new_run(self) -> None:
        self.assert_ok(self.ctl("play"))
        first = self.receipt()
        self.assert_ok(self.ctl("logout"))
        self.assert_ok(self.ctl("play"))
        second = self.receipt()
        assert first and second
        self.assertNotEqual(first["pid"], second["pid"])
        self.assertNotEqual(first["runId"], second["runId"])
        self.assertEqual(len(self.obs_files("run")), 2)
        self.assertEqual(len(self.obs_files("dashboard")), 1, "viewer reused across runs")

    def test_wrong_pid_receipt_is_never_signalled(self) -> None:
        sleeper = self.start_unrelated()
        os.makedirs(self.runtime)
        birth = pc.process_birth(sleeper.pid)
        pc.write_private_json(os.path.join(self.runtime, "current.json"), {"pid": sleeper.pid, "processBirth": birth, "entryPoint": self.entry, "config": self.config})
        r = self.ctl("logout")
        self.assert_ok(r, 3)
        self.assertTrue(alive(sleeper.pid))
        self.assertIsNotNone(self.receipt(), "an unproven receipt is kept for inspection")
        p = self.ctl("play")
        self.assert_ok(p, 3)
        self.assertEqual(self.obs_files("run"), [])
        self.assertTrue(alive(sleeper.pid))

    def test_reused_pid_is_archived_not_signalled(self) -> None:
        sleeper = self.start_unrelated()
        os.makedirs(self.runtime)
        pc.write_private_json(os.path.join(self.runtime, "current.json"), {"pid": sleeper.pid, "processBirth": "Thu Jan  1 00:00:00 1970", "entryPoint": self.entry, "config": self.config})
        r = self.ctl("logout")
        self.assert_ok(r)
        self.assertIn("nothing was signalled", r.stdout)
        self.assertTrue(alive(sleeper.pid))
        self.assertIsNone(self.receipt())
        self.assertTrue(self.previous()[0]["endedUnobserved"])

    def test_stale_receipt_then_play_starts_fresh(self) -> None:
        os.makedirs(self.runtime)
        dead = subprocess.Popen(["/usr/bin/true"])
        dead.wait()
        pc.write_private_json(os.path.join(self.runtime, "current.json"), {"pid": dead.pid, "processBirth": "Thu Jan  1 00:00:00 1970", "entryPoint": self.entry, "config": self.config, "runId": "run-old"})
        self.assert_ok(self.ctl("play"))
        self.assertNotEqual(self.receipt()["runId"], "run-old")  # type: ignore[index]
        self.assertEqual(self.previous()[0]["runId"], "run-old")

    def test_unrecorded_exact_command_is_refused_not_adopted_or_signalled(self) -> None:
        stray = subprocess.Popen([NODE, self.entry, "run", "--config", self.config, "--no-terminal"], env=self.env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (stray.kill(), stray.wait()))
        time.sleep(0.5)
        p = self.ctl("play")
        self.assert_ok(p, 3)
        self.assertIn("without a matching receipt", p.stderr)
        lo = self.ctl("logout")
        self.assert_ok(lo, 3)
        self.assertTrue(alive(stray.pid))
        self.assertEqual(len(self.obs_files("run")), 1, "only the stray")
        st = json.loads(self.ctl("status", "--json").stdout)
        self.assertEqual(st["bot"]["unrecordedProcesses"], [stray.pid])

    def test_startup_crash_is_reported_once_with_redacted_tail(self) -> None:
        r = self.ctl("play", env=self.env(FAKE_RUN="crash", FAKE_LEAK_KEY="1"))
        self.assert_ok(r, 1)
        self.assertIn("exited during startup (exit 3)", r.stderr)
        self.assertIn("[redacted]", r.stderr)
        self.assertNotIn(DUMMY_KEY, r.stderr + r.stdout)
        self.assertIsNone(self.receipt())
        prev = self.previous()
        self.assertTrue(prev[0]["startupFailed"])
        self.assertEqual(len(self.obs_files("run")), 1, "no retry")
        self.assertEqual(self.obs_files("dashboard"), [], "no viewer after a failed start")
        # The bot's own log is written by the app (which redacts); the controls' own files never hold the key.
        self.assert_no_secret_anywhere(r.stdout, r.stderr, include_bot_logs=False)

    def test_startup_timeout_stops_the_started_child(self) -> None:
        r = self.ctl("play", "--start-timeout", "2", env=self.env(FAKE_RUN="hang"))
        self.assert_ok(r, 1)
        self.assertIn("did not report ready", r.stderr)
        self.assertIn("connection is joining", r.stderr)
        pid = self.obs_files("run")[0]["pid"]
        self.assertFalse(alive(pid))
        self.assertIsNone(self.receipt())
        self.assertTrue(self.previous()[0]["startupFailed"])

    def test_old_status_from_another_run_is_not_readiness(self) -> None:
        os.makedirs(os.path.join(self.data_dir, "dashboard"))
        with open(os.path.join(self.data_dir, "dashboard", "status.json"), "w") as fh:
            json.dump({"publisher": {"pid": 999999, "runId": "run-old", "startedAtMs": 1, "state": "running", "publishedAtMs": time.time() * 1000}, "connection": {"state": "ready"}}, fh)
        r = self.ctl("play", "--start-timeout", "2", env=self.env(FAKE_RUN="hang"))
        self.assert_ok(r, 1)
        self.assertEqual(pc.ready_evidence({"publisher": {"pid": 5, "startedAtMs": 10, "state": "running"}, "connection": {"state": "ready"}}, 5, 100)[0], False)
        pub = {"pid": 5, "startedAtMs": 200, "state": "running", "publishedAtMs": time.time() * 1000}
        self.assertTrue(pc.ready_evidence({"publisher": pub, "connection": {"state": "ready"}}, 5, 100)[0])
        pub["publishedAtMs"] -= 20_000
        self.assertFalse(pc.ready_evidence({"publisher": pub, "connection": {"state": "ready"}}, 5, 100)[0])

    def test_logout_timeout_reports_and_second_logout_forces(self) -> None:
        env = self.env(FAKE_RUN="ignore_sigint")
        self.assert_ok(self.ctl("play", env=env))
        pid = self.receipt()["pid"]  # type: ignore[index]
        r = self.ctl("logout", "--logout-timeout", "1.5")
        self.assert_ok(r, 1)
        self.assertIn("still running", r.stderr)
        self.assertTrue(alive(pid))
        self.assertIsNotNone(self.receipt())
        self.assert_ok(self.ctl("logout"))
        self.assertFalse(alive(pid))

    def test_doctor_failure_starts_nothing(self) -> None:
        r = self.ctl("play", env=self.env(FAKE_DOCTOR_EXIT="4"))
        self.assert_ok(r, 1)
        self.assertIn("doctor failed (exit 4)", r.stderr)
        self.assertEqual(self.obs_files("run"), [])
        self.assertIsNone(self.receipt())

    def test_digest_mismatch_refuses_before_anything(self) -> None:
        with open(self.entry, "a") as fh:
            fh.write("\n// changed\n")
        r = self.ctl("play")
        self.assert_ok(r, 2)
        self.assertIn("does not match the registered", r.stderr)
        self.assertEqual(self.obs_files("doctor") + self.obs_files("run"), [])

    def test_profile_must_be_private_and_not_point_at_the_repo(self) -> None:
        self.write_profile(0o666)
        self.assert_ok(self.ctl("status"), 2)
        self.profile["artifactDir"] = self.repo
        self.write_profile()
        r = self.ctl("play")
        self.assert_ok(r, 2)
        self.assertIn("mutable repository checkout", r.stderr)
        self.profile["artifactDir"] = self.artifact
        self.profile["vaultSelector"] = "password; rm -rf"
        self.write_profile()
        self.assert_ok(self.ctl("play"), 2)

    def test_missing_key_without_helper_starts_nothing(self) -> None:
        r = self.ctl("play", env=self.env(OPENROUTER_API_KEY=None))
        self.assert_ok(r, 1)
        self.assertIn("OPENROUTER_API_KEY is not set", r.stderr)
        self.assertEqual(self.obs_files("doctor") + self.obs_files("run"), [])

    def test_creds_helper_key_reaches_only_the_child_environment(self) -> None:
        helper = os.path.join(self.base, "fake helper dir", "helper.py")
        os.makedirs(os.path.dirname(helper))
        with open(helper, "w") as fh:
            fh.write(FAKE_HELPER)
        env = self.env(OPENROUTER_API_KEY=None, CHUNKBOT_CREDS_HELPER=helper, FAKE_HELPER_VALUE=HELPER_KEY)
        r = self.ctl("play", env=env)
        self.assert_ok(r)
        self.assertEqual(fixture_json(os.path.join(self.obs, "helper-argv.json")), ["get", "Fake Item", "--password", "-n"])
        run = self.obs_files("run")[0]
        self.assertTrue(run["keyPresent"])
        self.assertEqual(run["keyLength"], len(HELPER_KEY))
        self.assertEqual(self.receipt()["keySource"], "creds-helper")  # type: ignore[index]
        self.assertFalse(self.obs_files("dashboard")[0]["keyPresent"])
        self.assert_no_secret_anywhere(r.stdout, r.stderr, secret=HELPER_KEY)
        failing = self.env(OPENROUTER_API_KEY=None, CHUNKBOT_CREDS_HELPER=helper, FAKE_HELPER_FAIL="1", FAKE_HELPER_VALUE="")
        self.assert_ok(self.ctl("logout"))
        f = self.ctl("play", env=failing)
        self.assert_ok(f, 1)
        self.assertIn("vault is locked", f.stderr)
        self.assertEqual(len(self.obs_files("run")), 1)

    def test_occupied_dashboard_port_is_refused(self) -> None:
        holder = socket.socket()
        holder.bind(("127.0.0.1", self.port))
        holder.listen(1)
        self.addCleanup(holder.close)
        r = self.ctl("dashboard")
        self.assert_ok(r, 3)
        self.assertIn("in use by a process these controls did not start", r.stderr)
        self.assertEqual(self.obs_files("dashboard"), [])

    def test_viewer_startup_failure_is_bounded(self) -> None:
        r = self.ctl("dashboard", env=self.env(FAKE_VIEWER="crash"))
        self.assert_ok(r, 1)
        self.assertIn("viewer exited during startup", r.stderr)
        self.assertIsNone(self.receipt("viewer.json"))
        self.assertEqual(len(self.previous("viewer-previous-")), 1)

    def test_status_is_read_only(self) -> None:
        r = self.ctl("status")
        self.assert_ok(r)
        self.assertFalse(os.path.exists(self.runtime), "status never creates the runtime directory")
        self.assert_ok(self.ctl("play"))

        def snapshot() -> Dict[str, Any]:
            return {n: (os.stat(os.path.join(self.runtime, n)).st_mtime_ns, os.stat(os.path.join(self.runtime, n)).st_size) for n in os.listdir(self.runtime)}

        before = snapshot()
        s = self.ctl("status")
        self.assert_ok(s)
        self.assertIn("Bot: proven", s.stdout)
        self.assertEqual(snapshot(), before)
        self.assertTrue(alive(self.receipt()["pid"]))  # type: ignore[index]

    def context(self):
        import argparse
        args = argparse.Namespace(no_open=True, json=False, start_timeout=5,
                                  doctor_timeout=5, logout_timeout=2,
                                  viewer_timeout=5, lock_timeout=2)
        return pc.Ctx(self.profile_path, self.profile, args)

    def test_receipt_cannot_authorize_a_different_world_process(self) -> None:
        other_config = os.path.join(self.config_dir, "other world.json")
        shutil.copy2(self.config, other_config)
        stray = subprocess.Popen([NODE, self.entry, "run", "--config", other_config,
                                  "--no-terminal"], env=self.env(),
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (stray.kill(), stray.wait()))
        time.sleep(0.5)
        os.makedirs(self.runtime)
        pc.write_private_json(os.path.join(self.runtime, "current.json"), {
            "pid": stray.pid, "processBirth": pc.process_birth(stray.pid),
            "entryPoint": self.entry, "config": other_config})
        self.assert_ok(self.ctl("logout"), 3)
        self.assertTrue(alive(stray.pid), "receipt cannot grant authority over another config")
        self.assert_ok(self.ctl("play"), 3)
        self.assertEqual(len(self.obs_files("run")), 1, "no second process started")
        for field in ("nodePath", "entryPoint"):
            with self.assertRaises(pc.ControlError):
                self.context().run_argv({field: "/unregistered/path"})

    def test_viewer_receipt_cannot_override_url_or_port(self) -> None:
        self.assert_ok(self.ctl("dashboard"))
        original = self.receipt("viewer.json")
        assert original
        for field, value in (("url", "https://example.invalid/"), ("port", self.port + 1)):
            wrong = dict(original)
            wrong[field] = value
            pc.write_private_json(os.path.join(self.runtime, "viewer.json"), wrong)
            self.assert_ok(self.ctl("dashboard"), 3)
            self.assertTrue(alive(original["pid"]))
            self.assertEqual(len(self.obs_files("dashboard")), 1)

    def test_dashboard_refuses_changed_artifact_before_launch(self) -> None:
        with open(self.entry, "a") as fh:
            fh.write("\n// changed after registration\n")
        self.assert_ok(self.ctl("dashboard"), 2)
        self.assertEqual(self.obs_files("dashboard"), [])

    def test_failed_process_probes_cannot_mean_absence(self) -> None:
        sleeper = self.start_unrelated()
        with patch.object(pc, "ps_value", return_value=None):
            self.assertTrue(pc.pid_exists(sleeper.pid))
            state, _ = pc.prove(sleeper.pid, "some birth", [["/bin/sleep", "120"]])
            self.assertEqual(state, "mismatch")
        with patch.object(pc.subprocess, "run", side_effect=subprocess.TimeoutExpired("ps", 1)):
            with self.assertRaises(pc.ControlError):
                pc.scan_exact(self.context().viewer_argvs())

    def test_failed_receipt_write_cleans_up_new_child(self) -> None:
        ctx = self.context()
        pc.ensure_runtime_dir(ctx)
        with patch.dict(os.environ, self.env(), clear=True):
            with patch.object(pc, "write_private_json", side_effect=OSError(13, "test denied write")):
                with self.assertRaises(OSError):
                    pc.start_bot(ctx)
        runs = self.obs_files("run")
        # The child may be stopped before JS initializes; either way it cannot remain online.
        for run in runs:
            self.assertFalse(alive(run["pid"]))
        self.assertEqual(pc.scan_exact([ctx.run_argv()]), [])
        self.assertIsNone(self.receipt())

    def test_interrupt_during_readiness_cleans_up_new_child(self) -> None:
        ctx = self.context()
        pc.ensure_runtime_dir(ctx)
        with patch.dict(os.environ, self.env(FAKE_RUN="hang"), clear=True):
            with patch.object(pc, "ready_evidence", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    pc.start_bot(ctx)
        self.assertIsNone(self.receipt())
        previous = self.previous()
        self.assertEqual(len(previous), 1)
        self.assertFalse(alive(previous[0]["pid"]))
        self.assertTrue(previous[0]["startupFailed"])

    def test_cleanup_that_cannot_confirm_exit_retains_receipt(self) -> None:
        os.makedirs(self.runtime)
        path = os.path.join(self.runtime, "current.json")
        rec = {"pid": 123, "processBirth": "test", "entryPoint": self.entry, "config": self.config}
        pc.write_private_json(path, rec)
        pc.failed_start_record(path, rec, "previous", {"processStopped": False, "startupFailed": True})
        self.assertEqual(self.receipt()["pid"], 123)
        self.assertFalse(self.receipt()["processStopped"])
        self.assertEqual(self.previous(), [])

    def test_wrappers_are_valid_zsh_and_work_from_a_path_with_spaces(self) -> None:
        for w in WRAPPERS:
            path = os.path.join(REPO, w)
            self.assertTrue(os.access(path, os.X_OK), w)
            self.assertEqual(subprocess.run(["/bin/zsh", "-n", path]).returncode, 0, w)
        os.makedirs(os.path.join(self.repo, "scripts"))
        shutil.copy2(CONTROLLER, os.path.join(self.repo, "scripts", "play-controls.py"))
        for w in WRAPPERS:
            shutil.copy2(os.path.join(REPO, w), os.path.join(self.repo, w))
        r = subprocess.run(["/bin/zsh", os.path.join(self.repo, "dashboard.command"), "--profile", self.profile_path, "--no-open"], env=self.env(), capture_output=True, text=True, timeout=60)
        self.assert_ok(r)
        self.assertEqual(len(self.obs_files("dashboard")), 1)
        self.assertEqual(self.obs_files("run"), [], "dashboard.command never starts the bot")
        p = subprocess.run(["/bin/zsh", os.path.join(self.repo, "play.command"), "--profile", self.profile_path, "--no-open", "--start-timeout", "10"], env=self.env(), capture_output=True, text=True, timeout=60)
        self.assert_ok(p)
        lo = subprocess.run(["/bin/zsh", os.path.join(self.repo, "logout.command"), "--profile", self.profile_path], env=self.env(), capture_output=True, text=True, timeout=60)
        self.assert_ok(lo)
        self.assertFalse(alive(self.obs_files("run")[0]["pid"]))
        self.assertTrue(http_ok("http://127.0.0.1:%d/" % self.port))


if __name__ == "__main__":
    unittest.main(verbosity=2)
