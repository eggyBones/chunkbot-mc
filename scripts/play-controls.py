#!/usr/bin/env python3
"""MB-OPS-002-L1 local operator controls for Chunkbot (Python 3 stdlib only).

    play-controls.py play       start the registered accepted artifact once, then reuse/start/open the dashboard
    play-controls.py dashboard  reuse/start/open the read-only dashboard viewer only (never joins Minecraft)
    play-controls.py logout     gracefully SIGINT only the proven owned bot; confirm process/socket exit
    play-controls.py status     read-only report (no lock, no writes, no signals)

Options: --profile <file> (default <repo>/var/live-chunkbot/operator-profile.json),
--no-open, --json (status), --start-timeout/--doctor-timeout/--logout-timeout/
--viewer-timeout/--lock-timeout <seconds>.

Safety rules:
- Mutations (play/dashboard/logout) are serialized by an OS file lock.
- A process is adopted or signalled only when its pid, exact `ps lstart`
  birth AND exact expected argv (pinned node, artifact entry point, action,
  config) all match its receipt. Stale or reused pids are never signalled.
- No build/install, update, reconnect, retry loop, goal replay or sign-in.
  An explicit start after a completed logout is a new process. That means a
  new run with the app's default per-run spend cap. A duplicate start keeps
  the running process and its budget.
- The model key comes only from the inherited environment variable named by
  the profile, or from the local creds helper run in THIS operator process.
  It is placed only in the bot's child environment, never in argv, receipts,
  logs, caches or output. The viewer gets no key.
"""
from __future__ import annotations

import argparse
import datetime
import errno
import fcntl
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

CONTROLS_VERSION = 1
SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
DEFAULT_PROFILE = os.path.join(REPO_ROOT, "var", "live-chunkbot", "operator-profile.json")
DEFAULT_CREDS_HELPER = os.path.join(os.path.expanduser("~"), ".claude", "skills", "creds", "helper.py")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_CONFIG = 2
EXIT_REFUSED = 3
EXIT_BUSY = 75

PS_ENV = {"LC_ALL": "C", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
if "TZ" in os.environ:
    PS_ENV["TZ"] = os.environ["TZ"]

HEX64 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{7,40}$")
ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
SELECTOR = re.compile(r"^(password|username|notes|uri|field:[A-Za-z0-9_. -]{1,64})$")
GENERIC_KEY = re.compile(r"sk-or-[A-Za-z0-9_-]{8,}")

PROFILE_FIELDS = {
    "schemaVersion": int,
    "repoRoot": str,
    "artifactDir": str,
    "releaseCommit": str,
    "buildDigest": str,
    "configPath": str,
    "nodePath": str,
    "runtimeDir": str,
    "dashboardPort": int,
    "keyEnv": str,
    "vaultItem": str,
    "vaultSelector": str,
    "restartPolicy": str,
}


class ControlError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ----------------------------------------------------------------- small utilities


def now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def stamp() -> str:
    return now_iso().replace(":", "-")


def redact(text: str, secret: Optional[str]) -> str:
    if secret:
        text = text.replace(secret, "[redacted]")
    return GENERIC_KEY.sub("[redacted]", text)


def tail(path: str, secret: Optional[str], limit: int = 1200) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - limit))
            data = fh.read().decode("utf-8", "replace")
    except OSError:
        return "(log unavailable)"
    return redact(data, secret).strip() or "(log empty)"


def fsync_dir(path: str) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_private_json(path: str, obj: Dict[str, Any]) -> None:
    """Atomic 0600 JSON write (temp + fsync + rename)."""
    tmp = "%s.tmp-%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, indent=2)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(os.path.dirname(path))


def read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def open_private_log(path: str, append: bool = False) -> int:
    flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if append else os.O_EXCL)
    fd = os.open(path, flags, 0o600)
    os.chmod(path, 0o600)
    return fd


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_digest(dist_dir: str) -> str:
    """sha256 over every file under dist, sorted by relative path (UTF-8 bytes):
    relative path UTF-8, NUL, file bytes, NUL."""
    if not os.path.isdir(dist_dir):
        raise ControlError(EXIT_CONFIG, "artifact dist directory is missing: %s" % dist_dir)
    rels: List[str] = []
    for root, dirs, files in os.walk(dist_dir, followlinks=False):
        for d in dirs:
            if os.path.islink(os.path.join(root, d)):
                raise ControlError(EXIT_CONFIG, "unexpected symlink in artifact dist: %s" % os.path.join(root, d))
        for f in files:
            p = os.path.join(root, f)
            if os.path.islink(p):
                raise ControlError(EXIT_CONFIG, "unexpected symlink in artifact dist: %s" % p)
            rels.append(os.path.relpath(p, dist_dir).replace(os.sep, "/"))
    rels.sort(key=lambda s: s.encode("utf-8"))
    h = hashlib.sha256()
    for rel in rels:
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        with open(os.path.join(dist_dir, rel), "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        h.update(b"\0")
    return h.hexdigest()


# ----------------------------------------------------------------- processes


def ps_value(pid: int, field: str) -> Optional[str]:
    try:
        r = subprocess.run(["/bin/ps", "-ww", "-o", field + "=", "-p", str(pid)], capture_output=True, text=True, env=PS_ENV, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    out = r.stdout.strip()
    return out or None


def process_birth(pid: int) -> Optional[str]:
    return ps_value(pid, "lstart")


def pid_exists(pid: int) -> bool:
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    stat = ps_value(pid, "stat")
    # kill(0) proved existence. A failed ps probe must not turn that into absence.
    return stat is None or not stat.startswith("Z")


def prove(pid: Any, birth: Any, expected: List[List[str]]) -> Tuple[str, str]:
    """('absent'|'reused'|'mismatch'|'proven', detail). Only 'proven' may be adopted or signalled."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1 or not isinstance(birth, str) or not birth:
        return "mismatch", "receipt has no valid pid/processBirth"
    if not pid_exists(pid):
        return "absent", "pid %d is not running" % pid
    actual_birth = process_birth(pid)
    if actual_birth is None:
        if not pid_exists(pid):
            return "absent", "pid %d exited" % pid
        return "mismatch", "pid %d exists but its identity could not be read" % pid
    if actual_birth != birth:
        return "reused", "pid %d now belongs to another process (started %s, receipt says %s)" % (pid, actual_birth, birth)
    args = ps_value(pid, "args")
    if args is None or args not in [" ".join(a) for a in expected]:
        return "mismatch", "pid %d command line is not the expected Chunkbot command" % pid
    return "proven", "pid %d proven (birth and command line match)" % pid


def scan_exact(expected: List[List[str]]) -> List[int]:
    """Pids whose full command line equals an expected argv (read-only)."""
    want = set(" ".join(a) for a in expected)
    try:
        r = subprocess.run(["/bin/ps", "-ax", "-ww", "-o", "pid=,args="], capture_output=True, text=True, env=PS_ENV, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        raise ControlError(EXIT_REFUSED, "cannot inspect running processes; nothing was started or signalled")
    if r.returncode != 0:
        raise ControlError(EXIT_REFUSED, "process inventory failed; nothing was started or signalled")
    out: List[int] = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_s, _, args = line.partition(" ")
        if args.strip() in want and pid_s.isdigit():
            pid = int(pid_s)
            if pid_exists(pid):
                out.append(pid)
    return out


def tcp_connections(pid: int) -> Optional[List[str]]:
    """ESTABLISHED TCP endpoint names ('local->remote') of pid via lsof, or None when unavailable."""
    try:
        r = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], capture_output=True, text=True, env=PS_ENV, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode not in (0, 1):
        return None
    return [line[1:] for line in r.stdout.splitlines() if line.startswith("n") and "->" in line]


def connection_still_open(name: str) -> Optional[bool]:
    local = name.split("->", 1)[0]
    port = local.rsplit(":", 1)[-1]
    if not port.isdigit():
        return None
    try:
        r = subprocess.run(["/usr/sbin/lsof", "-nP", "-iTCP:%s" % port, "-sTCP:ESTABLISHED", "-Fn"], capture_output=True, text=True, env=PS_ENV, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode not in (0, 1):
        return None
    return any(line[1:] == name for line in r.stdout.splitlines() if line.startswith("n"))


def port_in_use(port: int) -> bool:
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        s = socket.socket(family, socket.SOCK_STREAM)
        s.settimeout(1.0)
        try:
            if s.connect_ex((host, port)) == 0:
                return True
        except OSError:
            pass
        finally:
            s.close()
    return False


def http_ok(url: str, timeout: float = 3.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


# ----------------------------------------------------------------- profile/context


class Ctx:
    def __init__(self, profile_path: str, profile: Dict[str, Any], args: argparse.Namespace) -> None:
        self.profile_path = profile_path
        self.p = profile
        self.args = args
        self.node = profile["nodePath"]
        self.artifact = profile["artifactDir"]
        self.entry = os.path.join(self.artifact, "dist", "cli.js")
        self.config = profile["configPath"]
        self.runtime = profile["runtimeDir"]
        self.port = profile["dashboardPort"]
        self.key_env = profile["keyEnv"]
        self.url = "http://127.0.0.1:%d/" % self.port
        self.current = os.path.join(self.runtime, "current.json")
        self.viewer = os.path.join(self.runtime, "viewer.json")
        self.lock_path = os.path.join(self.runtime, ".play-controls.lock")
        self.controls_log = os.path.join(self.runtime, "play-controls.log")
        self._data_dir: Optional[str] = None

    def check_receipt(self, receipt: Dict[str, Any], viewer: bool = False) -> None:
        """A receipt records identity; only the registered profile defines ownership."""
        fields = {"nodePath": self.node, "entryPoint": self.entry, "config": self.config}
        if viewer:
            fields.update({"port": self.port, "url": self.url})
        for name, expected in fields.items():
            if name in receipt and receipt[name] != expected:
                raise ControlError(EXIT_REFUSED, "receipt field %s differs from the registered profile; nothing was started or signalled" % name)

    # The profile's exact command lines (receipts cannot override them).
    def run_argv(self, receipt: Optional[Dict[str, Any]] = None) -> List[str]:
        if receipt is not None:
            self.check_receipt(receipt)
        return [self.node, self.entry, "run", "--config", self.config, "--no-terminal"]

    def viewer_argvs(self, receipt: Optional[Dict[str, Any]] = None) -> List[List[str]]:
        if receipt is not None:
            self.check_receipt(receipt, viewer=True)
        base = [self.node, self.entry, "dashboard", "--config", self.config, "--port", str(self.port)]
        return [base + ["--no-openrouter-key"], base + ["--no-openrouter-key", "--no-codex-quota"], base, base + ["--no-codex-quota"]]

    def viewer_start_argv(self) -> List[str]:
        return self.viewer_argvs()[0]

    def data_dir(self) -> str:
        if self._data_dir is None:
            cfg = read_json(self.config)
            if cfg is None:
                raise ControlError(EXIT_CONFIG, "cannot read the configured world config as JSON: %s" % self.config)
            storage = cfg.get("storage")
            data_dir = storage.get("dataDir") if isinstance(storage, dict) else None
            if not isinstance(data_dir, str) or not os.path.isabs(data_dir):
                raise ControlError(EXIT_CONFIG, "the world config must set an absolute storage.dataDir (auth and status live there): %s" % self.config)
            self._data_dir = data_dir
        return self._data_dir

    def status_path(self) -> str:
        return os.path.join(self.data_dir(), "dashboard", "status.json")

    def log(self, action: str, message: str) -> None:
        try:
            fd = open_private_log(self.controls_log, append=True)
            with os.fdopen(fd, "a", encoding="utf-8") as fh:
                fh.write("%s %s %s\n" % (now_iso(), action, GENERIC_KEY.sub("[redacted]", message)))
        except OSError:
            pass


def load_profile(path: str, default_used: bool) -> Dict[str, Any]:
    try:
        st = os.stat(path)
    except OSError:
        raise ControlError(EXIT_CONFIG, "operator profile not found: %s (Codex registers it; these controls never create it)" % path)
    if st.st_uid != os.getuid() or st.st_mode & 0o022:
        raise ControlError(EXIT_CONFIG, "operator profile must be owned by you and not group/world writable: %s" % path)
    prof = read_json(path)
    if prof is None:
        raise ControlError(EXIT_CONFIG, "operator profile is not a JSON object: %s" % path)
    problems: List[str] = []
    for key, kind in PROFILE_FIELDS.items():
        v = prof.get(key)
        if not isinstance(v, kind) or isinstance(v, bool):
            problems.append("%s must be %s" % (key, kind.__name__))
    if problems:
        raise ControlError(EXIT_CONFIG, "invalid operator profile (%s): %s" % (path, "; ".join(problems)))
    if prof["schemaVersion"] != 1:
        problems.append("schemaVersion must be 1")
    for key in ("repoRoot", "artifactDir", "configPath", "nodePath", "runtimeDir"):
        if not os.path.isabs(prof[key]):
            problems.append("%s must be an absolute path" % key)
    if not HEX64.match(prof["buildDigest"]):
        problems.append("buildDigest must be 64 lowercase hex")
    if not COMMIT.match(prof["releaseCommit"]):
        problems.append("releaseCommit must be a hex commit id")
    if not 1 <= prof["dashboardPort"] <= 65535:
        problems.append("dashboardPort must be 1..65535")
    if not ENV_NAME.match(prof["keyEnv"]):
        problems.append("keyEnv must be an environment variable NAME")
    if not SELECTOR.match(prof["vaultSelector"]):
        problems.append("vaultSelector must be password|username|notes|uri|field:<NAME>")
    if not prof["vaultItem"].strip():
        problems.append("vaultItem must be a non-empty item NAME")
    if problems:
        raise ControlError(EXIT_CONFIG, "invalid operator profile (%s): %s" % (path, "; ".join(problems)))
    real = os.path.realpath
    if default_used and real(prof["repoRoot"]) != real(REPO_ROOT):
        raise ControlError(EXIT_CONFIG, "operator profile repoRoot does not match this checkout (%s)" % REPO_ROOT)
    if real(prof["artifactDir"]) in (real(prof["repoRoot"]), real(REPO_ROOT)):
        raise ControlError(EXIT_CONFIG, "artifactDir is the mutable repository checkout; the profile must register an accepted published artifact")
    return prof


def verify_artifact(ctx: Ctx) -> None:
    """The registered artifact, node and config exist; the dist digest equals the profile pin."""
    if not (os.path.isfile(ctx.node) and os.access(ctx.node, os.X_OK)):
        raise ControlError(EXIT_CONFIG, "pinned node is not executable: %s" % ctx.node)
    try:
        v = subprocess.run([ctx.node, "--version"], capture_output=True, text=True, timeout=15, env=PS_ENV)
    except (OSError, subprocess.TimeoutExpired):
        raise ControlError(EXIT_CONFIG, "pinned node did not report its version: %s" % ctx.node)
    if v.returncode != 0 or not v.stdout.strip().startswith("v24."):
        raise ControlError(EXIT_CONFIG, "pinned node must be Node 24 (got %r): %s" % (v.stdout.strip()[:40], ctx.node))
    if not os.path.isfile(ctx.entry):
        raise ControlError(EXIT_CONFIG, "artifact entry point is missing: %s" % ctx.entry)
    if not os.path.isfile(ctx.config):
        raise ControlError(EXIT_CONFIG, "world config is missing: %s" % ctx.config)
    ctx.data_dir()
    actual = build_digest(os.path.join(ctx.artifact, "dist"))
    if actual != ctx.p["buildDigest"]:
        raise ControlError(EXIT_CONFIG, "artifact build digest %s does not match the registered %s; nothing started (the controls never build or install)" % (actual[:16], ctx.p["buildDigest"][:16]))


def ensure_runtime_dir(ctx: Ctx) -> None:
    os.makedirs(ctx.runtime, mode=0o700, exist_ok=True)


class Lock:
    def __init__(self, path: str, timeout: float) -> None:
        self.path = path
        self.timeout = timeout
        self.fd: Optional[int] = None

    def __enter__(self) -> "Lock":
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError as e:
                if e.errno not in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                    raise
            if time.monotonic() >= deadline:
                os.close(self.fd)
                self.fd = None
                raise ControlError(EXIT_BUSY, "another play/dashboard/logout action is in progress; try again when it finishes")
            time.sleep(0.1)

    def __exit__(self, *exc: Any) -> None:
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
            self.fd = None


def archive(path: str, receipt: Dict[str, Any], prefix: str, extra: Dict[str, Any]) -> str:
    """Moves a receipt to <prefix>-<pid>.json (never overwriting) with the stop record."""
    pid = receipt.get("pid") if isinstance(receipt.get("pid"), int) else "unknown"
    dest = os.path.join(os.path.dirname(path), "%s-%s.json" % (prefix, pid))
    if os.path.exists(dest):
        dest = os.path.join(os.path.dirname(path), "%s-%s-%s.json" % (prefix, pid, stamp()))
    merged = dict(receipt)
    merged.update(extra)
    write_private_json(dest, merged)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    fsync_dir(os.path.dirname(path))
    return dest


def child_env(ctx: Ctx, key: Optional[str]) -> Dict[str, str]:
    env = dict(os.environ)
    env.pop(ctx.key_env, None)
    env.pop("CHUNKBOT_CREDS_HELPER", None)
    env["PATH"] = os.path.dirname(ctx.node) + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    if key:
        env[ctx.key_env] = key
    return env


def obtain_key(ctx: Ctx) -> Tuple[str, str]:
    inherited = os.environ.get(ctx.key_env)
    if inherited:
        return inherited, "inherited"
    helper = os.environ.get("CHUNKBOT_CREDS_HELPER") or DEFAULT_CREDS_HELPER
    if not os.path.isfile(helper):
        raise ControlError(EXIT_FAIL, "%s is not set and the local creds helper is missing (%s); export %s or install the helper, then run again. Nothing started." % (ctx.key_env, helper, ctx.key_env))
    sel = ctx.p["vaultSelector"]
    select = ["--field", sel[len("field:"):]] if sel.startswith("field:") else ["--" + sel]
    try:
        r = subprocess.run([sys.executable, helper, "get", ctx.p["vaultItem"]] + select + ["-n"], stdin=subprocess.DEVNULL, capture_output=True, timeout=90)
    except subprocess.TimeoutExpired:
        raise ControlError(EXIT_FAIL, "the creds helper did not answer within 90 s; check the vault (helper.py check) and run again. Nothing started.")
    value = r.stdout.decode("utf-8", "replace").strip()
    if r.returncode != 0 or not value:
        detail = redact(r.stderr.decode("utf-8", "replace"), value or None).strip()[-300:]
        raise ControlError(EXIT_FAIL, "the creds helper could not provide %s (exit %d): %s. Unlock the vault (helper.py check) and run again. Nothing started." % (ctx.key_env, r.returncode, detail or "no detail"))
    return value, "creds-helper"


def ready_evidence(status: Optional[Dict[str, Any]], pid: int, not_before_ms: float) -> Tuple[bool, str]:
    """True only for THIS pid/run's current publisher reporting a ready connection."""
    if status is None:
        return False, "no dashboard status published yet"
    pub = status.get("publisher") if isinstance(status.get("publisher"), dict) else {}
    if pub.get("pid") != pid:
        return False, "published status belongs to another process"
    started = pub.get("startedAtMs")
    if not isinstance(started, (int, float)) or started < not_before_ms:
        return False, "published status is from an older run"
    if pub.get("state") != "running":
        return False, "publisher is %s" % pub.get("state")
    published = pub.get("publishedAtMs")
    if not isinstance(published, (int, float)) or not 0 <= time.time() * 1000.0 - published < 15_000:
        return False, "published status is stale or undated"
    conn = status.get("connection") if isinstance(status.get("connection"), dict) else {}
    if conn.get("state") != "ready":
        return False, "connection is %s" % conn.get("state")
    return True, "ready (run %s)" % pub.get("runId")


def known_value(v: Any) -> Optional[str]:
    if isinstance(v, dict) and isinstance(v.get("value"), str):
        return v["value"][:64]
    return None


def stop_own_child(proc: "subprocess.Popen[bytes]", grace: float) -> str:
    """Cleanup of a child THIS invocation spawned (unreaped, so its pid cannot be reused)."""
    for sig, wait in ((signal.SIGINT, grace), (signal.SIGINT, 10.0), (signal.SIGKILL, 5.0)):
        if proc.poll() is not None:
            break
        try:
            proc.send_signal(sig)
        except ProcessLookupError:
            break
        try:
            proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            continue
    rc = proc.poll()
    return "exited %s" % rc if rc is not None else "still running"


def failed_start_record(path: str, receipt: Dict[str, Any], prefix: str, extra: Dict[str, Any]) -> str:
    """Keep the active receipt if cleanup cannot prove the child exited."""
    if extra.get("processStopped") is False:
        merged = dict(receipt)
        merged.update(extra)
        write_private_json(path, merged)
        return path
    return archive(path, receipt, prefix, extra)


def cleanup_failed_spawn(ctx: Ctx, proc: "subprocess.Popen[bytes]", path: str, prefix: str) -> None:
    """Every failure/interrupt after spawn cleans up only this invocation's child."""
    if proc.poll() is None:
        stop_own_child(proc, ctx.args.logout_timeout)
    receipt = read_json(path)
    if receipt is not None and receipt.get("pid") == proc.pid:
        try:
            failed_start_record(path, receipt, prefix, {
                "stoppedAt": now_iso(), "startupFailed": True,
                "stoppedBy": "operator startup interrupted or failed",
                "processStopped": proc.poll() is not None,
            })
        except OSError:
            print("Startup cleanup record could not be saved; inspect %s." % path, file=sys.stderr)
    if proc.poll() is None:
        print("Startup cleanup could not confirm pid %d exited; its receipt is retained for inspection." % proc.pid, file=sys.stderr)


# ----------------------------------------------------------------- viewer


def ensure_viewer(ctx: Ctx, action: str) -> str:
    """Reuses the proven viewer or starts one. Never touches the bot. Returns the URL."""
    receipt = read_json(ctx.viewer)
    if receipt is not None:
        state, detail = prove(receipt.get("pid"), receipt.get("processBirth"), ctx.viewer_argvs(receipt))
        if state == "proven":
            url = ctx.url
            if http_ok(url):
                print("Dashboard already running (pid %s): %s" % (receipt.get("pid"), url))
                ctx.log(action, "viewer reused pid=%s" % receipt.get("pid"))
                return url
            raise ControlError(EXIT_FAIL, "the recorded dashboard viewer (pid %s) is running but not answering at %s; it was not restarted. Stop it and run dashboard.command again." % (receipt.get("pid"), url))
        if state == "mismatch":
            raise ControlError(EXIT_REFUSED, "viewer receipt does not match its process (%s); nothing was signalled or started. Inspect %s." % (detail, ctx.viewer))
        dest = archive(ctx.viewer, receipt, "viewer-previous", {"stoppedAt": now_iso(), "stoppedBy": "%s: viewer not running (%s)" % (action, detail), "processStopped": True})
        ctx.log(action, "stale viewer receipt archived to %s (%s)" % (os.path.basename(dest), detail))
    if port_in_use(ctx.port):
        raise ControlError(EXIT_REFUSED, "dashboard port %d is in use by a process these controls did not start; not starting a second viewer and not signalling it." % ctx.port)
    argv = ctx.viewer_start_argv()
    log_path = os.path.join(ctx.runtime, "viewer-%s.log" % stamp())
    log_fd = open_private_log(log_path)
    try:
        proc = subprocess.Popen(argv, cwd=ctx.artifact, env=child_env(ctx, None), stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    finally:
        os.close(log_fd)
    try:
        birth = process_birth(proc.pid)
        if birth is None:
            raise ControlError(EXIT_FAIL, "cannot record the new viewer identity; startup cancelled")
        rec = {
            "pid": proc.pid,
            "processBirth": birth,
            "port": ctx.port,
            "url": ctx.url,
            "readOnly": True,
            "dataDir": ctx.data_dir(),
            "artifact": ctx.artifact,
            "keyMetadata": False,
            "codexQuota": True,
            "entryPoint": ctx.entry,
            "nodePath": ctx.node,
            "config": ctx.config,
            "log": log_path,
            "startedAt": now_iso(),
            "startedBy": "play-controls %s" % action,
            "controlsVersion": CONTROLS_VERSION,
        }
        write_private_json(ctx.viewer, rec)
        deadline = time.monotonic() + ctx.args.viewer_timeout
        while True:
            rc = proc.poll()
            if rc is not None:
                archive(ctx.viewer, rec, "viewer-previous", {"stoppedAt": now_iso(), "stoppedBy": "%s: viewer exited during startup" % action, "exitCode": rc, "processStopped": True})
                raise ControlError(EXIT_FAIL, "the dashboard viewer exited during startup (exit %s). Log tail:\n%s" % (rc, tail(log_path, None)))
            if http_ok(ctx.url, timeout=1.0):
                break
            if time.monotonic() >= deadline:
                outcome = stop_own_child(proc, 5.0)
                failed_start_record(ctx.viewer, rec, "viewer-previous", {"stoppedAt": now_iso(), "stoppedBy": "%s: viewer startup timeout cleanup (%s)" % (action, outcome), "processStopped": proc.poll() is not None})
                raise ControlError(EXIT_FAIL, "the dashboard did not answer at %s within %.0f s; the viewer this run started was stopped (%s). Log: %s" % (ctx.url, ctx.args.viewer_timeout, outcome, log_path))
            time.sleep(0.2)
        print("Dashboard started (pid %d): %s" % (proc.pid, ctx.url))
        ctx.log(action, "viewer started pid=%d port=%d" % (proc.pid, ctx.port))
        return ctx.url
    except BaseException:
        cleanup_failed_spawn(ctx, proc, ctx.viewer, 'viewer-previous')
        raise


def open_url(ctx: Ctx, url: str) -> None:
    if ctx.args.no_open or os.environ.get("CHUNKBOT_CONTROLS_NO_OPEN") == "1":
        return
    try:
        subprocess.run(["/usr/bin/open", url], timeout=15, stdin=subprocess.DEVNULL, capture_output=True)
    except (OSError, subprocess.TimeoutExpired):
        print("Open %s in your browser." % url)


# ----------------------------------------------------------------- actions


def bot_running(ctx: Ctx, action: str) -> Optional[Dict[str, Any]]:
    """The proven running bot receipt, None when none runs. Archives stale receipts; refuses unproven ones."""
    receipt = read_json(ctx.current)
    if receipt is not None:
        state, detail = prove(receipt.get("pid"), receipt.get("processBirth"), [ctx.run_argv(receipt)])
        if state == "proven":
            return receipt
        if state == "mismatch":
            raise ControlError(EXIT_REFUSED, "bot receipt does not match its process (%s); nothing was signalled or started. Inspect %s." % (detail, ctx.current))
        dest = archive(ctx.current, receipt, "previous", {"stoppedAt": now_iso(), "stoppedBy": "%s: recorded process not running (%s); exit not observed by these controls" % (action, detail), "processStopped": True, "endedUnobserved": True})
        ctx.log(action, "stale bot receipt archived to %s (%s)" % (os.path.basename(dest), detail))
    others = scan_exact([ctx.run_argv()])
    if others:
        raise ControlError(EXIT_REFUSED, "a Chunkbot process with the registered command line is running without a matching receipt (pid %s); it is not adopted or signalled. Stop it yourself or ask Codex." % ", ".join(str(p) for p in others))
    return None


def act_play(ctx: Ctx) -> int:
    verify_artifact(ctx)
    ensure_runtime_dir(ctx)
    with Lock(ctx.lock_path, ctx.args.lock_timeout):
        running = bot_running(ctx, "play")
        if running is not None:
            ready, why = ready_evidence(read_json(ctx.status_path()), running["pid"], 0)
            print("Chunkbot is already running (pid %s, run %s, started %s); not starting another — its process and budget are unchanged. Status: %s." % (running.get("pid"), running.get("runId", "unknown"), running.get("startedAt", "unknown"), why))
            ctx.log("play", "duplicate start: kept pid=%s" % running.get("pid"))
        else:
            start_bot(ctx)
        url = ensure_viewer(ctx, "play")
    open_url(ctx, url)
    return EXIT_OK


def start_bot(ctx: Ctx) -> None:
    key, key_source = obtain_key(ctx)
    env = child_env(ctx, key)
    config_digest = sha256_file(ctx.config)
    log_path = os.path.join(ctx.runtime, "%s.log" % stamp())
    log_fd = open_private_log(log_path)
    try:
        try:
            doctor = subprocess.run([ctx.node, ctx.entry, "doctor", "--config", ctx.config], cwd=ctx.artifact, env=env, stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT, timeout=ctx.args.doctor_timeout)
        except subprocess.TimeoutExpired:
            raise ControlError(EXIT_FAIL, "read-only doctor did not finish within %.0f s; nothing started. Log: %s" % (ctx.args.doctor_timeout, log_path))
        if doctor.returncode != 0:
            raise ControlError(EXIT_FAIL, "read-only doctor failed (exit %d); nothing started. Log tail:\n%s" % (doctor.returncode, tail(log_path, key)))
        os.write(log_fd, ("\n[play-controls] %s starting run\n" % now_iso()).encode())
        spawn_ms = time.time() * 1000.0
        argv = ctx.run_argv()
        proc = subprocess.Popen(argv, cwd=ctx.artifact, env=env, stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    finally:
        os.close(log_fd)
    del env
    try:
        birth = process_birth(proc.pid)
        if birth is None:
            raise ControlError(EXIT_FAIL, "cannot record the new bot identity; startup cancelled")
        rec: Dict[str, Any] = {
            "startedAt": now_iso(),
            "pid": proc.pid,
            "processGroup": proc.pid,
            "processBirth": birth,
            "release": ctx.p["releaseCommit"],
            "sourceArtifact": ctx.artifact,
            "entryPoint": ctx.entry,
            "nodePath": ctx.node,
            "config": ctx.config,
            "configDigest": config_digest,
            "buildDigest": ctx.p["buildDigest"],
            "log": log_path,
            "doctorExit": 0,
            "keySource": key_source,
            "keyPersisted": False,
            "startsIdle": True,
            "noAutomaticGoal": True,
            "restartPolicy": ctx.p["restartPolicy"],
            "dashboardUrl": ctx.url,
            "ready": False,
            "startedBy": "play-controls play",
            "controlsVersion": CONTROLS_VERSION,
        }
        write_private_json(ctx.current, rec)
        ctx.log("play", "started pid=%d log=%s" % (proc.pid, os.path.basename(log_path)))
        print("Starting Chunkbot (pid %d); waiting up to %.0f s for this run to report ready..." % (proc.pid, ctx.args.start_timeout))
        deadline = time.monotonic() + ctx.args.start_timeout
        why = "no status yet"
        status_path = ctx.status_path()
        while True:
            rc = proc.poll()
            if rc is not None:
                archive(ctx.current, rec, "previous", {"stoppedAt": now_iso(), "stoppedBy": "play: exited during startup", "exitCode": rc, "startupFailed": True, "processStopped": True})
                ctx.log("play", "startup failed pid=%d exit=%s" % (proc.pid, rc))
                raise ControlError(EXIT_FAIL, "Chunkbot exited during startup (exit %s); not retried. Log tail:\n%s" % (rc, tail(log_path, key)))
            status = read_json(status_path)
            ok, why = ready_evidence(status, proc.pid, spawn_ms - 2000.0)
            if ok and status is not None:
                pub = status["publisher"]
                rec.update({"ready": True, "readyAt": now_iso(), "runId": pub.get("runId")})
                name = known_value(status["connection"].get("botName"))
                if name:
                    rec["botName"] = name
                write_private_json(ctx.current, rec)
                ctx.log("play", "ready pid=%d run=%s" % (proc.pid, pub.get("runId")))
                print("Chunkbot is online (pid %d, run %s). It joins idle; give it goals in game with !chunkbot ..." % (proc.pid, pub.get("runId")))
                return
            if time.monotonic() >= deadline:
                outcome = stop_own_child(proc, ctx.args.logout_timeout)
                failed_start_record(ctx.current, rec, "previous", {"stoppedAt": now_iso(), "stoppedBy": "play: startup timeout cleanup (%s)" % outcome, "startupFailed": True, "shutdownSignal": "SIGINT", "processStopped": proc.poll() is not None})
                ctx.log("play", "startup timeout pid=%d (%s; last: %s)" % (proc.pid, outcome, why))
                raise ControlError(EXIT_FAIL, "Chunkbot did not report ready within %.0f s (last: %s); the process this run started was stopped (%s). Not retried. Log tail:\n%s" % (ctx.args.start_timeout, why, outcome, tail(log_path, key)))
            time.sleep(0.25)
    except BaseException:
        cleanup_failed_spawn(ctx, proc, ctx.current, 'previous')
        raise


def act_dashboard(ctx: Ctx) -> int:
    verify_artifact(ctx)
    ensure_runtime_dir(ctx)
    with Lock(ctx.lock_path, ctx.args.lock_timeout):
        url = ensure_viewer(ctx, "dashboard")
    open_url(ctx, url)
    return EXIT_OK


def act_logout(ctx: Ctx) -> int:
    ensure_runtime_dir(ctx)
    with Lock(ctx.lock_path, ctx.args.lock_timeout):
        receipt = read_json(ctx.current)
        if receipt is None:
            others = scan_exact([ctx.run_argv()])
            if others:
                raise ControlError(EXIT_REFUSED, "a Chunkbot process with the registered command line is running without a receipt (pid %s); it was NOT signalled." % ", ".join(str(p) for p in others))
            print("Chunkbot is not running; nothing to log out.")
            return EXIT_OK
        pid = receipt.get("pid")
        state, detail = prove(pid, receipt.get("processBirth"), [ctx.run_argv(receipt)])
        if state == "reused" and pid in scan_exact([ctx.run_argv()]):
            raise ControlError(EXIT_REFUSED, "a process with the registered command is running but its birth does not match the receipt; nothing was signalled")
        if state in ("absent", "reused"):
            dest = archive(ctx.current, receipt, "previous", {"stoppedAt": now_iso(), "stoppedBy": "logout: recorded process not running (%s); nothing signalled" % detail, "processStopped": True, "endedUnobserved": True})
            ctx.log("logout", "nothing signalled (%s); archived %s" % (detail, os.path.basename(dest)))
            print("Chunkbot is not running (%s); nothing was signalled." % detail)
            return EXIT_OK
        if state != "proven":
            raise ControlError(EXIT_REFUSED, "refusing to signal: %s. Nothing was signalled." % detail)
        assert isinstance(pid, int)
        connections = tcp_connections(pid)
        # Re-prove immediately before signalling (pid reuse window).
        if prove(pid, receipt.get("processBirth"), [ctx.run_argv(receipt)])[0] != "proven":
            raise ControlError(EXIT_REFUSED, "process identity changed before signalling; nothing was signalled.")
        os.kill(pid, signal.SIGINT)
        ctx.log("logout", "SIGINT sent to pid=%d" % pid)
        print("Logging Chunkbot out (pid %d); waiting up to %.0f s..." % (pid, ctx.args.logout_timeout))
        deadline = time.monotonic() + ctx.args.logout_timeout
        while pid_exists(pid) and process_birth(pid) == receipt.get("processBirth"):
            if time.monotonic() >= deadline:
                ctx.log("logout", "pid=%d still running after %.0f s" % (pid, ctx.args.logout_timeout))
                raise ControlError(EXIT_FAIL, "Chunkbot (pid %d) did not exit within %.0f s after SIGINT and is still running. Run logout.command again to send a second SIGINT (the app treats it as a forced shutdown). Nothing else was signalled." % (pid, ctx.args.logout_timeout))
            time.sleep(0.2)
        if connections is None:
            socket_closed: Any = "unverified (lsof unavailable)"
        else:
            still = [c for c in connections if connection_still_open(c) is not False]
            socket_closed = not still
        status = read_json(ctx.status_path())
        pub = status.get("publisher") if status and isinstance(status.get("publisher"), dict) else {}
        publisher_stopped = pub.get("pid") == pid and pub.get("state") == "stopped"
        dest = archive(ctx.current, receipt, "previous", {
            "stoppedAt": now_iso(),
            "stoppedBy": "play-controls logout",
            "shutdownSignal": "SIGINT",
            "processStopped": True,
            "serverSocketClosed": socket_closed,
            "serverConnectionsBefore": len(connections) if connections is not None else None,
            "publisherStopped": publisher_stopped,
            "noReconnectAuthorized": True,
        })
        ctx.log("logout", "pid=%d exited; sockets closed=%s publisher stopped=%s; %s" % (pid, socket_closed, publisher_stopped, os.path.basename(dest)))
    print("Chunkbot logged out (pid %d exited; server connection closed: %s; final status published: %s). The dashboard stays open with historical status. Run play.command to start a new run." % (pid, socket_closed, publisher_stopped))
    return EXIT_OK


def act_status(ctx: Ctx) -> int:
    """Read-only: no lock, no directory creation, no signals, no writes."""
    out: Dict[str, Any] = {"profile": ctx.profile_path, "release": ctx.p["releaseCommit"], "artifact": ctx.artifact}
    try:
        out["artifactDigestMatches"] = build_digest(os.path.join(ctx.artifact, "dist")) == ctx.p["buildDigest"]
    except ControlError as e:
        out["artifactDigestMatches"] = False
        out["artifactProblem"] = e.message
    bot: Dict[str, Any] = {}
    receipt = read_json(ctx.current)
    if receipt is None:
        bot["state"] = "not running (no receipt)"
    else:
        state, detail = prove(receipt.get("pid"), receipt.get("processBirth"), [ctx.run_argv(receipt)])
        bot.update({"state": state, "detail": detail, "pid": receipt.get("pid"), "runId": receipt.get("runId"), "startedAt": receipt.get("startedAt"), "release": receipt.get("release")})
        if state == "proven":
            try:
                status = read_json(ctx.status_path())
                ok, why = ready_evidence(status, receipt["pid"], 0)
                pub = status.get("publisher", {}) if status else {}
                age = (time.time() * 1000.0 - pub["publishedAtMs"]) / 1000.0 if isinstance(pub.get("publishedAtMs"), (int, float)) else None
                bot["ready"] = ok and age is not None and age < 15
                bot["readiness"] = why if age is None or age < 15 else "status is stale (%.0f s old)" % age
            except ControlError as e:
                bot["readiness"] = e.message
    unrecorded = [p for p in scan_exact([ctx.run_argv()]) if not receipt or p != receipt.get("pid")]
    if unrecorded:
        bot["unrecordedProcesses"] = unrecorded
    out["bot"] = bot
    viewer: Dict[str, Any] = {}
    vr = read_json(ctx.viewer)
    if vr is None:
        viewer["state"] = "not running (no receipt)"
    else:
        state, detail = prove(vr.get("pid"), vr.get("processBirth"), ctx.viewer_argvs(vr))
        url = ctx.url
        viewer.update({"state": state, "detail": detail, "pid": vr.get("pid"), "url": url, "answering": state == "proven" and http_ok(url)})
    out["viewer"] = viewer
    if ctx.args.json:
        print(json.dumps(out, indent=2))
    else:
        print("Chunkbot release %s (artifact digest %s)" % (ctx.p["releaseCommit"][:12], "matches" if out["artifactDigestMatches"] else "DOES NOT MATCH"))
        if receipt is None:
            print("Bot: not running")
        else:
            print("Bot: %s — pid %s, run %s, started %s; %s" % (bot["state"], bot.get("pid"), bot.get("runId") or "unknown", bot.get("startedAt"), bot.get("readiness", bot["detail"])))
        if unrecorded:
            print("WARNING: unrecorded Chunkbot process(es) with the registered command line: %s" % unrecorded)
        if vr is None:
            print("Dashboard: not running")
        else:
            print("Dashboard: %s — pid %s, %s%s" % (viewer["state"], viewer.get("pid"), viewer.get("url"), " (answering)" if viewer.get("answering") else ""))
    return EXIT_OK


ACTIONS = {"play": act_play, "dashboard": act_dashboard, "logout": act_logout, "status": act_status}


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="play-controls", description="Local Chunkbot play/dashboard/logout/status controls.")
    ap.add_argument("action", choices=sorted(ACTIONS))
    ap.add_argument("--profile")
    ap.add_argument("--no-open", action="store_true", help="do not open the dashboard in a browser")
    ap.add_argument("--json", action="store_true", help="status: machine-readable output")
    ap.add_argument("--start-timeout", type=float, default=180.0)
    ap.add_argument("--doctor-timeout", type=float, default=120.0)
    ap.add_argument("--logout-timeout", type=float, default=45.0)
    ap.add_argument("--viewer-timeout", type=float, default=20.0)
    ap.add_argument("--lock-timeout", type=float, default=15.0)
    args = ap.parse_args(argv)
    for name in ("start_timeout", "doctor_timeout", "logout_timeout", "viewer_timeout", "lock_timeout"):
        v = getattr(args, name)
        if not 0 < v <= 3600:
            print("play-controls: --%s must be within (0, 3600] seconds" % name.replace("_", "-"), file=sys.stderr)
            return EXIT_CONFIG
    profile_path = os.path.abspath(args.profile) if args.profile else DEFAULT_PROFILE
    try:
        profile = load_profile(profile_path, default_used=not args.profile)
        ctx = Ctx(profile_path, profile, args)
        code = ACTIONS[args.action](ctx)
    except ControlError as e:
        print("play-controls %s: %s" % (args.action, e.message), file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        print("play-controls %s: interrupted" % args.action, file=sys.stderr)
        return EXIT_FAIL
    except OSError as e:
        print("play-controls %s: local file or process operation failed (errno %s)" % (args.action, e.errno), file=sys.stderr)
        return EXIT_FAIL
    return code


if __name__ == "__main__":
    sys.exit(main())
