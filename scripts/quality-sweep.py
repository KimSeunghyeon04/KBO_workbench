"""Isolated quality checks for the current checkout; Python standard library only."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile


MARKER = ".quality-sweep-snapshot.json"
SOURCE_DIRS = {".agents", "apps", "database", "docs", "infra", "packages", "schemas", "scripts", "tests"}
EXCLUDED = {".git", ".data", ".backups", "node_modules", ".pnpm-store", "dist",
            "coverage", "test-results", "playwright-report", "__pycache__", ".vite"}
CHECKS = {"lint", "format:check", "typecheck", "test", "test:architecture",
          "schema:game:check", "build", "build:server", "build:web",
          "performance", "performance:analytics"}
ENV_KEYS = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
            "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "PNPM_HOME", "COREPACK_HOME"}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def source_name(name):
    """Reject sensitive paths before stat/read, including tracked or nested env files."""
    path = PurePosixPath(name)
    if (not name or "\\" in name or ":" in name or path.is_absolute() or path.as_posix() != name
            or any(part in {".", ".."} for part in name.split("/"))):
        return False
    if any(part.lower() in EXCLUDED or part.lower().startswith(".env") and name != ".env.example"
           for part in path.parts):
        return False
    return len(path.parts) == 1 or path.parts[0] in SOURCE_DIRS


def regular_file(root, name):
    if not source_name(name):
        raise ValueError(f"Excluded source path: {name}")
    path = root
    for part in PurePosixPath(name).parts:
        path = path / part
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"Links and junctions are not source files: {name}")
    if not path.is_file():
        raise ValueError(f"Not a regular file: {name}")
    return path


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args]).decode("utf-8")


def source_files(source):
    names = sorted(set(git(source, "ls-files", "-c", "-o", "--exclude-standard", "-z").split("\0")))
    files = {}
    for name in names:
        if not source_name(name):
            continue
        try:
            files[name] = regular_file(source, name)
        except FileNotFoundError:
            continue
    return files


def prepare(source, parent):
    source, parent = source.resolve(strict=True), parent.resolve(strict=True)
    if any(part.lower() in {".data", ".backups"} for part in parent.parts):
        raise ValueError("Snapshot parent cannot be a user data or backup directory")
    if Path(git(source, "rev-parse", "--show-toplevel").strip()).resolve() != source:
        raise ValueError("Source must be the repository root")
    if parent == source or parent.is_relative_to(source):
        raise ValueError("Snapshot parent must be outside the source checkout")
    paths = source_files(source)
    sandbox = Path(tempfile.mkdtemp(prefix="kbo-quality-sweep-", dir=parent)).resolve()
    files = {}
    for name, path in paths.items():
        content = path.read_bytes()
        target = sandbox / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        shutil.copymode(path, target)
        files[name] = digest(content)
    record = {"version": 1, "source": str(source), "sandbox": str(sandbox),
              "head": git(source, "rev-parse", "HEAD").strip(), "files": files}
    (sandbox / MARKER).write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n",
                                encoding="utf-8", newline="\n")
    verify(sandbox)
    return sandbox


def snapshot(sandbox):
    sandbox = sandbox.resolve(strict=True)
    marker = sandbox / MARKER
    if marker.is_symlink() or not marker.is_file():
        raise ValueError("Not a quality-sweep snapshot")
    record = json.loads(marker.read_text(encoding="utf-8"))
    if (not isinstance(record, dict) or record.get("version") != 1
            or record.get("sandbox") != str(sandbox) or not isinstance(record.get("source"), str)
            or not isinstance(record.get("files"), dict) or not record["files"]):
        raise ValueError("Invalid snapshot manifest")
    source = Path(record["source"]).resolve(strict=True)
    if sandbox == source or sandbox.is_relative_to(source) or source.is_relative_to(sandbox):
        raise ValueError("Snapshot must be separate from the source checkout")
    for name, checksum in record["files"].items():
        if (not isinstance(name, str) or not source_name(name) or not isinstance(checksum, str)
                or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum)):
            raise ValueError("Invalid source entry in snapshot manifest")
    return sandbox, source, record


def verify(sandbox):
    _, source, record = snapshot(sandbox)
    current = source_files(source)
    changed = set(record["files"]) ^ set(current)
    for name, checksum in record["files"].items():
        path = current.get(name)
        if path is None:
            continue
        try:
            if digest(path.read_bytes()) != checksum:
                changed.add(name)
        except (FileNotFoundError, ValueError):
            changed.add(name)
    if changed:
        raise ValueError(
            "Source changed since snapshot; preserve it and re-prepare: " + ", ".join(sorted(changed))
        )
    return len(record["files"])


def validate_command(command, mutation=False):
    if command[:4] == ["pnpm", "exec", "vitest", "run"] and len(command) > 4:
        paths = command[4:]
        if all(source_name(p) and re.fullmatch(r"(?:tests|packages|apps)/[A-Za-z0-9_./-]+\.test\.ts", p)
               for p in paths):
            return
    if not mutation and (command == ["pnpm", "install", "--offline", "--frozen-lockfile"]
                         or len(command) == 2 and command[0] == "pnpm" and command[1] in CHECKS):
        return
    raise ValueError("Only listed pnpm checks or explicit Vitest test files are allowed; "
                     "operational commands, Docker, migrations and shell expressions are refused")


def check_environment():
    env = {key: value for key, value in os.environ.items() if key.upper() in ENV_KEYS}
    env.update({"COREPACK_ENABLE_NETWORK": "0", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
                "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
                "PYTHONDONTWRITEBYTECODE": "1", "CI": "1", "NODE_ENV": "test"})
    return env


def run_check(sandbox, command, timeout=300):
    sandbox, _, _ = snapshot(sandbox)
    validate_command(command)
    for name in command[4:] if command[:4] == ["pnpm", "exec", "vitest", "run"] else []:
        regular_file(sandbox, name)
    corepack = shutil.which("corepack")
    if corepack is None:
        raise ValueError("Corepack with cached pnpm 10.15.1 is required")
    node = shutil.which("node")
    if node is None or not subprocess.check_output([node, "--version"], env=check_environment(),
                                                 text=True, timeout=10).strip().startswith("v24."):
        raise ValueError("Node.js 24 is required")
    # Fixed, validated arguments; no shell expression or environment assignment is accepted.
    return subprocess.run([corepack, "pnpm@10.15.1", *command[1:]], cwd=sandbox,
                          env=check_environment(), timeout=timeout, check=False).returncode


def mutate(sandbox, name, old, new, command, timeout=300, executor=run_check):
    sandbox, _, _ = snapshot(sandbox)
    validate_command(command, mutation=True)
    if not name.endswith((".ts", ".tsx")):
        raise ValueError("Mutation targets must be TypeScript source files")
    path = regular_file(sandbox, name)
    original = path.read_bytes()
    old, new = old.encode("utf-8"), new.encode("utf-8")
    if not old or old == new or original.count(old) != 1:
        raise ValueError("OLD must occur once and differ from NEW")
    if executor(sandbox, command, timeout) != 0:
        raise ValueError("Unmodified test failed; this is not mutation evidence")
    if regular_file(sandbox, name).read_bytes() != original:
        raise ValueError("Unmodified test changed the mutation target")
    try:
        path.write_bytes(original.replace(old, new, 1))
        result = executor(sandbox, command, timeout)
    finally:
        # Tests may replace files. Never follow a new link while restoring snapshot bytes.
        regular_file(sandbox, name).write_bytes(original)
        if path.read_bytes() != original:
            raise ValueError("Snapshot source bytes could not be restored")
    print("CAUGHT: inspect the failing assertion" if result else "MISSED: strengthen the test input")
    return 0 if result else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    prepare_parser = sub.add_parser("prepare")
    prepare_parser.add_argument("--source", type=Path, default=Path.cwd())
    prepare_parser.add_argument("--parent", type=Path, default=Path(tempfile.gettempdir()))
    for action in ("verify", "run", "mutate"):
        child = sub.add_parser(action)
        child.add_argument("--sandbox", type=Path, required=True)
        if action == "mutate":
            child.add_argument("--file", required=True)
            child.add_argument("--old", required=True)
            child.add_argument("--new", required=True)
        if action != "verify":
            child.add_argument("--timeout", type=int, default=300)
            child.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        if args.action == "prepare":
            print(prepare(args.source, args.parent))
            return 0
        if args.action == "verify":
            print(f"OK: {verify(args.sandbox)} original source files unchanged")
            return 0
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if args.timeout <= 0:
            raise ValueError("Timeout must be positive")
        verify(args.sandbox)
        try:
            if args.action == "mutate":
                return mutate(args.sandbox, args.file, args.old, args.new, command, args.timeout)
            return run_check(args.sandbox, command, args.timeout)
        finally:
            verify(args.sandbox)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"quality-sweep: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
