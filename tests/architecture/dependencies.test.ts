import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(process.cwd(), "packages");
const applicationRoots = [
  packageRoot,
  path.resolve(process.cwd(), "apps"),
  path.resolve(process.cwd(), "tests"),
];

const allowedInternalDependencies = new Map<string, ReadonlySet<string>>([
  ["contracts", new Set()],
  ["game-core", new Set(["contracts"])],
  ["collection", new Set(["contracts", "game-core"])],
  ["correction", new Set(["contracts", "game-core"])],
  ["persistence", new Set(["contracts", "game-core"])],
  ["replay", new Set(["contracts", "game-core"])],
  ["test-fixtures", new Set()],
]);

const forbiddenImports = new Map<string, ReadonlySet<string>>([
  [
    "contracts",
    new Set(["fastify", "pg", "playwright", "react", "react-dom", "node:fs", "node:http"]),
  ],
  [
    "game-core",
    new Set([
      "@kbo/collection",
      "@kbo/correction",
      "@kbo/persistence",
      "@kbo/replay",
      "fastify",
      "pg",
      "playwright",
      "react",
      "node:fs",
      "node:http",
    ]),
  ],
  ["collection", new Set(["@kbo/persistence", "pg", "react"])],
  ["correction", new Set(["@kbo/collection", "@kbo/persistence", "pg", "playwright", "react"])],
  ["replay", new Set(["@kbo/persistence", "pg", "playwright", "react"])],
]);

async function sourceFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await sourceFiles(absolute)));
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) {
      results.push(absolute);
    }
  }
  return results.sort();
}

async function importedModules(file: string): Promise<readonly string[]> {
  const contents = await readFile(file, "utf8");
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const modules: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const dynamicImportArgument = node.arguments[0];
      if (dynamicImportArgument !== undefined && ts.isStringLiteral(dynamicImportArgument)) {
        modules.push(dynamicImportArgument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return modules;
}

async function allSourceFiles(): Promise<readonly string[]> {
  const nested = await Promise.all(
    applicationRoots.map(async (root) => {
      try {
        return await sourceFiles(root);
      } catch {
        return [];
      }
    }),
  );
  return nested.flat();
}

function internalPackageName(moduleName: string): string | null {
  if (!moduleName.startsWith("@kbo/")) {
    return null;
  }
  return moduleName.split("/")[1] ?? null;
}

function matchesForbidden(moduleName: string, forbidden: ReadonlySet<string>): boolean {
  return [...forbidden].some(
    (prefix) => moduleName === prefix || moduleName.startsWith(`${prefix}/`),
  );
}

describe("package dependency architecture", () => {
  for (const [packageName, allowed] of allowedInternalDependencies) {
    it(`${packageName} package가 허용된 내부 경계만 참조한다`, async () => {
      const files = await sourceFiles(path.join(packageRoot, packageName, "src"));
      const violations: string[] = [];
      for (const file of files) {
        for (const moduleName of await importedModules(file)) {
          const target = internalPackageName(moduleName);
          if (target !== null && target !== packageName && !allowed.has(target)) {
            violations.push(`${path.relative(packageRoot, file)} -> ${moduleName}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }

  for (const [packageName, forbidden] of forbiddenImports) {
    it(`${packageName} package가 외부 adapter를 import하지 않는다`, async () => {
      const files = await sourceFiles(path.join(packageRoot, packageName, "src"));
      const violations: string[] = [];
      for (const file of files) {
        for (const moduleName of await importedModules(file)) {
          if (matchesForbidden(moduleName, forbidden)) {
            violations.push(`${path.relative(packageRoot, file)} -> ${moduleName}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  }

  it("다른 패키지의 내부 경로를 deep import하지 않는다", async () => {
    const violations: string[] = [];
    for (const file of await allSourceFiles()) {
      for (const moduleName of await importedModules(file)) {
        if (/^@kbo\/[^/]+\//u.test(moduleName)) {
          violations.push(`${path.relative(process.cwd(), file)} -> ${moduleName}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("source와 test가 설치 디렉터리의 물리 경로를 import하지 않는다", async () => {
    const violations: string[] = [];
    for (const file of await allSourceFiles()) {
      for (const moduleName of await importedModules(file)) {
        if (/(^|[/\\])node_modules([/\\]|$)/u.test(moduleName)) {
          violations.push(`${path.relative(process.cwd(), file)} -> ${moduleName}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("공개 package barrel은 명시적인 export만 사용한다", async () => {
    const violations: string[] = [];
    for (const packageName of allowedInternalDependencies.keys()) {
      const indexFile = path.join(packageRoot, packageName, "src", "index.ts");
      let contents: string;
      try {
        contents = await readFile(indexFile, "utf8");
      } catch {
        continue;
      }
      if (/^export\s+\*/mu.test(contents)) {
        violations.push(path.relative(packageRoot, indexFile));
      }
    }
    expect(violations).toEqual([]);
  });

  it("game-core는 provider 이름과 한국어 lexical 정규식을 포함하지 않는다", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.join(packageRoot, "game-core", "src"))) {
      const contents = await readFile(file, "utf8");
      if (/naver/iu.test(contents)) {
        violations.push(`${path.relative(packageRoot, file)} -> provider name`);
      }
      const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isRegularExpressionLiteral(node) && /[가-힣]/u.test(node.text)) {
          violations.push(`${path.relative(packageRoot, file)} -> ${node.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it("production collection 코드는 특정 경기 ID나 fixture 위치로 분기하지 않는다", async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(path.join(packageRoot, "collection", "src"))) {
      const contents = await readFile(file, "utf8");
      if (/20\d{6}[A-Z]{4}\d{5}/u.test(contents) || /fixtures?[\\/]/iu.test(contents)) {
        violations.push(path.relative(packageRoot, file));
      }
    }
    expect(violations).toEqual([]);
  });
});
