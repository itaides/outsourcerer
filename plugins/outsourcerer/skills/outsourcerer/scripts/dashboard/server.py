#!/usr/bin/env python3
"""Outsourcerer dashboard server: a local, token-gated, read-only window onto the CLI.

Every number the page shows comes from one allow-listed `outsourcerer <command> --json` call. The
server adds no logic of its own: it checks who is asking, runs the mapped argv (never a shell), and
passes the CLI's JSON through unchanged.

Safety, in order:
  - binds to loopback only (127.0.0.1, or localhost meaning the same); any other --host is refused;
  - every request needs the token from <OSRC_HOME>/dash/token (mode 0600, created on first start),
    as `Authorization: Bearer <token>` or the cookie set by visiting /?token=<token> once;
  - the Host header must name this loopback address, so a page on another site cannot reach the
    server through a DNS name that resolves to 127.0.0.1;
  - GET reads run allow-listed --json commands; path parameters are validated against a strict
    pattern and passed as separate argv elements;
  - POST /api/run runs one action, and only when its argv matches an ACTIONS shape exactly (fixed
    words plus validated values). POSTs also need the X-Osrc-Dash header and a JSON body, which a
    cross-site form cannot send; the output is redacted before it is returned;
  - the request log never prints a query string (it can hold the token).

Standard library only, Python 3.8+.
"""
import argparse
import hmac
import json
import mimetypes
import os
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

LOOPBACK = {"127.0.0.1", "localhost"}
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")
COOKIE = "osrc_dash"
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
CLI_TIMEOUT = int(os.environ.get("OSRC_DASH_CLI_TIMEOUT", "90"))

# name -> (argv builder, cache seconds, response kind). A builder gets (path_arg, query) and returns
# the argv after the CLI path, or None when the parameters are invalid.
def _fixed(*argv):
    return lambda arg, q: list(argv) if arg is None else None

def _with_id(*before, after=()):
    def build(arg, q):
        if arg is None or not ID_RE.match(arg) or ".." in arg:
            return None
        return list(before) + [arg] + list(after)
    return build

def _outcomes(arg, q):
    if arg is not None:
        return None
    days = (q.get("days") or ["90"])[0]
    if not days.isdigit() or not (1 <= int(days) <= 3650):
        return None
    return ["outcomes", "--days", days, "--json"]

def _task_text(verb):
    def build(arg, q):
        task = (q.get("task") or [""])[0]
        if arg is not None or not task.strip() or len(task) > 4000:
            return None
        return [verb, "--json", task] if verb == "advise" else ["estimate", "--json", task]
    return build

ENDPOINTS = {
    "inbox":      (_fixed("inbox", "--json"), 5, "json"),
    "status":     (_fixed("status", "--json"), 5, "json"),
    "fleet":      (_fixed("fleet", "ls", "--json"), 10, "json"),
    "brief":      (_fixed("brief", "--json"), 30, "json"),
    "tab":        (_fixed("tab", "--json"), 60, "json"),
    "outcomes":   (_outcomes, 60, "json"),
    "doctor":     (_fixed("doctor", "--json"), 120, "json"),
    "mode":       (_fixed("mode", "status", "--json"), 10, "json"),
    "consent":    (_fixed("consent", "status", "--json"), 30, "json"),
    "exclude":    (_fixed("exclude", "ls", "--json"), 30, "json"),
    "limits":     (_fixed("limits", "status", "--json"), 30, "json"),
    "heartbeat":  (_fixed("heartbeat", "status", "--json"), 10, "json"),
    "posture":    (_fixed("posture", "status", "--json"), 30, "json"),
    "tap":        (_fixed("tap", "status", "--json"), 30, "json"),
    "plans":      (_fixed("plan", "ls", "--json"), 10, "json"),
    "plan":       (_with_id("plan", "show", after=("--json",)), 10, "json"),
    "flows":      (_fixed("flow", "ls", "--json"), 300, "json"),
    "land-queue": (_fixed("land", "queue", "--json"), 10, "json"),
    "loops":      (_fixed("loop", "status", "--json"), 5, "json"),
    "fanouts":    (_fixed("fanout", "list", "--json"), 10, "json"),
    "models":     (_fixed("models", "--json"), 300, "json"),
    "fanout":     (_with_id("fanout", "status", after=("--json",)), 5, "json"),
    "loop":       (_with_id("loop", "status", after=("--json",)), 5, "json"),
    "job":        (_with_id("status", after=("--json",)), 3, "json"),
    "explain":    (_with_id("explain", after=("--json",)), 10, "json"),
    "logs":       (_with_id("logs", after=("--masked", "--tail", "40")), 3, "text"),
    "estimate":   (_task_text("estimate"), 30, "json"),
    "advise":     (_task_text("advise"), 30, "json"),
}

# Actions the page may run, as argv shapes after `outsourcerer`. A literal must match exactly; a
# placeholder names the validator for that position. Nothing else can be run, and never via a shell.
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$")
VALIDATORS = {
    "{job}":    lambda v: bool(ID_RE.match(v)) and ".." not in v,
    "{task}":   lambda v: bool(re.match(r"^t[0-9]{1,6}$", v)),
    "{plan}":   lambda v: bool(ID_RE.match(v)) and ".." not in v,
    "{answer}": lambda v: 0 < len(v) <= 2000 and "\x00" not in v,
    "{model}":  lambda v: bool(MODEL_RE.match(v)),
    "{sel}":    lambda v: bool(ID_RE.match(v)) and ".." not in v,
    # launching work: the task is free text but never an option; a check is one line, like a shell prompt
    "{verb}":   lambda v: v in ("run", "research", "edit", "yolo"),
    "{lverb}":  lambda v: v in ("edit", "yolo"),
    "{num}":    lambda v: v.isdigit() and 1 <= int(v) <= 999,
    "{text}":   lambda v: 0 < len(v.strip()) and len(v) <= 4000 and "\x00" not in v and not v.lstrip().startswith("-"),
    "{prov}":   lambda v: v in ("devin", "gemini"),   # lanes whose cached catalog lists models -m alone would route elsewhere
    "{check}":  lambda v: 0 < len(v.strip()) and len(v) <= 500 and "\x00" not in v and "\n" not in v,
}
ACTIONS = [
    ["task", "release", "{task}", "--plan", "{plan}", "--answer", "{answer}"],
    ["cancel", "{job}"],
    ["watch", "{job}"],
    ["explain", "{job}"],
    ["result", "{job}"],
    ["fleet", "show", "{sel}"],
    ["heartbeat", "start"],
    ["mode", "auto"], ["mode", "hybrid"], ["mode", "manual"],
    ["exclude", "add", "{model}"], ["exclude", "rm", "{model}"],
    ["consent", "grant"], ["consent", "revoke"],
    ["tap", "install"],
    ["posture", "reset"],
    # reply to a session that is waiting on you
    ["session", "reply", "{sel}", "{answer}"],
    # launch: one-shot background job, or a loop that retries until the check passes. No --cloud-ack:
    # without remembered cloud consent the launch stops and says so (grant it in Settings).
    ["bg", "{verb}", "{text}"],
    ["bg", "{verb}", "-m", "{model}", "{text}"],
    ["bg", "--worktree", "{verb}", "{text}"],
    ["bg", "--worktree", "{verb}", "-m", "{model}", "{text}"],
    ["bg", "--provider", "{prov}", "{verb}", "-m", "{model}", "{text}"],
    ["bg", "--worktree", "--provider", "{prov}", "{verb}", "-m", "{model}", "{text}"],
    ["loop", "verify", "--check", "{check}", "--verb", "{lverb}", "--max", "{num}", "--max-minutes", "{num}", "--", "{text}"],
    ["loop", "verify", "--check", "{check}", "--verb", "{lverb}", "--max", "{num}", "--max-minutes", "{num}", "--worktree", "--", "{text}"],
    ["loop", "verify", "-m", "{model}", "--check", "{check}", "--verb", "{lverb}", "--max", "{num}", "--max-minutes", "{num}", "--", "{text}"],
    ["loop", "verify", "-m", "{model}", "--check", "{check}", "--verb", "{lverb}", "--max", "{num}", "--max-minutes", "{num}", "--worktree", "--", "{text}"],
]
ACTION_TIMEOUT = int(os.environ.get("OSRC_DASH_ACTION_TIMEOUT", "60"))

# The same secret patterns as the CLI's _explain_redact, applied to action output before it leaves.
REDACT = [
    (re.compile(r"sk-[A-Za-z0-9_-]{8,}"), "[REDACTED-KEY]"),
    (re.compile(r"Bearer [A-Za-z0-9._~+/=-]{8,}"), "[REDACTED-BEARER]"),
    (re.compile(r"xox[bp]-[A-Za-z0-9-]{8,}"), "[REDACTED-SLACK]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{8,}"), "[REDACTED-GITHUB]"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[REDACTED-AWS]"),
    (re.compile(r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/:@\s]+:[^/@\s]+@"), r"\1[REDACTED-AUTH]@"),
    (re.compile(r"((?i:api[-_]?key|token|secret|pass(?:word|wd)?|authorization))(\s*[=:]\s*\"?)([^\s\"]{4,})"), r"\1\2[REDACTED]"),
]


def redact(text):
    for rx, rep in REDACT:
        text = rx.sub(rep, text)
    return text


def action_allowed(argv):
    """True when argv (after `outsourcerer`) matches one ACTIONS shape exactly."""
    if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        return False
    for shape in ACTIONS:
        if len(shape) != len(argv):
            continue
        if all((VALIDATORS[w](a) if w in VALIDATORS else w == a) for w, a in zip(shape, argv)):
            return True
    return False


CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "connect-src 'self'; base-uri 'none'; form-action 'none'; "
       "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*")


def ensure_token(home):
    """Return the dashboard token, creating <home>/dash/token (0600, dir 0700) on first use."""
    d = os.path.join(home, "dash")
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    path = os.path.join(d, "token")
    if os.path.islink(path):
        raise SystemExit("dash: refusing a symlinked token file: %s" % path)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_urlsafe(32) + "\n")
    except FileExistsError:
        pass
    if stat.S_IMODE(os.stat(path).st_mode) != 0o600:
        os.chmod(path, 0o600)
    with open(path) as f:
        tok = f.read().strip()
    if len(tok) < 16:
        raise SystemExit("dash: the token in %s is too short; delete the file to make a new one" % path)
    return tok


TTL_OVERRIDE = os.environ.get("OSRC_DASH_TTL")          # tests: one TTL for every endpoint
MAX_STALE = int(os.environ.get("OSRC_DASH_MAX_STALE", "120"))
WARM = ["inbox", "status", "fleet", "brief", "doctor", "mode", "heartbeat", "tab", "outcomes", "loops"]


class Runner:
    """Runs allow-listed CLI argv, one run per key at a time, with stale-while-revalidate caching.

    Several CLI reads are slow by nature (inbox scans the fleet, brief checks lane logins over the
    network: 3-5 s each). Within its TTL an answer is served as is. Past it, the last good answer is
    served at once and a background refresh starts, so a polling page never waits; an answer older
    than MAX_STALE seconds is recomputed before replying instead. Actions clear the cache, so what an
    action changed is always read fresh. get() returns (code, ctype, body, age_s, stale).
    """

    def __init__(self, cli, home):
        self.cli, self.home = cli, home
        self.cache, self.locks, self.guard, self.refreshing = {}, {}, threading.Lock(), set()
        self.gen = 0   # bumped by invalidate(): a read that started before an action is never cached after it

    def invalidate(self):
        with self.guard:
            self.gen += 1
            self.cache.clear()

    def _lock(self, key):
        with self.guard:
            return self.locks.setdefault(key, threading.Lock())

    def get(self, argv, ttl, kind):
        ttl = int(TTL_OVERRIDE) if TTL_OVERRIDE else ttl
        key = "\x1f".join(argv)
        hit = self.cache.get(key)
        if hit:
            age = time.time() - hit[0]
            if age < ttl:
                return hit[1], hit[2], hit[3], age, False
            if age < max(MAX_STALE, ttl):
                self._refresh_soon(key, argv, ttl, kind)
                return hit[1], hit[2], hit[3], age, True
        code, ctype, body = self.run(argv, ttl, kind)
        return code, ctype, body, 0.0, False

    def _refresh_soon(self, key, argv, ttl, kind):
        with self.guard:
            if key in self.refreshing:
                return
            self.refreshing.add(key)

        def work():
            try:
                self.run(argv, 0, kind)
            finally:
                with self.guard:
                    self.refreshing.discard(key)
        threading.Thread(target=work, daemon=True).start()

    def warm(self):
        """Fill the cache for the slow, always-needed reads right after start-up."""
        for name in WARM:
            build, ttl, kind = ENDPOINTS[name]
            threading.Thread(target=self.get, args=(build(None, {}), ttl, kind), daemon=True).start()

    def run(self, argv, ttl, kind):
        key = "\x1f".join(argv)
        with self._lock(key):
            hit = self.cache.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1], hit[2], hit[3]
            gen = self.gen
            env = dict(os.environ, OSRC_HOME=self.home, OSRC_BLIND_TURN_GUARD="0", NO_COLOR="1")
            try:
                p = subprocess.run(["bash", self.cli] + argv, stdin=subprocess.DEVNULL, capture_output=True,
                                   timeout=CLI_TIMEOUT, env=env)
            except subprocess.TimeoutExpired:
                return 504, "application/json", _err("the command timed out after %ss" % CLI_TIMEOUT, argv, None)
            out = p.stdout.decode("utf-8", "replace")
            if kind == "text":
                res = (200, "text/plain; charset=utf-8", out.encode()) if p.returncode == 0 else \
                      (502, "application/json", _err(_tail(p.stderr), argv, p.returncode))
            else:
                doc = _parse_json(out)
                # A command can exit non-zero and still print its JSON (heartbeat status: 1 = not armed).
                res = (200, "application/json", json.dumps(doc, separators=(",", ":")).encode()) if doc is not None \
                      else (502, "application/json", _err(_tail(p.stderr) or "no JSON in the output", argv, p.returncode))
            if res[0] == 200:
                with self.guard:
                    if gen == self.gen:
                        self.cache[key] = (time.time(),) + res
            return res


def launch_detached(runner, argv):
    """`loop verify` runs until the loop ends (often many minutes), longer than any request should wait.
    Start it in its own session with output to a private log, and answer at once; it shows up in
    `loop status` (Live -> Loops) within a moment."""
    d = os.path.join(runner.home, "dash", "launches")
    os.makedirs(d, mode=0o700, exist_ok=True)
    log = os.path.join(d, "loop-%d-%d.log" % (int(time.time()), os.getpid()))
    env = dict(os.environ, OSRC_HOME=runner.home, OSRC_BLIND_TURN_GUARD="0", NO_COLOR="1")
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        p = subprocess.Popen(["bash", runner.cli] + argv, stdin=subprocess.DEVNULL, stdout=fd, stderr=fd,
                             env=env, start_new_session=True)
    finally:
        os.close(fd)
    time.sleep(1.0)   # an immediate refusal (bad model, excluded, no consent) is worth reporting now
    rc = p.poll()
    try:
        with open(log, "rb") as f:
            head = redact(f.read().decode("utf-8", "replace"))[-4000:]
    except OSError:
        head = ""
    runner.invalidate()
    if rc is not None and rc != 0:
        return {"command": ["outsourcerer"] + argv, "exit": rc, "ok": False, "stdout": "", "stderr": head, "log": log}
    return {"command": ["outsourcerer"] + argv, "exit": 0 if rc is None else rc, "ok": True, "detached": rc is None, "pid": p.pid,
            "stdout": (head + "\n" if head else "") + "Started in the background (pid %d). It shows up in Live, under Loops. Log: %s" % (p.pid, log),
            "stderr": "", "log": log}


def run_action(runner, argv):
    if argv[:2] == ["loop", "verify"]:
        return launch_detached(runner, argv)
    env = dict(os.environ, OSRC_HOME=runner.home, OSRC_BLIND_TURN_GUARD="0", NO_COLOR="1")
    try:
        p = subprocess.run(["bash", runner.cli] + argv, stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=ACTION_TIMEOUT, env=env)
        rc, out, err = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        rc, out, err = None, e.stdout or b"", (e.stderr or b"") + b"\n(the action timed out)"
    runner.invalidate()  # whatever the action changed shows on the next read
    clip = lambda b: redact(b.decode("utf-8", "replace"))[-8000:]
    return {"command": ["outsourcerer"] + argv, "exit": rc, "ok": rc == 0, "stdout": clip(out), "stderr": clip(err)}


def _parse_json(text):
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        pass
    for line in reversed(text.splitlines()):  # a stray banner line before the JSON line
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def _tail(b):
    return b.decode("utf-8", "replace").strip()[-400:] if b else ""


def _err(msg, argv, rc):
    return json.dumps({"error": msg, "command": ["outsourcerer"] + argv, "exit": rc}).encode()


def make_handler(token, runner, port):
    allowed_hosts = {"127.0.0.1:%d" % port, "localhost:%d" % port}

    class Handler(BaseHTTPRequestHandler):
        server_version = "outsourcerer-dash"
        sys_version = ""

        def log_message(self, fmt, *args):  # never log the query string: it can carry the token
            sys.stderr.write("dash: %s %s -> %s\n" % (self.command, urlsplit(self.path).path, args[1] if len(args) > 1 else ""))

        def _send(self, code, ctype, body, extra=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, code, obj):
            self._send(code, "application/json", json.dumps(obj).encode())

        def _authed(self):
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip(), token):
                return True
            for part in self.headers.get("Cookie", "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == COOKIE and hmac.compare_digest(v, token):
                    return True
            return False

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            if self.headers.get("Host", "") not in allowed_hosts:
                return self._json(403, {"error": "this server only answers on its loopback address"})
            u = urlsplit(self.path)
            q = parse_qs(u.query)
            if u.path == "/" and "token" in q:
                if hmac.compare_digest(q["token"][0], token):
                    return self._send(302, "text/plain", b"", {
                        "Location": "/",
                        "Set-Cookie": "%s=%s; HttpOnly; SameSite=Strict; Path=/" % (COOKIE, token)})
                return self._json(401, {"error": "wrong token"})
            if not self._authed():
                return self._json(401, {"error": "token required: open the URL printed by `outsourcerer dash`"})
            if u.path.startswith("/api/"):
                return self._api(u.path[5:], q)
            return self._static(u.path)

        def _api(self, rest, q):
            name, _, arg = rest.partition("/")
            ep = ENDPOINTS.get(name)
            if ep is None:
                return self._json(404, {"error": "no such endpoint", "endpoints": sorted(ENDPOINTS)})
            argv = ep[0](arg or None, q)
            if argv is None:
                return self._json(400, {"error": "bad parameters for %s" % name})
            code, ctype, body, age, stale = runner.get(argv, ep[1], ep[2])
            self._send(code, ctype, body, {"X-Osrc-Age": str(int(age)), "X-Osrc-Stale": "1" if stale else "0",
                                           "Access-Control-Expose-Headers": "X-Osrc-Age, X-Osrc-Stale"})

        def _static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            rel = path.lstrip("/")
            if not re.match(r"^[A-Za-z0-9_-]+\.(html|js|css|svg)$", rel):
                return self._json(404, {"error": "not found"})
            full = os.path.join(STATIC, rel)
            if not os.path.isfile(full):
                return self._json(404, {"error": "not found"})
            with open(full, "rb") as f:
                body = f.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, ctype, body)

        def do_POST(self):
            if self.headers.get("Host", "") not in allowed_hosts:
                return self._json(403, {"error": "this server only answers on its loopback address"})
            if not self._authed():
                return self._json(401, {"error": "token required"})
            if self.headers.get("X-Osrc-Dash") != "1" or not self.headers.get("Content-Type", "").startswith("application/json"):
                return self._json(403, {"error": "actions need the X-Osrc-Dash header and a JSON body"})
            if urlsplit(self.path).path != "/api/run":
                return self._json(404, {"error": "the only action endpoint is POST /api/run"})
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = -1
            if not (0 < n <= 16384):
                return self._json(400, {"error": "body missing or too large"})
            try:
                argv = json.loads(self.rfile.read(n).decode("utf-8")).get("argv")
            except (ValueError, AttributeError, UnicodeDecodeError):
                return self._json(400, {"error": "body must be JSON: {\"argv\": [...]}"})
            if isinstance(argv, list) and argv[:1] == ["outsourcerer"]:
                argv = argv[1:]
            if not action_allowed(argv):
                return self._json(403, {"error": "this command is not an allowed action", "command": argv})
            self._json(200, run_action(runner, argv))

        def _refuse(self):
            self._json(405, {"error": "use GET to read and POST /api/run for actions"})

        do_PUT = do_DELETE = do_PATCH = _refuse

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Outsourcerer local dashboard")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("OSRC_DASH_PORT", "8091")))
    ap.add_argument("--cli", required=True, help="path to outsourcerer.sh")
    ap.add_argument("--home", default=os.environ.get("OSRC_HOME") or os.path.expanduser("~/.outsourcerer"))
    ap.add_argument("--print-url", action="store_true", help="print the sign-in URL and exit")
    a = ap.parse_args()
    if a.host not in LOOPBACK:
        sys.stderr.write("dash: refusing to listen on %s; the dashboard only binds to loopback (127.0.0.1)\n" % a.host)
        return 2
    if not (0 <= a.port <= 65535):
        sys.stderr.write("dash: bad port %s\n" % a.port)
        return 2
    token = ensure_token(a.home)
    host = "127.0.0.1"
    if a.print_url:
        print("http://127.0.0.1:%d/?token=%s" % (a.port, token))
        return 0
    srv = ThreadingHTTPServer((host, a.port), None)
    port = srv.server_address[1]
    runner = Runner(a.cli, a.home)
    srv.RequestHandlerClass = make_handler(token, runner, port)
    if os.environ.get("OSRC_DASH_NO_WARM") != "1":
        runner.warm()
    sys.stdout.write("dash: open http://127.0.0.1:%d/?token=%s\n" % (port, token))
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
