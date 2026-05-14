import { inventarios365 } from "./server/inventarios365.ts";

async function testSyncBago() {
  console.log("🔍 Simulando sincronización de factura Bago...\n");

  try {
    // Datos exactos de la factura
    const items = [
      { nombre: "ACTRON 400 mg x 10 Caps", cantidad: 150, precio: 22.00 },
      { nombre: "ACTRON 600 mg x 10 Caps", cantidad: 150, precio: 40.50 },
      { nombre: "ASPIRINA TABL 500 MG x 100", cantidad: 600, precio: 49.50 },
      { nombre: "ASPIRINETAS x 98 cpr", cantidad: 588, precio: 58.00 },
      { nombre: "CARDIO ASPIRINA x 30 comp", cantidad: 180, precio: 46.50 },
      { nombre: "REDOXON TABL EFE LM 2 G x 10", cantidad: 40, precio: 48.00 },
    ];

    console.log("📋 Productos a sincronizar:");
    items.forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.nombre} - ${item.cantidad} unidades @ ${item.precio} BS`);
    });
    console.log();

    // Registrar compra completa
    console.log("🔄 Registrando compra en inventarios365.com...\n");
    const result = await inventarios365.registrarCompra({
      proveedor: "Bago",
      tipoComprobante: "FACTURA",
      numComprobante: "139167",
      almacenNombre: "principal",
      items,
      total: 2040.30,
    });

    console.log("\n" + "=".repeat(80));
    console.log("RESULTADO:");
    console.log("=".repeat(80));
    console.log(JSON.stringify(result, null, 2));
    console.log("=".repeat(80) + "\n");

    if (result.success) {
      console.log("✅ SINCRONIZACIÓN EXITOSA");
      console.log(`   Ingreso ID: ${result.ingresoId}`);
      console.log(`   Mensaje: ${result.message}`);
    } else {
      console.log("❌ SINCRONIZACIÓN FALLIDA");
      console.log(`   Error: ${result.message}`);
    }
  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
    console.error(error);
    process.exit(1);
  }
}

testSyncBago();
