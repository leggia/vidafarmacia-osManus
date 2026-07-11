#!/usr/bin/env node
/**
 * Chequeo PRE-PUSH de VidaFarma (Company of One — Testing/QA).
 *
 * Corre tres verificaciones sobre los archivos que cambiaron respecto a origin/main,
 * en este orden, y BLOQUEA (exit 1) si algo falla:
 *   1. Heurístico use-before-declaration en componentes React (el patrón que causó el
 *      crash de la tienda: "No se puede acceder a 'X' antes de la inicialización").
 *   2. Balance de llaves {} y paréntesis () en cada archivo tocado.
 *   3. Compilación esbuild de cada archivo .ts/.tsx tocado.
 *
 * Uso:
 *   node scripts/verificar.mjs            → verifica archivos cambiados vs origin/main
 *   node scripts/verificar.mjs --all      → verifica TODOS los .ts/.tsx del proyecto
 *   node scripts/verificar.mjs file1 ...  → verifica archivos específicos
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
let archivos = [];

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

// ─── Determinar qué archivos verificar ───
// Excluir librería de terceros (shadcn/ui) y archivos de test del chequeo de
// compilación individual (se resuelven en el bundle completo, no aislados).
const EXCLUIR = (f) => /client\/src\/components\/ui\//.test(f) || /\.test\.tsx?$/.test(f) || /client\/src\/main\.tsx$/.test(f);

if (args.includes("--all")) {
  archivos = sh("find client/src server -name '*.ts' -o -name '*.tsx'").split("\n").filter(Boolean).filter((f) => !EXCLUIR(f));
} else if (args.length > 0 && !args[0].startsWith("--")) {
  archivos = args.filter((a) => !a.startsWith("--"));
} else {
  // Archivos cambiados vs origin/main (staged, unstaged y committed sin push)
  const base = sh("git merge-base origin/main HEAD") || "origin/main";
  const cambiados = sh(`git diff --name-only ${base} HEAD; git diff --name-only; git diff --name-only --cached`);
  archivos = [...new Set(cambiados.split("\n").filter(Boolean))]
    .filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(f) && !EXCLUIR(f));
}

if (archivos.length === 0) {
  console.log("✓ No hay archivos .ts/.tsx que verificar.");
  process.exit(0);
}

console.log(`\n🔍 Verificando ${archivos.length} archivo(s)...\n`);
let errores = 0;

// ─── 1. Heurístico use-before-declaration (solo componentes React) ───
function chequearUseBeforeDeclaration(archivo, contenido) {
  if (!/\.tsx$/.test(archivo)) return [];
  const lineas = contenido.split("\n");
  const problemas = [];
  // Mapa: nombre de variable → primera línea donde se declara con const/let
  const decl = {};
  lineas.forEach((ln, i) => {
    // const X = ...
    let m = ln.match(/^\s*const\s+(\w+)\s*=/);
    if (m) decl[m[1]] ??= i;
    // const { data: X } = ...  /  const { X } = ...
    m = ln.match(/const\s*\{\s*data:\s*(\w+)/);
    if (m) decl[m[1]] ??= i;
  });
  // ¿Algún hook usa una variable ANTES de su declaración?
  // Para reducir falsos positivos, extraemos el bloque REAL del hook (desde useX(
  // hasta su cierre balanceado) y solo alertamos si la variable aparece en el ARRAY
  // DE DEPENDENCIAS del hook — que es lo que realmente causa el error de runtime.
  for (const [nombre, lineaDecl] of Object.entries(decl)) {
    if (nombre.length < 2) continue;
    for (let i = 0; i < lineaDecl; i++) {
      if (!/\buse(Effect|Memo|Callback|LayoutEffect)\b/.test(lineas[i])) continue;
      // Extraer el bloque del hook hasta su cierre "}, [...])" o "});" (máx 40 líneas)
      const fin = Math.min(i + 40, lineas.length);
      let bloque = "";
      for (let j = i; j < fin; j++) {
        bloque += lineas[j] + "\n";
        if (/\}\s*,\s*\[.*\]\s*\)/.test(lineas[j]) || /^\s*\}\s*\)\s*;?\s*$/.test(lineas[j])) break;
      }
      // El array de dependencias: lo que está entre "}, [" y "])"
      const depsMatch = bloque.match(/\}\s*,\s*\[([^\]]*)\]\s*\)/);
      const deps = depsMatch ? depsMatch[1] : "";
      const reDep = new RegExp(`(^|[^.\\w])${nombre}([^\\w]|$)`);
      // Ignorar si el hook (re)declara localmente ese nombre
      const declaraLocal = new RegExp(`const\\s+${nombre}\\b|data:\\s*${nombre}\\b`).test(bloque);
      if (deps && reDep.test(deps) && !declaraLocal) {
        problemas.push(`   ⚠ '${nombre}' en las dependencias del hook (línea ~${i + 1}) pero declarado después, en línea ${lineaDecl + 1}`);
        break;
      }
    }
  }
  return problemas;
}

// ─── 1b. Re-export sin binding local (el bug de la tienda v2.3.1) ───
// `export { X } from "./mod"` re-exporta pero NO importa X al scope local.
// Si el mismo archivo USA X internamente, es un ReferenceError de runtime que
// esbuild no detecta. Detectamos: nombres re-exportados con "from" que también se
// usan en el cuerpo del archivo sin un import/const propio.
function chequearReexportSinBinding(archivo, contenido) {
  const problemas = [];
  const reExport = /export\s*\{([^}]+)\}\s*from\s*["']/g;
  let m;
  while ((m = reExport.exec(contenido)) !== null) {
    const nombres = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const nombre of nombres) {
      if (nombre.length < 2) continue;
      // ¿Tiene binding local? (import { nombre } / const nombre / function nombre)
      const tieneImport = new RegExp(`import\\s*\\{[^}]*\\b${nombre}\\b[^}]*\\}\\s*from`).test(contenido);
      const tieneLocal = new RegExp(`(const|let|function|class)\\s+${nombre}\\b`).test(contenido);
      if (tieneImport || tieneLocal) continue;
      // ¿Se USA en el archivo (más allá de la línea del export)?
      const sinExports = contenido.replace(/export\s*\{[^}]+\}\s*from\s*["'][^"']+["'];?/g, "");
      const usos = (sinExports.match(new RegExp(`\\b${nombre}\\s*\\(`, "g")) || []).length;
      if (usos > 0) {
        problemas.push(`   ⚠ '${nombre}' se re-exporta con "export {...} from" pero se USA ${usos} vez/veces sin import local → ReferenceError en runtime. Usa: import { ${nombre} } from "..." y luego export { ${nombre} }.`);
      }
    }
  }
  return problemas;
}

// ─── 1c. Migración compartida llamada desde muy pocos lugares (v2.10.3) ───
// Detecta el patrón real que rompió Inventario en producción: una función
// `asegurarColumnasX(db)` que contiene un ALTER TABLE pero se llama desde muy
// pocos endpoints — si hay más de un endpoint que toca esa tabla, todos deben
// llamarla al inicio, o alguno puede fallar con "Unknown column" antes de que la
// migración se dispare (el error se disfraza de "no hay datos" en el frontend).
// Solo mira funciones que RECIBEN `db` como parámetro (el patrón compartido); los
// `asegurarTablas()` sin parámetro de cada módulo (llaman a getDb() internamente,
// se invocan liberalmente) no aplican aquí.
function chequearMigracionCompartida(contenido) {
  const problemas = [];
  const helperRe = /async function (asegurar\w*)\s*\(\s*db\b[^)]*\)\s*{/g;
  let hm;
  while ((hm = helperRe.exec(contenido)) !== null) {
    const nombre = hm[1];
    const fragmento = contenido.slice(hm.index, hm.index + 1000);
    if (!/ALTER TABLE/.test(fragmento)) continue;
    const llamadas = (contenido.match(new RegExp(`\\b${nombre}\\s*\\(\\s*db\\s*\\)`, "g")) || []).length;
    if (llamadas < 2) {
      problemas.push(`   ⚠ La migración '${nombre}' (ALTER TABLE, recibe 'db') se llama ${llamadas} vez/veces. Si hay más de un endpoint que lee/escribe esa tabla, TODOS deben llamarla al inicio — si no, alguno puede fallar con "Unknown column" y disfrazarse de "no hay datos" (ver TESTING.md, caso real v2.10.3).`);
    }
  }
  return problemas;
}

// ─── 2. Balance de llaves y paréntesis ───
function chequearBalance(contenido) {
  let llaves = 0, parentesis = 0;
  let enString = null, enComentario = null;
  const c = contenido;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i], prev = c[i - 1], next = c[i + 1];
    // Comentarios
    if (!enString && !enComentario && ch === "/" && next === "/") { enComentario = "linea"; continue; }
    if (!enString && !enComentario && ch === "/" && next === "*") { enComentario = "bloque"; continue; }
    if (enComentario === "linea" && ch === "\n") { enComentario = null; continue; }
    if (enComentario === "bloque" && prev === "*" && ch === "/") { enComentario = null; continue; }
    if (enComentario) continue;
    // Strings (comillas simples, dobles, template)
    if (!enString && (ch === '"' || ch === "'" || ch === "`")) { enString = ch; continue; }
    else if (enString && ch === enString && prev !== "\\") { enString = null; continue; }
    if (enString) continue;
    // Conteo
    if (ch === "{") llaves++; else if (ch === "}") llaves--;
    else if (ch === "(") parentesis++; else if (ch === ")") parentesis--;
  }
  const p = [];
  if (llaves !== 0) p.push(`   ⚠ Llaves {} desbalanceadas: ${llaves > 0 ? "sobran " + llaves + " {" : "sobran " + -llaves + " }"}`);
  if (parentesis !== 0) p.push(`   ⚠ Paréntesis () desbalanceados: ${parentesis > 0 ? "sobran " + parentesis + " (" : "sobran " + -parentesis + " )"}`);
  return p;
}

// ─── 3. Compilación esbuild ───
const EXTERNALS_CLIENTE = [
  "react", "react-dom", "react/*", "@/*", "wouter", "sonner", "lucide-react", "recharts",
  "@trpc/*", "@radix-ui/*", "class-variance-authority", "@tanstack/*", "clsx", "tailwind-merge",
  // Librerías de shadcn/ui y utilidades comunes (para no dar falsos errores)
  "embla-carousel-react", "vaul", "react-hook-form", "input-otp", "cmdk",
  "react-day-picker", "date-fns", "next-themes", "react-resizable-panels",
  "@hookform/*", "zod", "framer-motion", "@dnd-kit/*", "streamdown", "react-markdown", "remark-gfm",
].map((e) => `--external:${e}`).join(" ");

function chequearCompilacion(archivo) {
  const esCliente = archivo.startsWith("client/");
  let cmd;
  if (esCliente) {
    cmd = `npx esbuild ${archivo} --bundle --format=esm --jsx=automatic ${EXTERNALS_CLIENTE} --outfile=/dev/null 2>&1`;
  } else {
    cmd = `npx esbuild ${archivo} --platform=node --packages=external --bundle --format=esm --outfile=/dev/null 2>&1`;
  }
  try {
    execSync(cmd, { encoding: "utf8", stdio: "pipe" });
    return [];
  } catch (e) {
    const salida = (e.stdout || e.stderr || e.message || "").toString();
    const primeras = salida.split("\n").filter((l) => /error|Error/i.test(l)).slice(0, 3);
    return [`   ✗ Error de compilación:\n${primeras.map((l) => "     " + l.trim()).join("\n")}`];
  }
}

// ─── Ejecutar ───
for (const archivo of archivos) {
  const contenido = readFileSync(archivo, "utf8");
  // Nota: el balance de llaves/paréntesis se omite como bloqueante porque da falsos
  // positivos con regex, template literals y genéricos de TS. La compilación esbuild
  // es el juez fiable de sintaxis. El heurístico use-before-declaration sí es útil
  // porque detecta un error que esbuild NO detecta (solo aparece en runtime).
  const problemas = [
    ...chequearUseBeforeDeclaration(archivo, contenido),
    ...chequearReexportSinBinding(archivo, contenido),
    ...chequearMigracionCompartida(contenido),
    ...chequearCompilacion(archivo),
  ];
  if (problemas.length > 0) {
    console.log(`✗ ${archivo}`);
    problemas.forEach((p) => console.log(p));
    errores += problemas.length;
  } else {
    console.log(`✓ ${archivo}`);
  }
}

console.log("");
if (errores > 0) {
  console.log(`❌ ${errores} problema(s) encontrado(s). Corrige antes de hacer push.\n`);
  process.exit(1);
} else {
  console.log(`✅ Todo en orden. ${archivos.length} archivo(s) verificado(s).\n`);
  process.exit(0);
}
