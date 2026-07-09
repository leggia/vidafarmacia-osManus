// SMOKE TESTS de seguridad y lógica crítica de VidaFarma (ver TESTING.md).
// Solo importa módulos PUROS (server/domain/* y el diccionario), por lo que corre
// en cualquier entorno con: npm run smoke  (compila con esbuild y ejecuta con node).
// También existen los tests de vitest en server/domain/*.test.ts para la PC/CI.
import assert from "node:assert";
import { esControlado } from "../domain/controlados";
import { normTel } from "../domain/telefono";
import { expandirBusqueda, principioDeMarca } from "../diccionario-principios";
import { calcularDescuentosCascada } from "../domain/descuentos";

let pasan = 0, fallan = 0;
function test(nombre: string, fn: () => void) {
  try { fn(); pasan++; console.log(`  ✓ ${nombre}`); }
  catch (e: any) { fallan++; console.log(`  ✗ ${nombre}\n     ${e?.message}`); }
}

console.log("\n🧪 SMOKE TESTS — seguridad y lógica crítica\n");

// ─── 1. CONTROLADOS: nunca deben pasar el filtro de la tienda ───
console.log("Filtro de medicamentos controlados:");
test("detecta controlado por nombre directo (tramadol)", () => {
  assert.equal(esControlado("Tramadol 50mg x10"), true);
});
test("detecta controlado por nombre con mayúsculas y tilde (codeína)", () => {
  assert.equal(esControlado("Jarabe con CODEÍNA"), true);
});
test("detecta controlado en la DESCRIPCIÓN (principio activo)", () => {
  assert.equal(esControlado("Dolotram Forte", "Laboratorio X | Tramadol clorhidrato 100mg"), true);
});
test("detecta benzodiacepina (clonazepam) y precursor (pseudoefedrina)", () => {
  assert.equal(esControlado("Clonazepam 2mg"), true);
  assert.equal(esControlado("Antigripal", "Lab | Pseudoefedrina + paracetamol"), true);
});
test("NO bloquea venta libre (paracetamol, ibuprofeno, vitaminas)", () => {
  assert.equal(esControlado("Paracetamol 500mg"), false);
  assert.equal(esControlado("Advil 400", "Pfizer | Ibuprofeno 400mg"), false);
  assert.equal(esControlado("Vitamina C Redoxon"), false);
});

// ─── 2. DICCIONARIO: búsqueda por principio activo ───
console.log("\nDiccionario marca ↔ principio activo:");
test("buscar 'ibuprofeno' expande a sus marcas (advil)", () => {
  const ex = expandirBusqueda("ibuprofeno");
  assert.ok(ex.includes("advil"), `esperaba 'advil' en [${ex.join(", ")}]`);
});
test("buscar una marca (panadol) expande al principio (paracetamol)", () => {
  const ex = expandirBusqueda("panadol");
  assert.ok(ex.includes("paracetamol"), `esperaba 'paracetamol' en [${ex.join(", ")}]`);
});
test("principioDeMarca reconoce la marca dentro del nombre completo", () => {
  assert.equal(principioDeMarca("ADVIL Max 400mg x24"), "ibuprofeno");
});
test("principioDeMarca devuelve null para nombres desconocidos", () => {
  assert.equal(principioDeMarca("Producto Inventado XYZ"), null);
});

// ─── 3. TELÉFONO: la llave de identidad de los puntos ───
console.log("\nNormalización de teléfono (llave de puntos):");
test("mismos últimos 8 dígitos con formatos distintos → misma llave", () => {
  assert.equal(normTel("+591 70012345"), "70012345");
  assert.equal(normTel("700-12345"), "70012345");
  assert.equal(normTel("70012345"), "70012345");
  assert.equal(normTel("(591) 7 001 2345"), "70012345");
});
test("teléfonos inválidos (cortos/vacíos) → null (no crean cuenta basura)", () => {
  assert.equal(normTel("123"), null);
  assert.equal(normTel(""), null);
  assert.equal(normTel(null), null);
});

// ─── 4. DESCUENTOS: la matemática del dinero ───
console.log("\nDescuentos en cascada (compras):");
test("cascada volumen 2% + efectivo 3% sobre 2000 = 1901.20", () => {
  const lineas = Array.from({ length: 10 }, () => ({ precioLista: 200, cantidad: 1 }));
  const r = calcularDescuentosCascada(lineas, { pctVolumen: 2, pctEfectivo: 3 });
  assert.equal(r.subtotal, 2000);
  assert.equal(r.totalFinal, 1901.2);
});

// ─── Resultado ───
console.log(`\n${fallan === 0 ? "✅" : "❌"} ${pasan} pasan, ${fallan} fallan\n`);
process.exit(fallan === 0 ? 0 : 1);
