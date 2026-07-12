// SMOKE TESTS de seguridad y lógica crítica de VidaFarma (ver TESTING.md).
// Solo importa módulos PUROS (server/domain/* y el diccionario), por lo que corre
// en cualquier entorno con: npm run smoke  (compila con esbuild y ejecuta con node).
// También existen los tests de vitest en server/domain/*.test.ts para la PC/CI.
import assert from "node:assert";
import { esControlado } from "../domain/controlados";
import { normTel } from "../domain/telefono";
import { expandirBusqueda, principioDeMarca } from "../diccionario-principios";
import { calcularDescuentosCascada } from "../domain/descuentos";
import { mejoresCandidatos, triangularFila, numerosSospechosos } from "../domain/emparejar";
import { calcularVenta, validarVenta } from "../domain/contingencia";

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

// ─── 5. EMPAREJADO DIFUSO: listas de transferencia manuscritas ───
console.log("\nEmparejado difuso (transferencias manuscritas):");
const CATALOGO = [
  "PARACETAMOL 500MG X100 GENFAR", "AMOXICILINA 500MG X50 CAPSULAS",
  "AMOXICILINA 250MG SUSPENSION", "IBUPROFENO 400MG X50", "OMEPRAZOL 20MG X30 CAPSULAS",
];
test("error de ortografía: 'parasetamol 500' → PARACETAMOL 500MG (alta)", () => {
  const r = mejoresCandidatos("parasetamol 500", CATALOGO);
  assert.equal(r[0]?.nombre, "PARACETAMOL 500MG X100 GENFAR");
  assert.equal(r[0]?.confianza, "alta");
});
test("abreviación + dosis: 'Amoxi 500' elige la de 500MG, no la de 250", () => {
  const r = mejoresCandidatos("Amoxi 500", CATALOGO);
  assert.equal(r[0]?.nombre, "AMOXICILINA 500MG X50 CAPSULAS");
});
test("'omeprasol' (s por z) → OMEPRAZOL (alta)", () => {
  const r = mejoresCandidatos("omeprasol", CATALOGO);
  assert.equal(r[0]?.nombre, "OMEPRAZOL 20MG X30 CAPSULAS");
  assert.equal(r[0]?.confianza, "alta");
});
test("producto inexistente → sin candidatos (no inventa)", () => {
  const r = mejoresCandidatos("crema dental blanqueadora xyz", CATALOGO);
  assert.equal(r.length, 0);
});

// ─── 6. TRIANGULACIÓN: lectura de foto de conteo (número + sistema + nombre) ───
console.log("\nTriangulación (foto de conteo, 3 señales):");
const CATALOGO_NUM = [
  { id: 1, nombre: "AMOXICILINA 500MG X50", stock: 14, numero: 12 },
  { id: 2, nombre: "AMOXICILINA 250MG SUSP", stock: 30, numero: 13 },
  { id: 3, nombre: "PARACETAMOL 500MG", stock: 200, numero: 45 },
];
test("número de fila mal leído: sistema+nombre desambiguan igual", () => {
  const r = triangularFila({ numero: 11, nombre: "amoxicilina 500", sistema: 14 }, CATALOGO_NUM);
  assert.equal(r[0]?.id, 1);
  assert.equal(r[0]?.confianza, "alta");
});
test("nombre ambiguo (sin dosis): la cantidad de SISTEMA desambigua al producto correcto", () => {
  const r = triangularFila({ numero: null, nombre: "amoxicilina", sistema: 30 }, CATALOGO_NUM);
  assert.equal(r[0]?.id, 2); // el de stock=30, no el de stock=14
});
test("las 3 señales de acuerdo → confianza alta con las 3 señales listadas", () => {
  const r = triangularFila({ numero: 45, nombre: "paracetamol 500", sistema: 200 }, CATALOGO_NUM);
  assert.equal(r[0]?.id, 3);
  assert.equal(r[0]?.señales.length, 3);
});
test("secuencia con hueco legítimo (no se contó todo) NO se marca sospechosa", () => {
  const r = numerosSospechosos([{ numero: 10 }, { numero: 11 }, { numero: 17 }, { numero: 30 }, { numero: 31 }]);
  assert.deepEqual(r, [false, false, false, false, false]);
});
test("número que rompe el orden entre sus DOS vecinos (adelante y atrás) → sospechoso", () => {
  // "17" probablemente debería ser "71" (dígitos invertidos) — queda entre 69 y 71 en la lectura pero no en valor
  const r = numerosSospechosos([{ numero: 68 }, { numero: 69 }, { numero: 17 }, { numero: 71 }, { numero: 72 }]);
  assert.deepEqual(r, [false, false, true, false, false]);
});

// ─── 7. VENTAS DE CONTINGENCIA (365 caído) ───
console.log("\nVentas de contingencia:");
test("calcula subtotales y total con redondeo a 2 decimales", () => {
  const r = calcularVenta([
    { nombre: "PARACETAMOL 500MG", cantidad: 3, precioUnit: 1.5 },
    { nombre: "AMOXICILINA 500MG", cantidad: 2, precioUnit: 4.33 },
  ]);
  assert.equal(r.items[0].subtotal, 4.5);
  assert.equal(r.items[1].subtotal, 8.66);
  assert.equal(r.total, 13.16);
});
test("rechaza venta sin productos, sin precio o con cantidad 0", () => {
  assert.notEqual(validarVenta([]), null);
  assert.notEqual(validarVenta([{ nombre: "X", cantidad: 0, precioUnit: 5 }]), null);
  assert.notEqual(validarVenta([{ nombre: "X", cantidad: 1, precioUnit: 0 }]), null);
  assert.equal(validarVenta([{ nombre: "X", cantidad: 1, precioUnit: 5 }]), null);
});

// ─── Resultado ───
console.log(`\n${fallan === 0 ? "✅" : "❌"} ${pasan} pasan, ${fallan} fallan\n`);
process.exit(fallan === 0 ? 0 : 1);
