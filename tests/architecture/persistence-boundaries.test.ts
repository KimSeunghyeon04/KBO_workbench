import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

async function runtimeDependencies(entry: string): Promise<ReadonlySet<string>> {
  const visited = new Set<string>();
  const dependencies = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    // Inspect emitted imports: `import { type T }` can still load a module under verbatimModuleSyntax.
    const { outputText } = ts.transpileModule(await readFile(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    const source = ts.createSourceFile(file, outputText, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function visit(node: ts.Node): void {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) {
        dependencies.add(specifier);
        continue;
      }
      const base = path
        .relative(process.cwd(), path.resolve(path.dirname(file), specifier))
        .replaceAll(path.sep, "/")
        .replace(/\.jsx?$/, "");
      const target = [base, `${base}.ts`, `${base}.tsx`].find((candidate) =>
        ts.sys.fileExists(candidate),
      );
      if (target === undefined) throw new Error(`Cannot resolve ${specifier} from ${file}`);
      dependencies.add(target);
      pending.push(target);
    }
  }
  return dependencies;
}

describe("persistence and session responsibility boundaries", () => {
  it.each(["jobs", "sources", "cases"])(
    "record correction %s는 공개 repository를 역참조하지 않는다",
    async (part) => {
      const dependencies = await runtimeDependencies(
        `packages/persistence/src/record-correction-${part}.ts`,
      );
      expect(dependencies.has("packages/persistence/src/record-correction-repository.ts")).toBe(
        false,
      );
      for (const upper of part === "jobs"
        ? ["sources", "cases"]
        : part === "sources"
          ? ["cases"]
          : []) {
        expect(dependencies.has(`packages/persistence/src/record-correction-${upper}.ts`)).toBe(
          false,
        );
      }
    },
  );

  it("replay route는 동기 compiler를 로드하지 않고 이벤트 입력 UI는 drawer를 역참조하지 않는다", async () => {
    const replay = await runtimeDependencies("apps/server/src/routes/replay.ts");
    expect(replay.has("@kbo/game-core")).toBe(false);
    const fields = await runtimeDependencies("apps/web/src/correction/event-fields.tsx");
    expect(fields.has("apps/web/src/correction/correction-drawer.tsx")).toBe(false);
  });

  it.each([
    "packages/persistence/src/projection-replay.ts",
    "packages/persistence/src/projection-ledger.ts",
  ])("%s는 compiler와 DB adapter를 실행하지 않는다", async (entry) => {
    const dependencies = await runtimeDependencies(entry);
    for (const forbidden of ["@kbo/game-core", "pg", "node:fs", "node:fs/promises"]) {
      expect(dependencies.has(forbidden), `${entry} -> ${forbidden}`).toBe(false);
    }
    expect(dependencies.has("packages/persistence/src/revision-store.ts")).toBe(false);
    if (entry.endsWith("projection-replay.ts")) {
      expect(dependencies.has("packages/persistence/src/projection-ledger.ts")).toBe(false);
    }
  });

  it("current 전환과 세션 저장소는 상위 조정 모듈을 역참조하지 않는다", async () => {
    const current = await runtimeDependencies(
      "packages/persistence/src/workspace-current-store.ts",
    );
    expect(current.has("packages/persistence/src/staging-workspace.ts")).toBe(false);
    const sessions = await runtimeDependencies("apps/server/src/correction-session-store.ts");
    for (const forbidden of [
      "apps/server/src/correction-session-manager.ts",
      "apps/server/src/computation.ts",
      "@kbo/persistence",
      "@kbo/game-core",
    ]) {
      expect(sessions.has(forbidden), forbidden).toBe(false);
    }
  });
});
