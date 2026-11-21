"""Run with: python -B -X utf8 scripts/quality-sweep.test.py."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("quality_sweep", Path(__file__).with_name("quality-sweep.py"))
SWEEP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SWEEP)
TEST_COMMAND = ["pnpm", "exec", "vitest", "run", "tests/sample.test.ts"]


class IsolatedSnapshot(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="kbo-sweep-test-")
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve()
        self.source = self.parent / "source"
        self.source.mkdir()
        self.git("init", "-q", "-b", "main")
        self.write(".gitignore", ".data/\n.backups/\n.env\nnode_modules/\n")
        self.write("packages/sample/src/value.ts", "export const value = 1;\n")
        self.write("tests/sample.test.ts", "// synthetic fixture\n")
        self.git("add", ".")
        self.git("commit", "-qm", "isolated synthetic baseline")

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=review", "-c",
                               "user.email=review@example.invalid", *args], cwd=self.source,
                              capture_output=True, check=True)

    def write(self, name, text):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
        return path

    def prepare(self):
        return SWEEP.prepare(self.source, self.parent)

    def test_snapshot_preserves_dirty_untracked_and_staged_bytes_without_git_writes(self):
        value = self.write("packages/sample/src/value.ts", "export const value = 2;\r\n// 한글\r\n")
        self.git("add", "packages/sample/src/value.ts")
        self.write("packages/sample/src/new.ts", "export const added = true;\n")
        status = self.git("status", "--porcelain=v1", "-z").stdout
        index = (self.source / ".git" / "index").read_bytes()
        sandbox = self.prepare()
        self.assertEqual((sandbox / value.relative_to(self.source)).read_bytes(), value.read_bytes())
        self.assertTrue((sandbox / "packages/sample/src/new.ts").is_file())
        self.assertFalse((sandbox / ".git").exists())
        self.assertEqual(self.git("status", "--porcelain=v1", "-z").stdout, status)
        self.assertEqual((self.source / ".git/index").read_bytes(), index)

    def test_protected_data_is_not_read_even_when_force_tracked(self):
        protected = [".env", ".data/synthetic.json", ".backups/synthetic.txt", "apps/web/.env.local"]
        for name in protected:
            self.write(name, "SYNTHETIC_SECRET")
            self.git("add", "-f", name)
        original = Path.read_bytes

        def read(path):
            if path.is_relative_to(self.source) and path.relative_to(self.source).as_posix() in protected:
                raise AssertionError("Protected content must never be read")
            return original(path)

        with mock.patch.object(Path, "read_bytes", read):
            sandbox = self.prepare()
        self.assertTrue(all(not (sandbox / name).exists() for name in protected))
        self.assertNotIn("SYNTHETIC_SECRET", (sandbox / SWEEP.MARKER).read_text(encoding="utf-8"))

    def test_deleted_tracked_file_stays_deleted(self):
        (self.source / "packages/sample/src/value.ts").unlink()
        self.assertFalse((self.prepare() / "packages/sample/src/value.ts").exists())

    def test_includes_nginx_config_required_by_the_compose_build(self):
        nginx = self.write("infra/nginx.conf", "server { listen 80; }\n")
        self.git("add", "infra/nginx.conf")
        self.assertEqual((self.prepare() / "infra/nginx.conf").read_bytes(), nginx.read_bytes())

    def test_refuses_destination_inside_source(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            SWEEP.prepare(self.source, self.source)

    def test_changed_original_is_reported_and_preserved(self):
        sandbox = self.prepare()
        changed = self.write("packages/sample/src/value.ts", "new user edit\n")
        with self.assertRaisesRegex(ValueError, "Source changed"):
            SWEEP.verify(sandbox)
        self.assertEqual(changed.read_bytes(), b"new user edit\n")

    def test_new_source_file_invalidates_the_snapshot(self):
        sandbox = self.prepare()
        added = self.write("tests/new-regression.test.ts", "// new user test\n")
        with self.assertRaisesRegex(ValueError, "Source changed"):
            SWEEP.verify(sandbox)
        self.assertEqual(added.read_bytes(), b"// new user test\n")

    def test_restored_tracked_file_invalidates_the_snapshot(self):
        name = "packages/sample/src/value.ts"
        (self.source / name).unlink()
        sandbox = self.prepare()
        self.write(name, "// user restored the file\n")
        with self.assertRaisesRegex(ValueError, "Source changed"):
            SWEEP.verify(sandbox)

    def test_snapshot_cannot_be_written_into_user_data(self):
        parent = self.parent / ".backups"
        parent.mkdir()
        with self.assertRaisesRegex(ValueError, "user data"):
            SWEEP.prepare(self.source, parent)
        self.assertEqual(list(parent.iterdir()), [])

    def test_baseline_test_edit_is_preserved_instead_of_being_overwritten(self):
        sandbox = self.prepare()
        target = sandbox / "packages/sample/src/value.ts"

        def executor(root, command, timeout):
            target.write_bytes(b"new snapshot edit\n")
            return 0

        with self.assertRaisesRegex(ValueError, "changed the mutation target"):
            SWEEP.mutate(sandbox, target.relative_to(sandbox).as_posix(), "value = 1", "value = 2",
                         TEST_COMMAND, executor=executor)
        self.assertEqual(target.read_bytes(), b"new snapshot edit\n")

    def test_mutations_restore_utf8_lf_crlf_bytes_on_assertion_and_timeout(self):
        sandbox = self.prepare()
        target = sandbox / "packages/sample/src/value.ts"
        source_bytes = (self.source / "packages/sample/src/value.ts").read_bytes()
        for ending in (b"\n", b"\r\n"):
            original = "// 한글".encode("utf-8") + ending + b"export const value = 1;" + ending
            target.write_bytes(original)
            calls = []

            def executor(root, command, timeout):
                calls.append(target.read_bytes())
                return 0 if len(calls) == 1 else 1

            self.assertEqual(SWEEP.mutate(sandbox, target.relative_to(sandbox).as_posix(),
                                         "value = 1", "value = 2", TEST_COMMAND, executor=executor), 0)
            self.assertIn(b"value = 2", calls[1])
            self.assertEqual(target.read_bytes(), original)
            executor = mock.Mock(side_effect=[0, subprocess.TimeoutExpired(TEST_COMMAND, 1)])
            with self.assertRaises(subprocess.TimeoutExpired):
                SWEEP.mutate(sandbox, target.relative_to(sandbox).as_posix(), "value = 1", "value = 2",
                             TEST_COMMAND, executor=executor)
            self.assertEqual(target.read_bytes(), original)
        self.assertEqual((self.source / "packages/sample/src/value.ts").read_bytes(), source_bytes)

    def test_missed_mutation_fails_and_broken_baseline_is_not_caught(self):
        sandbox = self.prepare()
        name = "packages/sample/src/value.ts"
        self.assertEqual(SWEEP.mutate(sandbox, name, "value = 1", "value = 2", TEST_COMMAND,
                                     executor=mock.Mock(return_value=0)), 1)
        with self.assertRaisesRegex(ValueError, "Unmodified test failed"):
            SWEEP.mutate(sandbox, name, "value = 1", "value = 2", TEST_COMMAND,
                         executor=mock.Mock(return_value=1))
        self.assertIn(b"value = 1", (sandbox / name).read_bytes())

    def test_rejects_path_escape_and_symlink(self):
        sandbox = self.prepare()
        for name in ("../outside.ts", "packages/../../outside.ts", ".data/file.ts", "C:/outside.ts"):
            with self.assertRaises(ValueError):
                SWEEP.regular_file(sandbox, name)
        link = sandbox / "packages/sample/src/link.ts"
        try:
            link.symlink_to(self.source / "packages/sample/src/value.ts")
        except OSError:
            return  # Symlink creation needs an additional Windows privilege on some hosts.
        with self.assertRaisesRegex(ValueError, "Links"):
            SWEEP.regular_file(sandbox, "packages/sample/src/link.ts")

    def test_source_checkout_cannot_be_a_mutation_sandbox(self):
        with self.assertRaisesRegex(ValueError, "Not a quality-sweep snapshot"):
            SWEEP.mutate(self.source, "packages/sample/src/value.ts", "value = 1", "value = 2",
                         TEST_COMMAND, executor=mock.Mock())


class CommandBoundary(unittest.TestCase):
    def test_operational_commands_shells_and_overrides_are_refused(self):
        commands = [["pnpm", "workspace:migrate"], ["pnpm", "maintenance:rebuild-derived"],
                    ["pnpm", "test:e2e"], ["pnpm", "test:integration"],
                    ["docker", "compose", "down", "-v"], ["make", "deploy"],
                    ["node", "apps/server/dist/migrate.js"], ["powershell", "scripts/restore.ps1"],
                    ["pnpm", "test", "--", "--config=outside.ts"],
                    ["pnpm", "exec", "vitest", "run", "tests/x&whoami.test.ts"],
                    ["pnpm", "exec", "vitest", "run", "tests/%TOKEN%.test.ts"],
                    [*TEST_COMMAND, "&&", "docker", "compose", "down", "-v"]]
        for command in commands:
            with self.subTest(command=command), self.assertRaises(ValueError):
                SWEEP.validate_command(command)

    def test_only_explicit_test_paths_are_allowed_for_mutations(self):
        SWEEP.validate_command(TEST_COMMAND, mutation=True)
        for command in (["pnpm", "test"], ["pnpm", "exec", "vitest", "run", "--watch"],
                        ["pnpm", "exec", "vitest", "run", "../outside.test.ts"]):
            with self.assertRaises(ValueError):
                SWEEP.validate_command(command, mutation=True)

    def test_database_workspace_and_node_injection_environment_is_not_inherited(self):
        with mock.patch.dict(os.environ, {"KBO_DATA_DIR": "synthetic-user-data", "PGHOST": "production",
                                          "KBO_TEST_POSTGRES_DSN": "synthetic-db", "DATABASE_URL": "db",
                                          "NODE_OPTIONS": "--require=unsafe.js", "COMPOSE_PROJECT_NAME": "live"}):
            env = SWEEP.check_environment()
        for key in ("KBO_DATA_DIR", "PGHOST", "KBO_TEST_POSTGRES_DSN", "DATABASE_URL", "NODE_OPTIONS",
                    "COMPOSE_PROJECT_NAME"):
            self.assertNotIn(key, env)
        self.assertEqual(env["COREPACK_ENABLE_NETWORK"], "0")


if __name__ == "__main__":
    unittest.main()
