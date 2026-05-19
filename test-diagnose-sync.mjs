import axios from "axios";

const BASE_URL = "https://vidafarmacia.inventarios365.com";
const CREDENTIALS = {
  usuario: "superadmin",
  password: "superadmin",
};

async function diagnose() {
  console.log("🔍 DIAGNÓSTICO DETALLADO DE SINCRONIZACIÓN\n");

  try {
    // 1. GET / para obtener CSRF token
    console.log("1️⃣ GET / para obtener CSRF token...");
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

    console.log(`   Status: ${getResp.status}`);

    const setCookiesGet = Array.isArray(getResp.headers["set-cookie"])
      ? getResp.headers["set-cookie"]
      : getResp.headers["set-cookie"]
        ? [getResp.headers["set-cookie"]]
        : [];

    console.log(`   Cookies recibidas: ${setCookiesGet.length}`);
    setCookiesGet.forEach((c) => console.log(`     - ${c.split(";")[0]}`));

    // Extraer _token
    const csrfMatch = getResp.data.match(/name="_token"\s+value="([^"]+)"/);
    const formToken = csrfMatch ? csrfMatch[1] : "";
    console.log(`   _token obtenido: ${formToken ? "✓" : "✗"}\n`);

    // 2. POST / con credenciales
    console.log("2️⃣ POST / con credenciales...");
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

    console.log(`   Status: ${postResp.status}`);

    const setCookiesPost = Array.isArray(postResp.headers["set-cookie"])
      ? postResp.headers["set-cookie"]
      : postResp.headers["set-cookie"]
        ? [postResp.headers["set-cookie"]]
        : [];

    console.log(`   Cookies recibidas: ${setCookiesPost.length}`);
    setCookiesPost.forEach((c) => console.log(`     - ${c.split(";")[0]}`));

    const newXsrf =
      setCookiesPost
        .find((c) => c.includes("XSRF-TOKEN"))
        ?.match(/XSRF-TOKEN=([^;]+)/)?.[1] || initialXsrf;
    const newSession =
      setCookiesPost
        .find((c) => c.includes("laravel_session"))
        ?.match(/laravel_session=([^;]+)/)?.[1] || initialSession;

    console.log(`   Login exitoso: ${newSession ? "✓" : "✗"}\n`);

    // 3. Hacer POST a /ingreso/registrar
    console.log("3️⃣ POST /ingreso/registrar...");

    const payload = {
      idproveedor: 100,
      tipo_comprobante: "FACTURA",
      serie_comprobante: "",
      num_comprobante: "TEST-DIAGNOSE-001",
      impuesto: 0,
      total: 100,
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
          cantidad: 5,
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
          "Content-Type": "application/json",
          Referer: `${BASE_URL}/main`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      }
    );

    console.log(`   Status: ${registroResp.status}`);
    console.log(`   Response:`, JSON.stringify(registroResp.data, null, 2));
    console.log();

    if (registroResp.data?.id) {
      console.log(`✅ INGRESO REGISTRADO: ID ${registroResp.data.id}`);
    } else if (registroResp.data?.error) {
      console.log(`❌ ERROR: ${registroResp.data.error}`);
    } else {
      console.log(`⚠️ RESPUESTA INESPERADA (sin ID ni error)`);
    }
  } catch (error) {
    console.error("❌ ERROR CRÍTICO:", error.message);
    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", error.response.data);
    }
  }
}

diagnose();
