import axios from "axios";

const BASE_URL = "https://vidafarmacia.inventarios365.com";
const CREDENTIALS = {
  usuario: "superadmin",
  password: "superadmin",
};

// Número único basado en timestamp
const numeroUnico = `VERIFY-${Date.now()}`;

async function testAndVerify() {
  console.log(`🔍 PRUEBA DE SINCRONIZACIÓN Y VERIFICACIÓN\n`);
  console.log(`Número de comprobante único: ${numeroUnico}\n`);

  try {
    // 1. GET / para obtener CSRF token
    console.log("1️⃣ Obteniendo CSRF token...");
    const getResp = await axios.get(`${BASE_URL}/`, {
      maxRedirects: 5,
      timeout: 60000,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const setCookiesGet = Array.isArray(getResp.headers["set-cookie"])
      ? getResp.headers["set-cookie"]
      : getResp.headers["set-cookie"]
        ? [getResp.headers["set-cookie"]]
        : [];

    const csrfMatch = getResp.data.match(/name="_token"\s+value="([^"]+)"/);
    const formToken = csrfMatch ? csrfMatch[1] : "";

    // 2. POST / con credenciales
    console.log("2️⃣ Haciendo login...");
    const initialXsrf = setCookiesGet
      .find((c) => c.includes("XSRF-TOKEN"))
      ?.match(/XSRF-TOKEN=([^;]+)/)?.[1];
    const initialSession = setCookiesGet
      .find((c) => c.includes("laravel_session"))
      ?.match(/laravel_session=([^;]+)/)?.[1];

    const cookieGet = [
      initialXsrf ? `XSRF-TOKEN=${initialXsrf}` : "",
      initialSession ? `laravel_session=${initialSession}` : "",
    ]
      .filter(Boolean)
      .join("; ");

    const formData = new URLSearchParams();
    formData.append("_token", formToken);
    formData.append("usuario", CREDENTIALS.usuario);
    formData.append("password", CREDENTIALS.password);

    const postResp = await axios.post(`${BASE_URL}/`, formData.toString(), {
      maxRedirects: 0,
      timeout: 60000,
      validateStatus: (s) => s < 400,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieGet,
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const setCookiesPost = Array.isArray(postResp.headers["set-cookie"])
      ? postResp.headers["set-cookie"]
      : postResp.headers["set-cookie"]
        ? [postResp.headers["set-cookie"]]
        : [];

    const newXsrf =
      setCookiesPost
        .find((c) => c.includes("XSRF-TOKEN"))
        ?.match(/XSRF-TOKEN=([^;]+)/)?.[1] || initialXsrf;
    const newSession =
      setCookiesPost
        .find((c) => c.includes("laravel_session"))
        ?.match(/laravel_session=([^;]+)/)?.[1] || initialSession;

    // 3. Hacer POST a /ingreso/registrar
    console.log("3️⃣ Registrando compra en inventarios365.com...");

    const payload = {
      idproveedor: 100,
      tipo_comprobante: "FACTURA",
      serie_comprobante: "",
      num_comprobante: numeroUnico,
      impuesto: 0,
      total: 500,
      data: [
        {
          idarticulo: 79,
          idalmacen: 1,
          codigo: "26780",
          articulo: "ACTRON 400 CAPS",
          precio: 22,
          precio_paquete: 3,
          precio_venta: 3.5,
          unidad_x_paquete: 1,
          fecha_vencimiento: null,
          cantidad: 10,
        },
      ],
    };

    const cookie = [
      newXsrf ? `XSRF-TOKEN=${newXsrf}` : "",
      newSession ? `laravel_session=${newSession}` : "",
    ]
      .filter(Boolean)
      .join("; ");

    const xsrfDecoded = newXsrf ? decodeURIComponent(newXsrf) : "";

    const registroResp = await axios.post(
      `${BASE_URL}/ingreso/registrar`,
      payload,
      {
        timeout: 60000,
        validateStatus: () => true,
        headers: {
          Cookie: cookie,
          "X-XSRF-TOKEN": xsrfDecoded,
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "application/json",
          Referer: `${BASE_URL}/main`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      }
    );

    console.log(`   Status: ${registroResp.status}`);
    console.log(`   Response: ${JSON.stringify(registroResp.data)}\n`);

    if (registroResp.data?.id) {
      console.log(`✅ Servidor respondió con ID: ${registroResp.data.id}`);
      console.log(`\n📋 INSTRUCCIONES PARA VERIFICAR:\n`);
      console.log(`1. Ve a https://vidafarmacia.inventarios365.com`);
      console.log(`2. Login con superadmin / superadmin`);
      console.log(`3. Ve a COMPRAS → Comprar`);
      console.log(`4. Busca el número de comprobante: ${numeroUnico}`);
      console.log(`\n❓ ¿Aparece la compra en la lista?`);
      console.log(`   - SI: El servidor está guardando correctamente ✓`);
      console.log(`   - NO: El servidor responde OK pero no guarda ✗\n`);
    } else {
      console.log(`❌ Error: ${registroResp.data?.error || "Sin respuesta"}`);
    }
  } catch (error) {
    console.error("❌ ERROR:", error.message);
  }
}

testAndVerify();
