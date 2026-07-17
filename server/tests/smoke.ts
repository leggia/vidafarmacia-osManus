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
import { evaluarPrecio, ultimoPrecioPorProducto } from "../domain/compras";
import { sugerenciaCuadre } from "../../shared/cuadre";
import { descuentoTipico, evaluarDescuento } from "../../shared/descuentos";
import { compararPeriodo } from "../domain/tendencias";
import { construirLibro, resumenPeriodo, rangoTrimestre } from "../domain/psicotropicos";

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

// ─── 8. INTELIGENCIA DE COMPRAS ───
console.log("\nInteligencia de compras:");
test("precio dentro de ±0.5% del histórico → 'igual' (no hay que revisar)", () => {
  const r = evaluarPrecio(10.02, 10.00, null);
  assert.equal(r.estado, "igual");
});
test("precio 15% más caro que el histórico → 'subio' con el % correcto", () => {
  const r = evaluarPrecio(11.5, 10.00, null);
  assert.equal(r.estado, "subio");
  assert.equal(r.diffPct, 15);
});
test("precio más barato que el histórico → 'bajo'", () => {
  const r = evaluarPrecio(9.00, 10.00, null);
  assert.equal(r.estado, "bajo");
});
test("sin referencia (producto nunca comprado) → 'nuevo'", () => {
  const r = evaluarPrecio(10.00, null, null);
  assert.equal(r.estado, "nuevo");
});
test("costo nuevo deja margen bajo (<20%) contra el precio de venta → alerta", () => {
  const r = evaluarPrecio(9.00, 10.00, 10.00); // venta 10, costo 9 → margen 10%
  assert.equal(r.alertaMargen, true);
});
test("margen sano (>=20%) → sin alerta", () => {
  const r = evaluarPrecio(7.00, 10.00, 10.00); // margen 30%
  assert.equal(r.alertaMargen, false);
});
test("auditoría: de varias compras del mismo producto, vale el precio MÁS RECIENTE", () => {
  const r = ultimoPrecioPorProducto([
    { productName: "PARACETAMOL 500MG", precioVenta: 5, fecha: "2026-01-10", purchaseId: 1 },
    { productName: "PARACETAMOL 500MG", precioVenta: 6, fecha: "2026-07-10", purchaseId: 2 },
    { productName: "AMOXICILINA 500MG", precioVenta: 12, fecha: "2026-03-01", purchaseId: 3 },
  ]);
  assert.equal(r.length, 2);
  const para = r.find((x) => x.productName.startsWith("PARACETAMOL"));
  assert.equal(para?.precioVenta, 6); // el de julio, no el de enero
});
test("auditoría: mismo día → gana la carga más reciente (id mayor)", () => {
  const r = ultimoPrecioPorProducto([
    { productName: "IBUPROFENO 400", precioVenta: 8, fecha: "2026-07-10", purchaseId: 1, itemId: 10 },
    { productName: "IBUPROFENO 400", precioVenta: 9, fecha: "2026-07-10", purchaseId: 2, itemId: 20 },
  ]);
  assert.equal(r[0].precioVenta, 9);
});
test("cuadre: si la línea ya da el total de la factura → sin sugerencia", () => {
  assert.equal(sugerenciaCuadre(10, 12, 120), null);
});
test("cuadre: corrijo la cantidad → sugiere el PRECIO que cuadra con la factura", () => {
  const r = sugerenciaCuadre(12, 12, 120); // la factura cobra 120, no 144
  assert.equal(r?.calculado, 144);
  assert.equal(r?.precioSugerido, 10);
});
test("cuadre: corrijo el precio → sugiere la CANTIDAD solo si da entero exacto", () => {
  const r = sugerenciaCuadre(5, 10, 120); // 120/10 = 12 exacto
  assert.equal(r?.cantidadSugerida, 12);
  const r2 = sugerenciaCuadre(5, 7, 120); // 120/7 = 17.14… no exacto
  assert.equal(r2?.cantidadSugerida, null);
});
test("cuadre: tolera 2 centavos de redondeo del proveedor", () => {
  assert.equal(sugerenciaCuadre(3, 10, 30.02), null);
});
test("cuadre: sin total de factura (producto agregado a mano) → sin sugerencia", () => {
  assert.equal(sugerenciaCuadre(5, 10, null), null);
});
// ─── Descuentos por proveedor ───
test("descuento típico usa MEDIANA, no promedio (una promo puntual no lo distorsiona)", () => {
  // 20,20,20 habitual + una promo del 50% → la mediana sigue siendo 20
  assert.equal(descuentoTipico([20, 20, 50, 20]), 20);
});
test("alerta si el proveedor da MENOS descuento del habitual", () => {
  const a = evaluarDescuento("PARACETAMOL", 10, [25, 25, 24]);
  assert.equal(a?.peor, true);
  assert.equal(a?.pctTipico, 25);
  assert.equal(a?.diferencia, -15);
});
test("avisa también si da MÁS de lo habitual (peor=false)", () => {
  const a = evaluarDescuento("X", 30, [20, 20]);
  assert.equal(a?.peor, false);
});
test("no alerta por diferencias chicas (<5 puntos) — evita ruido", () => {
  assert.equal(evaluarDescuento("X", 22, [20, 20, 21]), null);
});
test("no alerta sin patrón suficiente (1 sola compra previa)", () => {
  assert.equal(evaluarDescuento("X", 5, [25]), null);
});
test("auditoría: ignora los que no tienen precio de venta editado", () => {
  const r = ultimoPrecioPorProducto([
    { productName: "X", precioVenta: 0, fecha: "2026-07-10", purchaseId: 1 },
  ]);
  assert.equal(r.length, 0);
});

// ─── 9. TENDENCIAS Y ALERTAS PROACTIVAS ───
console.log("\nTendencias:");
test("caída de 20% vs. semana anterior → alerta, dirección 'bajo'", () => {
  const r = compararPeriodo(800, 1000);
  assert.equal(r.direccion, "bajo");
  assert.equal(r.alerta, true);
  assert.equal(r.cambioPct, -20);
});
test("cambio chico (5%) → sin alerta (no es ruido)", () => {
  const r = compararPeriodo(1050, 1000);
  assert.equal(r.alerta, false);
  assert.equal(r.direccion, "subio");
});
test("sin ventas el período anterior → 'sin_datos', nunca alerta falsa", () => {
  const r = compararPeriodo(500, 0);
  assert.equal(r.alerta, false);
});

// ─── 10. LIBRO DE PSICOTRÓPICOS (saldos legales) ───
console.log("\nLibro de psicotrópicos:");
test("arrastra el saldo: inicial 20, egreso 5, ingreso 60 → saldo final 75", () => {
  const r = construirLibro(20, [
    { fecha: "2026-04-10", tipo: "egreso", cantidad: 5 },
    { fecha: "2026-06-15", tipo: "ingreso", cantidad: 60 },
  ]);
  assert.equal(r.saldoFinal, 75);
  assert.equal(r.totalEgreso, 5);
  assert.equal(r.totalIngreso, 60);
  assert.equal(r.lineas[0].saldoActual, 15); // 20 - 5
  assert.equal(r.lineas[1].saldoActual, 75); // 15 + 60
});
test("ordena por fecha aunque los movimientos vengan desordenados", () => {
  const r = construirLibro(0, [
    { fecha: "2026-06-15", tipo: "ingreso", cantidad: 10 },
    { fecha: "2026-01-05", tipo: "ingreso", cantidad: 3 },
  ]);
  assert.equal(r.lineas[0].fecha, "2026-01-05");
  assert.equal(r.lineas[0].saldoActual, 3);
  assert.equal(r.lineas[1].saldoActual, 13);
});
test("resumen sin movimientos → sinMovimiento true, saldo se mantiene", () => {
  const r = resumenPeriodo(20, []);
  assert.equal(r.sinMovimiento, true);
  assert.equal(r.saldoActual, 20);
});
test("rango del 2º trimestre 2026 → abr-jun (exclusivo julio)", () => {
  const r = rangoTrimestre(2026, 2);
  assert.equal(r.desde, "2026-04-01");
  assert.equal(r.hasta, "2026-07-01");
});

// ─── Resultado ───
console.log(`\n${fallan === 0 ? "✅" : "❌"} ${pasan} pasan, ${fallan} fallan\n`);
process.exit(fallan === 0 ? 0 : 1);
