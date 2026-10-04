import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Evaluate selected real production functions without loading DB/Shopify modules.
// New external dependencies fail at runtime instead of being silently mocked.
export function loadPureFunctions(file, names, bindings = {}) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const nodes = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
  if (nodes.length !== names.length) throw new Error(`Missing selected function in ${file}`);
  const code = nodes.map(n => n.getText(ast).replace(/^export\s+/, '')).join('\n');
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ ...bindings });
  vm.runInContext(compiled, context, { timeout: 1000 });
  return Object.fromEntries(names.map(name => [name, context[name]]));
}
