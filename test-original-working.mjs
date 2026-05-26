import { inventarios365 } from './server/inventarios365.ts';

async function test() {
  console.log('🧪 Prueba de sincronización con inventarios365.com');
  console.log('================================================\n');

  const result = await inventarios365.registrarCompra({
    proveedor: 'Laboratorios Bago',
    tipoComprobante: 'FACTURA',
    numComprobante: 'TEST-ORIGINAL-WORKING-001',
    almacenNombre: 'ALMACEN PRINCIPAL',
    items: [
      {
        nombre: 'ACTRON 400 mg x 10 Caps',
        cantidad: 150,
        precio: 79.0,
        fechaVencimiento: '2026-05-22',
      },
      {
        nombre: 'ASPIRINA TABL 500 MG x 100',
        cantidad: 600,
        precio: 45.0,
        fechaVencimiento: '2026-06-15',
      },
    ],
    total: 1708,
  });

  console.log('\n📊 Resultado:');
  console.log(JSON.stringify(result, null, 2));

  if (result.success) {
    console.log(`\n✅ ¡¡¡SINCRONIZACIÓN EXITOSA!!!`);
    console.log(`📦 Ingreso ID: ${result.ingresoId}`);
    console.log(`📝 Mensaje: ${result.message}`);
  } else {
    console.log(`\n❌ Error: ${result.message}`);
  }
}

test().catch(console.error);
