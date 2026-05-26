const BASE_URL = 'https://vidafarmacia.inventarios365.com';
const USERNAME = 'superadmin';
const PASSWORD = 'superadmin';

let cookies = '';
let csrfToken = '';

async function login() {
  console.log('🔐 Iniciando login...');
  
  const loginResponse = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      usuario: USERNAME,
      password: PASSWORD,
    }),
  });

  const setCookieHeader = loginResponse.headers.get('set-cookie');
  if (setCookieHeader) {
    cookies = setCookieHeader.split(';')[0];
    console.log('✅ Cookies obtenidas:', cookies.substring(0, 50) + '...');
  }

  const loginData = await loginResponse.json();
  console.log('📝 Response login:', JSON.stringify(loginData).substring(0, 200));

  // Obtener CSRF token de la respuesta
  if (loginData._token) {
    csrfToken = loginData._token;
    console.log('✅ CSRF Token obtenido:', csrfToken.substring(0, 30) + '...');
  }
}

async function registrarCompra() {
  console.log('\n📦 Registrando compra...');

  const payload = {
    inventarios: [
      {
        idarticulo: 4785,
        idalmacen: 1,
        codigo: 'MIC533',
        articulo: 'COTRIMOXAZOL Jbe 100ml 240mg (saphi)',
        precio: '21.0000',
        precio_paquete: '21.0000',
        precio_venta: '28.0000',
        unidad_x_paquete: 1,
        fecha_vencimiento: '2026-05-22',
        cantidad: 1,
      },
    ],
  };

  console.log('📤 Payload a enviar:', JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(`${BASE_URL}/inventarios/registrar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-TOKEN': csrfToken || 'test',
        'Cookie': cookies,
      },
      body: JSON.stringify(payload),
    });

    console.log('📊 Status:', response.status);
    console.log('📋 Headers:', Object.fromEntries(response.headers));

    const responseText = await response.text();
    console.log('📥 Response (raw):', responseText.substring(0, 500));

    try {
      const responseJson = JSON.parse(responseText);
      console.log('📥 Response (JSON):', JSON.stringify(responseJson, null, 2));
    } catch (e) {
      console.log('⚠️ Response no es JSON válido');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function main() {
  try {
    await login();
    await registrarCompra();
  } catch (error) {
    console.error('❌ Error fatal:', error);
  }
}

main();
