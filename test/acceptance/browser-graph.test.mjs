import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import ts from 'typescript';

// PLAN M6 / CONTRACT: a browser consumer must never reach Node-only runtime code.
test('entire public root dependency graph has only browser-safe module imports', async () => {
  const visited = new Set();
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  async function visit(url) {
    if (visited.has(url)) return;
    visited.add(url);
    const source = await readFile(new URL(url), 'utf8');
    const tree = ts.createSourceFile(url, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = [];
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imports.push(node.moduleSpecifier);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        assert.equal(node.arguments.length, 1, `uninspectable import in ${url}`);
        imports.push(node.arguments[0]);
      }
      ts.forEachChild(node, scan);
    }
    scan(tree);
    for (const specifier of imports) {
      assert.ok(ts.isStringLiteralLike(specifier), `dynamic module name in ${url} prevents browser-safety verification`);
      const name = specifier.text;
      assert.ok(!name.startsWith('node:') && !builtins.has(name), `Node dependency ${name} reachable from ${url}`);
      assert.ok(name.startsWith('./') || name.startsWith('../'), `unexpected external runtime dependency ${name} in ${url}`);
      await visit(new URL(name, url).href);
    }
  }
  await visit(import.meta.resolve('soft-if'));
  assert.ok(visited.size > 1, 'must inspect transitive modules as well as the root');
});
