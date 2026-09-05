import path from "node:path";
import { createRequire } from "node:module";
import treeSitter from "@vscode/tree-sitter-wasm";

export const REPOSITORY_CONTEXT_EXTRACTOR_VERSION = "tree-sitter-wasm-0.3.1-v2";
const wasmRoot = path.dirname(createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm"));
const languages = new Map();
let initialized;

export function repositoryContextLanguage(filePath) {
  return ({ ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
    ".py": "python", ".php": "php" })[path.posix.extname(filePath).toLowerCase()] || "unsupported";
}

// These validators constrain metadata, never parse source syntax.
export function safeContextIdentifier(value) {
  return typeof value === "string" && value.length <= 160 && /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(value);
}

export function safeContextSpecifier(value) {
  if (typeof value !== "string" || value.length > 240 || value.includes("..") && !/^\.+\//.test(value) && !/^\.+[A-Za-z_]/.test(value)) return false;
  return /^(?:node:[a-z_]+(?:\/[a-z_]+)?|@[-\w]+\/[-\w./]+|(?:\.{1,2}\/)*[-\w]+(?:[./\\][-\w]+)*|\.+(?:[A-Za-z_]\w*(?:\.\w+)*)?)$/.test(value);
}

function staticString(node) {
  if (!node || !["string", "encapsed_string"].includes(node.type)) return "";
  const text = node.text;
  if (text.length < 2 || !["'", '"'].includes(text[0]) || text.at(-1) !== text[0]) return "";
  const value = text.slice(1, -1);
  return safeContextSpecifier(value) ? value : "";
}

async function grammar(language) {
  initialized ||= treeSitter.Parser.init().catch((error) => { initialized = undefined; throw error; });
  await initialized;
  if (!languages.has(language)) {
    const loading = treeSitter.Language.load(path.join(wasmRoot, `tree-sitter-${language}.wasm`)).catch((error) => {
      if (languages.get(language) === loading) languages.delete(language);
      throw error;
    });
    languages.set(language, loading);
  }
  return languages.get(language);
}

const DECLARATIONS = new Map([
  ["function_declaration", "function"], ["generator_function_declaration", "function"], ["function_definition", "function"],
  ["class_declaration", "class"], ["class_definition", "class"], ["interface_declaration", "interface"],
  ["type_alias_declaration", "type"], ["enum_declaration", "enum"], ["trait_declaration", "trait"],
  ["method_definition", "method"], ["method_declaration", "method"], ["variable_declarator", "variable"],
]);

/** Parse in WASM; retain identifiers and static import hints, never snippets or literals. */
export async function extractRepositoryContext(source, language, limits = {}) {
  const symbols = [], imports = [], diagnostics = [];
  if (language === "unsupported") return { symbols, imports, diagnostics: ["unsupported_language"] };
  let parser;
  let tree;
  const maxSymbols = limits.maxSymbolsPerFile || 1000;
  const maxImports = limits.maxImportsPerFile || 1000;
  const seenSymbols = new Set(), seenImports = new Set();
  function addImport(node, specifier = "") {
    const item = { ...(safeContextSpecifier(specifier) ? { specifier } : {}), line: node.startPosition.row + 1, resolved: false };
    const key = JSON.stringify(item);
    if (!seenImports.has(key) && imports.length < maxImports) { seenImports.add(key); imports.push(item); }
    else if (imports.length >= maxImports) diagnostics.push("import_limit");
  }
  try {
    const loadedLanguage = await grammar(language);
    parser = new treeSitter.Parser();
    parser.setLanguage(loadedLanguage);
    parser.setTimeoutMicros((limits.parseTimeoutMs || 100) * 1000);
    tree = parser.parse(source);
    if (!tree) return { symbols, imports, diagnostics: ["parse_timeout"] };
    if (tree.rootNode.hasError) diagnostics.push("parse_error");
    const pending = [tree.rootNode];
    let visited = 0;
    const deadline = Date.now() + (limits.parseTimeoutMs || 100);
    while (pending.length) {
      if (++visited > 100000 || Date.now() > deadline) { diagnostics.push("extraction_limit"); break; }
      const node = pending.pop();
      const kind = DECLARATIONS.get(node.type);
      const name = node.childForFieldName("name");
      if (kind && name && safeContextIdentifier(name.text)) {
        const item = { name: name.text, kind, line: name.startPosition.row + 1 };
        const key = JSON.stringify(item);
        if (!seenSymbols.has(key) && symbols.length < maxSymbols) { seenSymbols.add(key); symbols.push(item); }
        else if (symbols.length >= maxSymbols) diagnostics.push("symbol_limit");
      }
      if (["javascript", "typescript", "tsx"].includes(language)) {
        if (["import_statement", "export_statement"].includes(node.type) && node.childForFieldName("source")) {
          addImport(node, staticString(node.childForFieldName("source")));
        } else if (node.type === "call_expression") {
          const fn = node.childForFieldName("function");
          if (fn?.type === "import" || (fn?.type === "identifier" && fn.text === "require")) {
            const args = node.childForFieldName("arguments");
            addImport(node, args?.namedChildCount === 1 ? staticString(args.firstNamedChild) : "");
          }
        }
      } else if (language === "python") {
        if (node.type === "import_from_statement") addImport(node, node.childForFieldName("module_name")?.text || "");
        if (node.type === "import_statement") {
          for (const child of node.namedChildren) addImport(node, child.type === "aliased_import" ? child.childForFieldName("name")?.text : child.text);
        }
      } else if (language === "php") {
        if (["require_expression", "require_once_expression", "include_expression", "include_once_expression"].includes(node.type)) addImport(node, staticString(node.firstNamedChild));
        if (node.type === "namespace_use_clause") {
          const qualified = node.namedChildren.find((child) => ["qualified_name", "name"].includes(child.type));
          addImport(node, qualified?.text || "");
        }
      }
      for (let i = node.namedChildCount - 1; i >= 0; i--) pending.push(node.namedChild(i));
    }
    return { symbols, imports, diagnostics: [...new Set(diagnostics)] };
  } catch {
    return { symbols: [], imports: [], diagnostics: ["parser_unavailable"] };
  } finally {
    tree?.delete();
    parser?.delete();
  }
}
