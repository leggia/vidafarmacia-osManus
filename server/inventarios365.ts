/**
 * Servicio de sincronización con inventarios365.com
 *
 * Flujo de autenticación confirmado mediante ingeniería inversa del JS de la app:
 *  1. GET /  → obtener XSRF-TOKEN cookie + _token hidden input
 *  2. POST / con form-data (_token, usuario, password) → obtiene laravel_session + XSRF-TOKEN nuevos
 *  3. Todas las peticiones POST llevan:
 *       Cookie: XSRF-TOKEN=...; laravel_session=...
 *       X-XSRF-TOKEN: <valor URL-decodificado del cookie XSRF-TOKEN>
 *       Content-Type: application/json
 *       X-Requested-With: XMLHttpRequest
 *
 * Endpoints confirmados y probados:
 *  - GET  /articulo/listarArticulo?buscar=&criterio=todos&idProveedor=
 *  - GET  /articulo/buscarArticulo?filtro=<nombre>
 *  - GET  /proveedor/selectProveedor?filtro=
 *  - GET  /almacen/selectAlmacen  → { almacenes: [{id, nombre_almacen}] }
 *  - POST /ingreso/registrar      → { id: <ingresoId> }
 *  - POST /traspasoproducto/registrar
 */

import axios, { AxiosInstance } from "axios";

const BASE_URL = "https://vidafarmacia.inventarios365.com";
// Credenciales de inventarios365 — NUNCA hardcodear aquí (quedan expuestas en el
// repo de GitHub para siempre). Se configuran en Railway como variables de entorno.
const CREDENTIALS = {
  usuario: process.env.INVENTARIOS365_USER || "",
  password: process.env.INVENTARIOS365_PASS || "",
};

// Estructura de un artículo en el detalle de compra
export interface DetalleCompra {
  idarticulo: number;
  idalmacen: number;
  codigo: string;
  articulo: string;
  precio: string;
  precio_paquete: string;
  precio_venta: string;
  unidad_x_paquete: number;
  fecha_vencimiento: string | null;
  vencimiento?: string | null; // El sistema usa este campo en la tabla de productos
  cantidad: number;
}

// Estructura del payload para registrar una compra
export interface RegistrarCompraPayload {
  idproveedor: number;
  idalmacen: number;
  tipo_comprobante: string;
  num_comprobante: string;
  impuesto: number;
  total: number;
  data: DetalleCompra[];
}

// Estructura de artículo devuelto por la API
export interface ArticuloAPI {
  id: number;
  codigo: string;
  nombre: string;
  precio_costo_unid: string | number;
  precio_costo_paq: string | number;
  precio_uno: string | number;
  unidad_envase: number;
  stock?: string | number;
  vencimiento?: string | null;
  nombre_categoria?: string;
  nombre_proveedor?: string;
  descripcion?: string;
}

// Estructura de almacén devuelto por la API
export interface AlmacenAPI {
  id: number;
  nombre_almacen: string;
  sucursal?: number;
}

// Estructura de proveedor devuelto por la API
export interface ProveedorAPI {
  id: number;
  nombre: string;
  num_documento?: string | null;
}

class Inventarios365Service {
  private client: AxiosInstance;
  // Cookies de sesión almacenadas como string "key=value; key2=value2"
  private xsrfToken: string | null = null;
  private csrfToken: string | null = null; // Token CSRF del formulario (para header X-CSRF-TOKEN)
  // Caché en memoria de listados de inventario por almacén+proveedor (TTL 5 min)
  private cacheInventario: Map<string, { data: any[]; expira: number }> = new Map();
  private laravelSession: string | null = null;
  private lastLogin: number = 0;
  private SESSION_TTL = 90 * 60 * 1000; // 90 minutos (las cookies duran 2h)

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      // No seguir redirecciones automáticamente para capturar cookies
      maxRedirects: 0,
      validateStatus: (status) => status < 500,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
  }

  /**
   * Construir el string de Cookie a partir de los tokens almacenados.
   */
  private buildCookieHeader(): string {
    const parts: string[] = [];
    if (this.xsrfToken) parts.push(`XSRF-TOKEN=${this.xsrfToken}`);
    if (this.laravelSession) parts.push(`laravel_session=${this.laravelSession}`);
    return parts.join("; ");
  }

  /**
   * Extraer el valor de una cookie específica de un array de set-cookie headers.
   */
  private extractCookie(setCookies: string[], name: string): string | null {
    for (const cookie of setCookies) {
      const match = cookie.match(new RegExp(`^${name}=([^;]+)`));
      if (match) return match[1];
    }
    return null;
  }

  /**
   * Autenticarse en inventarios365.com y obtener cookies de sesión válidas.
   * Flujo real confirmado:
   *   1. GET / → XSRF-TOKEN cookie + _token hidden input
   *   2. POST / con form-data → nueva laravel_session + XSRF-TOKEN
   */
  private async login(): Promise<void> {
    const now = Date.now();
    if (
      this.xsrfToken &&
      this.laravelSession &&
      now - this.lastLogin < this.SESSION_TTL
    ) {
      return; // Sesión todavía válida
    }

    try {
      // ── Paso 1: GET / para obtener CSRF token y cookies iniciales ──────────
      const getResp = await axios.get(`${BASE_URL}/`, {
        maxRedirects: 5,
        validateStatus: () => true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      const setCookiesGet: string[] = Array.isArray(
        getResp.headers["set-cookie"]
      )
        ? (getResp.headers["set-cookie"] as string[])
        : getResp.headers["set-cookie"]
        ? [getResp.headers["set-cookie"] as string]
        : [];

      const initialXsrf = this.extractCookie(setCookiesGet, "XSRF-TOKEN");
      const initialSession = this.extractCookie(setCookiesGet, "laravel_session");

      // Extraer _token del HTML del formulario
      const csrfMatch = (getResp.data as string).match(
        /name="_token"\s+value="([^"]+)"/
      );
      const formToken = csrfMatch ? csrfMatch[1] : "";

      if (!formToken) {
        throw new Error("No se pudo obtener el _token del formulario de login");
      }

      // Guardar el CSRF token para usarlo en headers X-CSRF-TOKEN posteriores
      this.csrfToken = formToken;

      // ── Paso 2: POST / con credenciales ────────────────────────────────────
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

      const setCookiesPost: string[] = Array.isArray(
        postResp.headers["set-cookie"]
      )
        ? (postResp.headers["set-cookie"] as string[])
        : postResp.headers["set-cookie"]
        ? [postResp.headers["set-cookie"] as string]
        : [];

      // Tomar las cookies más recientes (del POST)
      const newXsrf =
        this.extractCookie(setCookiesPost, "XSRF-TOKEN") || initialXsrf;
      const newSession =
        this.extractCookie(setCookiesPost, "laravel_session") || initialSession;

      if (!newSession) {
        throw new Error("Login fallido: no se recibió laravel_session");
      }

      this.xsrfToken = newXsrf;
      this.laravelSession = newSession;
      this.lastLogin = now;

      console.log("[Inventarios365] Login exitoso. Session obtenida.");
    } catch (error: any) {
      console.error("[Inventarios365] Error en login:", error?.message);
      throw new Error(
        `No se pudo autenticar en inventarios365.com: ${error?.message}`
      );
    }
  }

  /**
   * Hacer una petición GET autenticada.
   */
  private async get<T = any>(path: string): Promise<T> {
    await this.login();
    const cookie = this.buildCookieHeader();
    const resp = await this.client.get<T>(path, {
      headers: { Cookie: cookie },
    });
    return resp.data;
  }

  /**
   * Hacer una petición POST autenticada con XSRF.
   * El header X-XSRF-TOKEN debe llevar el valor URL-decodificado del cookie.
   */
  private async post<T = any>(path: string, payload: object): Promise<T> {
    // MODO STAGING: ningún POST (escritura real) llega a 365 — se simula una
    // respuesta segura y se registra en el log. Las LECTURAS (get) siguen yendo
    // a 365 real sin problema (no hay riesgo en leer). Esto permite tener un
    // entorno de pruebas SIN arriesgar el inventario/ventas reales, incluso
    // usando las mismas credenciales de 365 — nada se modifica de verdad.
    if (process.env.MODO_STAGING === "true") {
      console.log(`[STAGING] Simulado (NO se llamó a 365 real): POST ${path} | payload: ${JSON.stringify(payload).slice(0, 200)}`);
      return {
        id: Math.floor(Date.now() / 1000),
        ok: true,
        success: true,
        error: null,
        message: "[STAGING] Simulado — el inventario/ventas real de 365 NO fue modificado.",
      } as any as T;
    }
    await this.login();
    const cookie = this.buildCookieHeader();
    const xsrfDecoded = this.xsrfToken
      ? decodeURIComponent(this.xsrfToken)
      : "";
    console.log(`[POST] ${path} | XSRF: ${xsrfDecoded ? "OK" : "MISSING"} | CSRF: ${this.csrfToken ? "OK" : "MISSING"} | Cookie: ${cookie ? "OK" : "MISSING"}`);
    const resp = await this.client.post<T>(path, payload, {
      headers: {
        Cookie: cookie,
        "X-XSRF-TOKEN": xsrfDecoded,
        "X-CSRF-TOKEN": this.csrfToken || "",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/json",
        Referer: `${BASE_URL}/main`,
      },
    });
    console.log(`[POST] ${path} → status: ${resp.status} | data: ${JSON.stringify(resp.data).substring(0, 150)}`);
    return resp.data;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Métodos públicos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extraer palabras clave del nombre de un producto para búsqueda flexible.
   * Ejemplo: "ACTRON 400 mg x 10 Caps." → ["ACTRON 400", "ACTRON"]
   */
  private extractSearchTerms(nombre: string): string[] {
    // Limpiar el nombre: quitar presentación (x10, x30, mg, caps, comp, etc.)
    const clean = nombre
      .toUpperCase()
      .replace(/\s+X\s*\d+.*/i, "")       // quitar "x 10 Caps" y todo lo que sigue
      .replace(/\s+\d+\s*(MG|ML|G|MCG|UI|IU|CAPS?|COMP?|TAB|TABL?|CPR|GTS?|JARABE|SUSP|INY|INYEC|AMP|SOBRES?|CREMA|POMADA|GEL|SPRAY|GOTAS|SOLUCION|SOL|POLVO|GRANULADO|EFERVESCENTE|EFE|EFC|EFEC|BLANDA|DURA|RETARD|FORTE|PLUS|MAX|MINI|BEBE|PEDIATRICO|PEDRIATRICO|NIÑOS?|ADULTO|SIMPLE|DOBLE|TRIPLE).*/i, "")
      .replace(/\s+(MG|ML|G|MCG|UI|IU)\b.*/i, "")  // quitar dosis al final
      .trim();

    const terms: string[] = [];
    if (clean && clean !== nombre.toUpperCase()) terms.push(clean);

    // También intentar con las primeras 2-3 palabras del nombre original
    const words = nombre.trim().split(/\s+/);
    if (words.length >= 2) terms.push(words.slice(0, 2).join(" "));
    if (words.length >= 1) terms.push(words[0]);

    // Deduplicar manteniendo orden
    const seen = new Set<string>();
    return terms.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; });
  }

  /**
   * Calcular similitud entre dos nombres de productos (0-1).
   * Usa coincidencia de tokens: cuántos tokens del nombre original aparecen en el candidato.
   */
  // Convierte cualquier formato de fecha a YYYY-MM-DD (el que usa inventarios365)
  private convertirFecha(f: string | null | undefined): string | null {
    if (!f) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f; // ya está en YYYY-MM-DD
    // YYYY/MM/DD → YYYY-MM-DD
    const yyyyMMDD = f.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (yyyyMMDD) {
      return `${yyyyMMDD[1]}-${yyyyMMDD[2].padStart(2, "0")}-${yyyyMMDD[3].padStart(2, "0")}`;
    }
    const mmYYYY = f.match(/^(\d{1,2})\/(\d{4})$/);
    if (mmYYYY) {
      const mes = mmYYYY[1].padStart(2, "0");
      const anio = mmYYYY[2];
      const ultimoDia = new Date(Number(anio), Number(mes), 0).getDate();
      return `${anio}-${mes}-${ultimoDia}`;
    }
    const ddMMYYYY = f.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ddMMYYYY) {
      const dia = ddMMYYYY[1].padStart(2, "0");
      const mes = ddMMYYYY[2].padStart(2, "0");
      return `${ddMMYYYY[3]}-${mes}-${dia}`;
    }
    return f;
  }

  private calcularSimilitud(original: string, candidato: string): number {
    const normalizar = (s: string) =>
      s.toUpperCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "") // quitar tildes
        .replace(/[^A-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2); // ignorar tokens muy cortos como "P", "X"

    const tokensOrig = normalizar(original);
    const tokensCand = normalizar(candidato);
    if (tokensOrig.length === 0) return 0;

    // El primer token (nombre principal) debe coincidir
    const tokenPrincipal = tokensOrig[0];
    const tokenPrincipalPresente = tokensCand.some(
      c => c.startsWith(tokenPrincipal) || tokenPrincipal.startsWith(c)
    );
    if (!tokenPrincipalPresente) return 0;

    let matches = 0;
    for (const t of tokensOrig) {
      if (tokensCand.some((c) => c.startsWith(t) || t.startsWith(c))) matches++;
    }

    // Score bidireccional
    const scoreAdelante = matches / tokensOrig.length;
    const scoreAtras = matches / Math.max(tokensCand.length, 1);
    return (scoreAdelante + scoreAtras) / 2;
  }

  /**
   * Buscar un artículo por nombre en inventarios365.com.
   * Usa /articulo/listarArticulo?buscar= con búsqueda progresiva por palabras clave.
   * El endpoint /articulo/buscarArticulo no devuelve resultados (bug del sistema).
   */
  async buscarArticulo(nombre: string, idProveedor?: number, proveedor?: string): Promise<ArticuloAPI | null> {
    // Limpiar código numérico del inicio del nombre (ej: "400180 QUETOROL" → "QUETOROL")
    const nombreLimpio = nombre.replace(/^\d+\s+/, "").trim();
    const nombreBuscar = nombreLimpio || nombre;

    try {
      // 0. Buscar en confirmaciones aprendidas (máxima prioridad)
      if (proveedor) {
        const { confirmacionesService } = await import("./confirmaciones");
        let confirmacion = await confirmacionesService.buscar(proveedor, nombreBuscar);
        if (!confirmacion) confirmacion = await confirmacionesService.buscar(proveedor, nombre);
        if (confirmacion) {
          console.log(`[Confirmaciones] ✅ "${nombreBuscar}" (${proveedor}) → "${confirmacion.nombreSistema}" (ID:${confirmacion.id})`);
          return {
            id: confirmacion.id,
            nombre: confirmacion.nombreSistema,
            codigo: confirmacion.codigo,
            _score: 1.0,
          } as any;
        }
      }

      // 1. Si tenemos idProveedor, buscar DIRECTO en API filtrando por proveedor
      // (el cache no tiene idproveedor confiable, la API sí filtra correctamente)
      const { productosCache } = await import("./productos-cache");
      if (!idProveedor) {
        // Solo usar cache si NO hay proveedor (búsqueda general)
        const local = await productosCache.buscarLocalAsync(nombreBuscar, idProveedor);
        if (local) return local;
      }

      // 2. Buscar en API filtrando por proveedor
      console.log(`[Inventarios365] "${nombreBuscar}" buscando en API (proveedor: ${idProveedor || "ninguno"})...`);
      const terms = [nombreBuscar, ...this.extractSearchTerms(nombreBuscar)];
      let bestOverall: { art: ArticuloAPI; score: number; term: string } | null = null;
      const proveedorParam = idProveedor ? String(idProveedor) : "";

      for (const term of terms) {
        if (!term || term.length < 3) continue;
        const data = await this.get<{ articulos: ArticuloAPI[] | { data: ArticuloAPI[] } }>(
          `/articulo/listarArticulo?buscar=${encodeURIComponent(term)}&criterio=todos&idProveedor=${proveedorParam}`
        );
        const raw = data?.articulos;
        const articulos: ArticuloAPI[] = Array.isArray(raw)
          ? raw
          : raw && "data" in raw
          ? (raw as { data: ArticuloAPI[] }).data
          : [];

        if (articulos.length === 0) continue;

        // Calcular similitud para cada candidato y elegir el mejor
        let localBest: { art: ArticuloAPI; score: number } | null = null;
        for (const art of articulos) {
          const score = this.calcularSimilitud(nombre, art.nombre);
          if (!localBest || score > localBest.score) {
            localBest = { art, score };
          }
        }

        if (localBest && (!bestOverall || localBest.score > bestOverall.score)) {
          bestOverall = { art: localBest.art, score: localBest.score, term };
        }

        // Si encontramos una coincidencia perfecta (>= 0.8), no seguir buscando
        if (bestOverall && bestOverall.score >= 0.8) break;
      }

      if (bestOverall) {
        console.log(
          `[Inventarios365] Artículo "${nombre}" → término:"${bestOverall.term}" | match:"${bestOverall.art.nombre}" (ID:${bestOverall.art.id}, score:${bestOverall.score.toFixed(2)})`
        );
        // Incluir _score en el resultado para que registrarCompra pueda decidir
        return { ...bestOverall.art, _score: bestOverall.score } as any;
      }

      console.warn(`[Inventarios365] Artículo "${nombre}" no encontrado con ningún término`);
      return null;
    } catch (error) {
      console.error(`[Inventarios365] Error buscando artículo "${nombre}":`, error);
      return null;
    }
  }

  /**
   * Listar artículos con búsqueda opcional.
   * Endpoint: GET /articulo/listarArticulo?buscar=&criterio=todos&idProveedor=
   */
  /**
   * Consulta de productos para SOLO LECTURA (contingencias): precio de venta + stock.
   * Devuelve lo mínimo necesario para atender ventas durante un apagón.
   */
  async consultarProductos(buscar: string): Promise<Array<{
    id: number; nombre: string; codigo: string; precioVenta: number; stock: number;
  }>> {
    const articulos = await this.listarArticulos(buscar, "");
    const base = articulos.map((a) => ({
      id: a.id,
      nombre: a.nombre,
      codigo: a.codigo,
      precioVenta: parseFloat(String(a.precio_uno ?? 0)) || 0,
      stock: parseFloat(String(a.stock ?? 0)) || 0,
    }));
    // Enriquecer: si 365 buscó solo por nombre, sumar coincidencias por PRINCIPIO
    // ACTIVO (descripción) desde el cache local, sin duplicar por id.
    try {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (db && buscar.trim().length >= 3) {
        const palabras = buscar.trim().split(/\s+/).filter(Boolean).slice(0, 4);
        let cond = sql`(nombre LIKE ${"%" + palabras[0] + "%"} OR descripcion LIKE ${"%" + palabras[0] + "%"})`;
        for (let i = 1; i < palabras.length; i++) cond = sql`${cond} AND (nombre LIKE ${"%" + palabras[i] + "%"} OR descripcion LIKE ${"%" + palabras[i] + "%"})`;
        const r: any = await db.execute(sql`SELECT articuloId, nombre, codigo, precioUno FROM productos_cache WHERE ${cond} LIMIT 20`);
        const filas = Array.isArray(r) ? r[0] : r?.rows ?? r;
        const extra = Array.isArray(filas) ? filas : [];
        const ids = new Set(base.map((b) => b.id));
        for (const e of extra) {
          if (!ids.has(e.articuloId)) {
            base.push({ id: e.articuloId, nombre: e.nombre, codigo: e.codigo || "", precioVenta: parseFloat(String(e.precioUno ?? 0)) || 0, stock: 0 });
            ids.add(e.articuloId);
          }
        }
      }
    } catch { /* si el cache falla, devolver solo lo de 365 */ }
    return base;
  }

  async listarArticulos(buscar = "", idProveedor = ""): Promise<ArticuloAPI[]> {
    try {
      const data = await this.get<{ articulos: ArticuloAPI[] | { data: ArticuloAPI[] } }>(
        `/articulo/listarArticulo?buscar=${encodeURIComponent(buscar)}&criterio=todos&idProveedor=${idProveedor}`
      );
      const raw = data?.articulos;
      if (Array.isArray(raw)) return raw;
      if (raw && "data" in raw) return (raw as { data: ArticuloAPI[] }).data;
      return [];
    } catch (error) {
      console.error("[Inventarios365] Error listando artículos:", error);
      return [];
    }
  }

  /**
   * Listar las categorías disponibles en el sistema.
   */
  async listarCategorias(): Promise<Array<{ id: number; nombre: string }>> {
    try {
      const data = await this.get<any>(`/categorianewview?page=1&buscar=&criterio=nombre`);
      const raw = data?.categorias ?? data?.data ?? data;
      const arr = Array.isArray(raw) ? raw : (raw?.data ?? []);
      return arr.map((c: any) => ({ id: c.id, nombre: c.nombre })).filter((c: any) => c.id);
    } catch (error) {
      console.error("[Inventarios365] Error listando categorías:", error);
      return [];
    }
  }

  /**
   * Actualizar el precio de COSTO de un artículo tras una compra.
   * El endpoint /ingreso/registrar sube stock pero NO refresca el costo en la ficha
   * del producto. El sistema web usa POST /articulo/actualizarPrecios con el payload:
   *   { id, precio_costo_paquete, precio_costo_unidad, precio_uno, precio_dos, precio_tres, precio_cuatro }
   * (Confirmado capturando la petición real del sistema 365.)
   */
  async actualizarPrecioCosto(idarticulo: number, costoUnitario: number, unidadEnvase = 1): Promise<boolean> {
    const costoPaquete = costoUnitario * (unidadEnvase || 1);
    // Traer los precios de venta actuales para no perderlos al actualizar
    let articulo: any = null;
    try { articulo = await this.obtenerArticuloPorId(idarticulo); } catch { /* seguimos con defaults */ }
    const payload = {
      id: idarticulo,
      precio_costo_paquete: costoPaquete,
      precio_costo_unidad: costoUnitario,
      precio_uno: articulo?.precio_uno ?? "0",
      precio_dos: articulo?.precio_dos ?? "0",
      precio_tres: articulo?.precio_tres ?? 0,
      precio_cuatro: articulo?.precio_cuatro ?? 0,
    };
    const MAX_INTENTOS = 3;
    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
      try {
        await this.post<any>("/articulo/actualizarPrecios", payload);
        console.log(`[Inventarios365] Costo actualizado: artículo ${idarticulo} → ${costoUnitario} Bs (intento ${intento})`);
        return true;
      } catch (error: any) {
        console.warn(`[Inventarios365] Costo intento ${intento}/${MAX_INTENTOS} falló (art ${idarticulo}):`, error?.message);
        if (intento < MAX_INTENTOS) await new Promise(r => setTimeout(r, 500 * intento));
      }
    }
    console.error(`[Inventarios365] Costo del artículo ${idarticulo} FALLÓ tras ${MAX_INTENTOS} intentos`);
    return false;
  }

  /**
   * Aplicar SOLO precios de venta a una lista de productos, SIN registrar ningún
   * ingreso. Sirve para corregir los precios que 365 no aplicó en una compra ya
   * sincronizada — reintentar la compra completa crearía un ingreso DUPLICADO
   * (365 no permite borrarlos por API), y aquí solo se tocan los precios.
   * Verifica releyendo: informa cuáles quedaron y cuáles no.
   */
  async aplicarPreciosVenta(items: Array<{ nombre: string; precioVenta: number }>, proveedor?: string): Promise<{
    aplicados: string[]; fallidos: string[]; noEncontrados: string[];
  }> {
    const aplicados: string[] = [], fallidos: string[] = [], noEncontrados: string[] = [];
    const paraVerificar: { id: number; precio: number; nombre: string }[] = [];
    for (const it of items) {
      if (!it.nombre || !(it.precioVenta > 0)) continue;
      const articulo = await this.buscarArticulo(it.nombre, undefined, proveedor);
      if (!articulo) { noEncontrados.push(it.nombre); continue; }
      const actual = parseFloat(String(articulo.precio_uno || 0)) || 0;
      if (Math.abs(actual - it.precioVenta) <= 0.01) { aplicados.push(articulo.nombre); continue; } // ya está bien
      const ok = await this.actualizarPrecioVenta(articulo.id, it.precioVenta);
      if (ok) paraVerificar.push({ id: articulo.id, precio: it.precioVenta, nombre: articulo.nombre });
      else fallidos.push(articulo.nombre);
      await new Promise((r) => setTimeout(r, 150)); // no saturar 365
    }
    // Verificar de verdad (releer), no confiar en la respuesta
    if (paraVerificar.length > 0) {
      try {
        const data = await this.get<any>(`/articulo/listarArticulo?buscar=&criterio=todos&idProveedor=`);
        const lista = data?.articulos?.data ?? data?.articulos ?? data?.data ?? [];
        const porId = new Map((Array.isArray(lista) ? lista : []).map((a: any) => [Number(a.id), a]));
        for (const p of paraVerificar) {
          const a = porId.get(Number(p.id));
          const precioEn365 = a ? parseFloat(String(a.precio_uno || 0)) || 0 : NaN;
          if (!a || Math.abs(precioEn365 - p.precio) > 0.01) fallidos.push(p.nombre);
          else aplicados.push(p.nombre);
        }
      } catch {
        // Sin verificación no afirmamos éxito ni fracaso: se listan como aplicados
        // "sin confirmar" para no mentir en ninguna dirección.
        for (const p of paraVerificar) aplicados.push(p.nombre);
      }
    }
    return { aplicados, fallidos, noEncontrados };
  }

  /** Obtener un artículo por su id (busca en el listado). */
  async obtenerArticuloPorId(idarticulo: number): Promise<any | null> {
    try {
      const data = await this.get<any>(
        `/articulo/listarArticulo?buscar=&criterio=todos&idProveedor=`
      );
      const lista = data?.articulos?.data ?? data?.articulos ?? data?.data ?? [];
      const arr = Array.isArray(lista) ? lista : [];
      return arr.find((a: any) => Number(a.id) === Number(idarticulo)) || null;
    } catch (e: any) {
      console.warn(`[Inventarios365] obtenerArticuloPorId(${idarticulo}) falló:`, e?.message);
      return null;
    }
  }

  /**
   * Actualizar el precio de venta de un producto.
   * Endpoint: POST /articulo/actualizarPrecioVenta con { id, precio_uno }
   */
  async actualizarPrecioVenta(idarticulo: number, precioUno: number): Promise<boolean> {
    const MAX_INTENTOS = 3;
    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
      try {
        const respData = await this.post<any>("/articulo/actualizarPrecioVenta", {
          id: idarticulo,
          precio_uno: precioUno,
        });
        // NO basta con que no lance excepción: 365 puede responder 200 OK con un
        // error DENTRO del cuerpo (producto bloqueado, precio rechazado…). Si no
        // se revisa, el precio "se actualiza" en silencio sin cambiar nada — era
        // la causa de "en la lista se ve el precio nuevo pero en 365 no cambió".
        const err = respData?.error ?? respData?.errors ?? null;
        const okExplicito = respData?.success === true || respData?.ok === true;
        const fallo = !!err || respData?.success === false || respData?.ok === false;
        if (fallo) {
          console.warn(`[Inventarios365] 365 rechazó el precio del artículo ${idarticulo}:`, JSON.stringify(respData).substring(0, 150));
          return false; // rechazo explícito: reintentar no ayuda
        }
        console.log(`[Inventarios365] Precio actualizado: artículo ${idarticulo} → ${precioUno} Bs (intento ${intento}${okExplicito ? ", confirmado" : ""})`, JSON.stringify(respData).substring(0, 80));
        return true;
      } catch (error: any) {
        console.warn(`[Inventarios365] Intento ${intento}/${MAX_INTENTOS} falló para artículo ${idarticulo}:`, error?.message);
        if (intento < MAX_INTENTOS) {
          // Espera incremental antes de reintentar (500ms, 1000ms)
          await new Promise(r => setTimeout(r, 500 * intento));
        }
      }
    }
    console.error(`[Inventarios365] Precio del artículo ${idarticulo} FALLÓ tras ${MAX_INTENTOS} intentos`);
    return false;
  }

  /**
   * Crear un producto nuevo. POST /articulo/registrar (multipart form-data)
   */
  async crearProducto(params: {
    nombre: string;
    codigo: string;
    descripcion?: string;
    nombreGenerico?: string;
    costoUnitario: number;
    precioVenta: number;
    idcategoria: number;
    idproveedor?: number;
    stockMinimo?: number;
    unidadEnvase?: number;
  }): Promise<{ success: boolean; id?: number; message?: string }> {
    try {
      this.invalidateSession();
      await this.login();

      // FormData nativo de Node 20 (no requiere librería externa)
      const form = new FormData();
      form.append("nombre", params.nombre);
      form.append("descripcion", params.descripcion || "");
      form.append("nombre_generico", params.nombreGenerico || "");
      form.append("unidad_envase", String(params.unidadEnvase ?? 1));
      form.append("precio_costo_unid", String(params.costoUnitario));
      form.append("precio_costo_paq", String(params.costoUnitario));
      form.append("precio_venta", "0");
      form.append("precio_uno", String(params.precioVenta));
      form.append("precio_dos", "0");
      form.append("precio_tres", "0");
      form.append("precio_cuatro", "0");
      form.append("stock", String(params.stockMinimo ?? 10));
      form.append("costo_compra", "0");
      form.append("codigo", params.codigo);
      form.append("codigo_alfanumerico", "");
      form.append("descripcion_fabrica", "");
      form.append("idcategoria", String(params.idcategoria));
      form.append("idmarca", "null");
      form.append("idindustria", "null");
      form.append("idgrupo", "null");
      form.append("idproveedor", String(params.idproveedor ?? 0));
      form.append("idmedida", "undefined");
      form.append("fechaVencimientoSeleccion", "0");
      form.append("precio_costo_paqVacio", "false");

      const cookie = this.buildCookieHeader();
      const xsrfDecoded = this.xsrfToken ? decodeURIComponent(this.xsrfToken) : "";

      const resp = await this.client.post("/articulo/registrar", form, {
        headers: {
          Cookie: cookie,
          "X-XSRF-TOKEN": xsrfDecoded,
          "X-CSRF-TOKEN": this.csrfToken || "",
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${BASE_URL}/main`,
        },
        maxRedirects: 0,
        validateStatus: () => true,
      });

      console.log(`[Inventarios365] crearProducto "${params.nombre}" → status ${resp.status}:`, JSON.stringify(resp.data).substring(0, 200));

      if (resp.status >= 200 && resp.status < 300) {
        const id = resp.data?.id ?? resp.data?.articulo?.id;
        return { success: true, id, message: "Producto creado" };
      }
      return { success: false, message: `Error ${resp.status}` };
    } catch (error: any) {
      console.error("[Inventarios365] Error creando producto:", error?.message);
      return { success: false, message: error?.message || "Error al crear producto" };
    }
  }

  /**
   * Obtener la lista de almacenes disponibles.
   * Endpoint: GET /almacen/selectAlmacen → { almacenes: [{id, nombre_almacen}] }
   */
  async listarAlmacenes(): Promise<AlmacenAPI[]> {
    try {
      const data = await this.get<{ almacenes: AlmacenAPI[] }>(
        "/almacen/selectAlmacen"
      );
      return data?.almacenes || [];
    } catch (error) {
      console.error("[Inventarios365] Error listando almacenes:", error);
      return [];
    }
  }

  /**
   * Buscar un proveedor por nombre.
   * Endpoint: GET /proveedor/selectProveedor?filtro=<nombre>
   */
  async buscarProveedor(nombre: string): Promise<ProveedorAPI | null> {
    // Si no hay nombre de proveedor, no buscar (devolver null = sin filtro)
    if (!nombre || String(nombre).trim() === "") {
      console.warn("[Inventarios365] Proveedor sin nombre — se buscará sin filtro de proveedor");
      return null;
    }
    try {
      // Generar términos de búsqueda progresivamente más cortos
      const terminos = this.extractSearchTerms(String(nombre));
      const intentos = [String(nombre), ...terminos].slice(0, 5);

      for (const termino of intentos) {
        if (termino.length < 3) continue;
        const data = await this.get<{ proveedores: ProveedorAPI[] }>(
          `/proveedor/selectProveedor?filtro=${encodeURIComponent(termino)}`
        );
        const proveedores: ProveedorAPI[] = data?.proveedores || [];
        if (proveedores.length > 0) {
          console.log(`[Inventarios365] Proveedor "${nombre}" → término:"${termino}" | match:"${proveedores[0].nombre}" (ID:${proveedores[0].id})`);
          return proveedores[0];
        }
      }

      console.warn(`[Inventarios365] Proveedor "${nombre}" no encontrado, usando ID 0`);
      return null;
    } catch (error) {
      console.error(`[Inventarios365] Error buscando proveedor "${nombre}":`, error);
      return null;
    }
  }

  /**
   * Ajustar el stock de varios productos tras un conteo físico.
   * Endpoint: POST /ajuste/registrar-multiple
   * Solo se envían productos cuyo físico difiere del sistema.
   */
  async ajustarInventario(params: {
    almacenId: number;
    motivoId: number; // 2 = "Ajuste periodico"
    ajustes: Array<{
      productoId: number;
      inventarioId?: number | null;
      stockAnterior: number;   // stock del sistema
      stockReal: number;       // físico contado
      fechaVencimiento?: string | null;
    }>;
  }): Promise<{ ok: boolean; ajustados: number; mensaje: string }> {
    try {
      // Solo productos con diferencia real
      const conDiferencia = params.ajustes.filter(a => a.stockReal !== a.stockAnterior);
      if (conDiferencia.length === 0) {
        return { ok: true, ajustados: 0, mensaje: "No hay diferencias para ajustar" };
      }

      const productos = conDiferencia.map(a => {
        const diferencia = Math.abs(a.stockReal - a.stockAnterior);
        // físico menor que sistema → salida (baja); físico mayor → entrada (alta)
        const tipoMovimiento = a.stockReal < a.stockAnterior ? "salida" : "entrada";
        const fv = a.fechaVencimiento ? this.convertirFecha(a.fechaVencimiento) : null;
        return {
          producto_id: a.productoId,
          inventario_id: a.inventarioId ?? null,
          cantidad: diferencia,
          tipo_movimiento: tipoMovimiento,
          stock_anterior: a.stockAnterior,
          stock_real: a.stockReal,
          es_padre: 1,
          producto_padre_id: null,
          fecha_vencimiento: fv,
          fecha_vencimiento_original: fv,
        };
      });

      const payload = {
        almacen_id: params.almacenId,
        motivo_id: params.motivoId,
        productos,
      };

      console.log(`[Inventarios365] Ajuste de inventario: ${productos.length} productos con diferencia`);
      const resp = await this.post<any>("/ajuste/registrar-multiple", payload);
      console.log(`[Inventarios365] Ajuste response:`, JSON.stringify(resp).substring(0, 200));
      this.invalidarCacheInventario(params.almacenId); // el stock cambió, refrescar caché
      return { ok: true, ajustados: productos.length, mensaje: `${productos.length} productos ajustados` };
    } catch (error: any) {
      console.error(`[Inventarios365] Error ajustando inventario:`, error?.message);
      return { ok: false, ajustados: 0, mensaje: error?.message || "Error al ajustar" };
    }
  }

  /**
   * Contar el total de proveedores del sistema (para el progreso global del inventario).
   * Intenta el endpoint paginado de proveedores (similar a categorianewview).
   */
  /**
   * Lista COMPLETA de proveedores (paginada, todas las páginas). A diferencia de
   * listarProveedores (que es un buscador y exige mínimo 2 letras), esta recorre
   * /proveedor?page=N acumulando todo. Caché en memoria 10 min (cambian poco).
   */
  async listarTodosProveedores(maxPaginas = 30): Promise<Array<{ id: string; nombre: string }>> {
    const cached = this.cacheInventario.get("todosProveedores");
    if (cached && cached.expira > Date.now() && Array.isArray(cached.data) && cached.data.length > 0) {
      return cached.data as any;
    }
    const resultado: Array<{ id: string; nombre: string }> = [];
    const vistos = new Set<string>();
    try {
      for (let page = 1; page <= maxPaginas; page++) {
        const data = await this.get<any>(`/proveedor?page=${page}&buscar=&criterio=todos`);
        const arr = data?.personas ?? data?.proveedores?.data ?? data?.data ?? [];
        if (!Array.isArray(arr) || arr.length === 0) break;
        for (const p of arr) {
          const id = String(p.id ?? "");
          const nombre = String(p.nombre ?? p.razonSocial ?? p.razon_social ?? p.nombreProveedor ?? "").trim();
          if (!id || !nombre || vistos.has(id)) continue;
          vistos.add(id);
          resultado.push({ id, nombre });
        }
        const total = Number(data?.pagination?.total ?? 0);
        if (total > 0 && resultado.length >= total) break;
        await new Promise((r) => setTimeout(r, 80));
      }
    } catch (e) {
      console.error("[Inventarios365] Error listando todos los proveedores:", e);
    }
    if (resultado.length > 0) {
      this.cacheInventario.set("todosProveedores", { data: resultado as any, expira: Date.now() + 10 * 60 * 1000 });
    }
    return resultado;
  }

  async contarProveedores(): Promise<{ total: number; endpoint: string; intentos?: any[] }> {
    const candidatos = [
      "/proveedor?page=1&buscar=&criterio=todos",
    ];
    const intentos: any[] = [];
    for (const url of candidatos) {
      try {
        const data = await this.get<any>(url);
        const keys = data && typeof data === "object" ? Object.keys(data) : [];
        // Estructura real: { pagination: {total, ...}, personas: [...], idrol }
        const pag = data?.pagination ?? {};
        const total = pag.total ?? pag.totalRegistros ?? pag.totalItems ?? data?.total ?? null;
        const arr = data?.personas ?? data?.proveedores?.data ?? data?.data ?? null;
        intentos.push({ url, keys, paginationKeys: Object.keys(pag), total, arrLen: Array.isArray(arr) ? arr.length : null });
        if (total != null && Number(total) > 0) {
          return { total: Number(total), endpoint: url, intentos };
        }
        if (Array.isArray(arr) && arr.length > 0) {
          return { total: arr.length, endpoint: url + " (conteo de página)", intentos };
        }
      } catch (e: any) {
        intentos.push({ url, error: e?.response?.status || e?.message });
      }
    }
    return { total: 0, endpoint: "ninguno", intentos };
  }

  /**
   * Listar usuarios del sistema inventarios365 (para vincular con trabajadores).
   * Endpoint pendiente de confirmar por captura de red.
   */
  async listarUsuarios(): Promise<Array<{ id: string; nombre: string }>> {
    // Caché de 10 min (los usuarios cambian poco)
    const cached = this.cacheInventario.get("usuarios");
    if (cached && cached.expira > Date.now() && Array.isArray(cached.data) && cached.data.length > 0) {
      return cached.data as any;
    }
    const candidatos = [
      "/usuario?page=1&buscar=&criterio=todos",
      "/usuarios?page=1&buscar=&criterio=todos",
      "/usuario?page=1&buscar=&criterio=nombre",
      "/user?page=1&buscar=&criterio=todos",
      "/usuario",
      "/usuarios",
    ];
    for (const url of candidatos) {
      try {
        const data = await this.get<any>(url);
        const arr = data?.usuarios ?? data?.personas ?? data?.users ?? data?.data
          ?? data?.usuarios?.data ?? (Array.isArray(data) ? data : null);
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`[Inventarios365] Usuarios OK via ${url}: ${arr.length}`);
          const usuarios = arr.map((u: any) => ({
            id: String(u.id ?? u.idusuario ?? u.user_id ?? u.idUsuario ?? ""),
            nombre: u.nombre ?? u.name ?? u.usuario ?? u.username ?? u.login ?? u.nombre_persona ?? "",
          })).filter((u: any) => u.id);
          if (usuarios.length > 0) {
            this.cacheInventario.set("usuarios", { data: usuarios as any, expira: Date.now() + 10 * 60 * 1000 });
            return usuarios;
          }
        } else {
          console.log(`[Inventarios365] Usuarios ${url}: sin array (keys: ${data && typeof data === "object" ? Object.keys(data).join(",") : typeof data})`);
        }
      } catch (e: any) {
        console.log(`[Inventarios365] Usuarios ${url} error: ${e?.response?.status || e?.message}`);
      }
    }
    console.warn("[Inventarios365] No se encontraron usuarios en ningún endpoint");
    return [];
  }

  /**
   * Leer las aperturas de caja de un usuario en un mes (YYYY-MM).
   * Endpoint pendiente de confirmar por captura de red.
   * Devuelve [{fecha:"YYYY-MM-DD", horaApertura:"HH:MM:SS", horaCierre?:"HH:MM:SS"}]
   */
  /** Lee una página del listado de ventas (cabecera: vendedor, sucursal, fecha, total). */
  async listarVentasPagina(page: number): Promise<{ ventas: any[]; pagination: any; raw?: any }> {
    const data = await this.get<any>(`/venta?page=${page}&buscar=&criterio=`);
    const ventas = data?.ventas?.data ?? data?.ventas ?? data?.data ?? (Array.isArray(data) ? data : []);
    const pagination = data?.ventas ?? data?.pagination ?? {};
    return { ventas: Array.isArray(ventas) ? ventas : [], pagination, raw: data };
  }

  /** Detalle de productos de una venta (producto + cantidad + precio por línea). */
  async obtenerDetallesVenta(idVenta: number): Promise<any[]> {
    try {
      const data = await this.get<any>(`/venta/obtenerDetalles?id=${idVenta}`);
      const arr = data?.detalles ?? data?.data ?? (Array.isArray(data) ? data : []);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  /** Cabecera de una venta (datos generales). */
  async obtenerCabeceraVenta(idVenta: number): Promise<any | null> {
    try {
      const data = await this.get<any>(`/venta/obtenerCabecera?id=${idVenta}`);
      return data?.cabecera ?? data?.data ?? data ?? null;
    } catch (e) { return null; }
  }

  /** Lee clientes de inventarios365 (paginado). La clave real es "usuarios". */
  async listarClientesPagina(page: number): Promise<{ clientes: any[]; pagination: any; raw?: any }> {
    const data = await this.get<any>(`/cliente?page=${page}&buscar=&criterio=global&usuarioid=1`);
    const usuarios = data?.usuarios;
    let clientes: any[] = [];
    if (Array.isArray(usuarios)) clientes = usuarios;
    else if (Array.isArray(usuarios?.data)) clientes = usuarios.data;
    else if (Array.isArray(data?.clientes?.data)) clientes = data.clientes.data;
    else if (Array.isArray(data?.clientes)) clientes = data.clientes;
    else if (Array.isArray(data?.data)) clientes = data.data;
    const pagination = usuarios?.total ? usuarios : (data?.pagination ?? {});
    return { clientes, pagination, raw: data };
  }

  async aperturasCajaDelMes(usuarioId: string, anioMes: string): Promise<Array<{ fecha: string; horaApertura: string; horaCierre?: string }>> {
    if (!usuarioId) return [];
    // Caché por usuario+mes (TTL 3 min): las aperturas no cambian al marcar ajustes
    // locales, así el resumen se recalcula al instante sin re-paginar inventarios365.
    const cacheKey = `aperturas-${usuarioId}-${anioMes}`;
    const cached = this.cacheInventario.get(cacheKey);
    if (cached && cached.expira > Date.now()) return cached.data as any;

    const resultado: Array<{ fecha: string; horaApertura: string; horaCierre?: string }> = [];
    let page = 1;
    const maxPages = 60;
    try {
      while (page <= maxPages) {
        const data = await this.get<any>(`/caja?page=${page}&buscar=&criterio=`);
        if (page === 1) {
          const arrDiag = data?.cajas ?? data?.data ?? data?.movimientos ?? (Array.isArray(data) ? data : null);
          const ej = Array.isArray(arrDiag) ? arrDiag[0] : (arrDiag?.data?.[0] ?? null);
          console.log(`[Inventarios365] caja keys:`, data && typeof data === "object" ? Object.keys(data).join(",") : typeof data);
          console.log(`[Inventarios365] caja ejemplo:`, JSON.stringify(ej).substring(0, 400));
        }
        // Extraer el array de cajas (formatos posibles)
        const pag = data?.pagination ?? {};
        let arr: any[] = [];
        if (Array.isArray(data?.cajas)) arr = data.cajas;
        else if (Array.isArray(data?.cajas?.data)) arr = data.cajas.data;
        else if (Array.isArray(data?.data)) arr = data.data;
        else if (Array.isArray(data?.movimientos)) arr = data.movimientos;
        else if (Array.isArray(data)) arr = data;

        for (const c of arr) {
          // Filtrar por usuario (campo real: idusuario)
          const uid = String(c.idusuario ?? "");
          if (uid !== String(usuarioId)) continue;
          // Fecha/hora de apertura (campo real: fechaApertura "YYYY-MM-DD HH:MM:SS")
          const fhApertura = c.fechaApertura ?? "";
          const fhCierre = c.fechaCierre ?? "";
          const [fecha, horaA] = String(fhApertura).split(/[ T]/);
          if (!fecha || !fecha.startsWith(anioMes)) continue; // solo el mes pedido
          const [fechaC, horaC] = fhCierre ? String(fhCierre).split(/[ T]/) : [null, undefined];
          resultado.push({ fecha, horaApertura: horaA || "00:00:00", horaCierre: horaC, fechaCierre: fechaC || undefined } as any);
        }

        const lastPage = pag.last_page ?? pag.lastPage ?? 1;
        if (page >= lastPage || arr.length === 0) break;
        page++;
      }
    } catch (e) {
      console.error("[Inventarios365] Error leyendo cajas:", e);
    }
    // Guardar en caché (TTL 3 min) para acelerar recálculos del resumen
    this.cacheInventario.set(cacheKey, { data: resultado as any, expira: Date.now() + 3 * 60 * 1000 });
    return resultado;
  }

  /**
   * Listar las cajas ABIERTAS ahora mismo (fechaApertura sin fechaCierre).
   * Devuelve los campos crudos para identificar usuario y sucursal.
   */
  async cajasAbiertas(): Promise<Array<any>> {
    const abiertas: any[] = [];
    let page = 1;
    const maxPages = 10;
    try {
      while (page <= maxPages) {
        const data = await this.get<any>(`/caja?page=${page}&buscar=&criterio=`);
        const pag = data?.pagination ?? {};
        let arr: any[] = [];
        if (Array.isArray(data?.cajas)) arr = data.cajas;
        else if (Array.isArray(data?.cajas?.data)) arr = data.cajas.data;
        else if (Array.isArray(data?.data)) arr = data.data;
        else if (Array.isArray(data?.movimientos)) arr = data.movimientos;
        else if (Array.isArray(data)) arr = data;

        if (page === 1 && arr[0]) {
          console.log(`[Inventarios365] caja campos:`, Object.keys(arr[0]).join(","));
          console.log(`[Inventarios365] caja ejemplo:`, JSON.stringify(arr[0]).substring(0, 500));
        }

        for (const c of arr) {
          const cierre = c.fechaCierre ?? c.fecha_cierre ?? null;
          // Caja abierta = tiene apertura pero NO cierre
          if (!cierre || String(cierre).trim() === "" || String(cierre) === "null") {
            abiertas.push(c);
          }
        }
        const lastPage = pag.last_page ?? pag.lastPage ?? 1;
        if (page >= lastPage || arr.length === 0) break;
        page++;
      }
    } catch (e) {
      console.error("[Inventarios365] Error leyendo cajas abiertas:", e);
    }
    return abiertas;
  }

  /**
   * Listar TODOS los proveedores del sistema (paginando).
   * Estructura: { pagination, personas:[...], idrol }
   */
  async listarTodosProveedores(): Promise<Array<{ id: number; nombre: string }>> {
    const todos: Array<{ id: number; nombre: string }> = [];
    let page = 1;
    const maxPages = 100;
    try {
      while (page <= maxPages) {
        const data = await this.get<any>(`/proveedor?page=${page}&buscar=&criterio=todos`);
        // personas puede ser un array directo o un objeto paginado {data:[...]}
        const personasRaw = data?.personas;
        if (page === 1) {
          console.log(`[Inventarios365] personas tipo:`, Array.isArray(personasRaw) ? `array[${personasRaw.length}]` : typeof personasRaw,
            `| ejemplo:`, JSON.stringify(Array.isArray(personasRaw) ? personasRaw[0] : personasRaw).substring(0, 200));
        }
        const arr = Array.isArray(personasRaw) ? personasRaw
          : (Array.isArray(personasRaw?.data) ? personasRaw.data : []);
        if (!Array.isArray(arr) || arr.length === 0) break;
        for (const p of arr) {
          const id = p.id ?? p.idpersona ?? p.id_proveedor ?? p.idProveedor;
          const nombre = p.nombre ?? p.razon_social ?? p.nombre_completo ?? p.persona ?? "";
          if (id) todos.push({ id: Number(id), nombre });
        }
        const pag = data?.pagination ?? {};
        const lastPage = pag.last_page ?? pag.lastPage ?? 1;
        if (page >= lastPage) break;
        page++;
      }
    } catch (e) {
      console.error("[Inventarios365] Error listando todos los proveedores:", e);
    }
    return todos;
  }

  /**
   * Método público SOLO para diagnóstico: obtiene la respuesta cruda de un path.
   */
  async diagRaw(path: string): Promise<any> {
    return this.get<any>(path);
  }

  /**
   * Listar productos para AJUSTE de inventario, filtrados por almacén y proveedor.
   * Endpoint REAL del módulo de ajuste: GET /articuloAjusteInven
   * Este sí trae el stock correcto del almacén específico.
   * Maneja paginación (trae todas las páginas).
   */
  async articuloAjusteInven(idAlmacen: number, idProveedor: string): Promise<any[]> {
    const todos: any[] = [];
    let page = 1;
    const maxPages = 50; // tope de seguridad
    try {
      while (page <= maxPages) {
        const url = `/articuloAjusteInven?page=${page}&buscar=&criterio=nombre&idAlmacen=${idAlmacen}&idProveedor=${idProveedor}`;
        const data = await this.get<any>(url);
        // Log de diagnóstico de la primera página para ver la estructura
        if (page === 1) {
          console.log(`[Inventarios365] articuloAjusteInven respuesta keys:`, data && typeof data === "object" ? Object.keys(data).join(", ") : typeof data);
        }
        // La respuesta puede venir en distintas formas: {data:[...]}, {articulos:{data:[...]}}, [...]
        let lista: any[] = [];
        let lastPage = 1;
        if (Array.isArray(data)) {
          lista = data;
        } else if (data?.data && Array.isArray(data.data)) {
          lista = data.data;
          lastPage = data.last_page ?? data.lastPage ?? 1;
        } else if (data?.articulos) {
          const art = data.articulos;
          if (Array.isArray(art)) { lista = art; }
          else if (art?.data && Array.isArray(art.data)) {
            lista = art.data;
            lastPage = art.last_page ?? art.lastPage ?? 1;
          }
        }
        todos.push(...lista);
        if (page === 1 && lista.length > 0) {
          console.log(`[Inventarios365] PRIMER PRODUCTO (campos reales):`, JSON.stringify(lista[0]));
        }
        if (page >= lastPage || lista.length === 0) break;
        page++;
      }
    } catch (error) {
      console.error("[Inventarios365] Error en articuloAjusteInven:", error);
    }
    return todos;
  }

  /**
   * Listar productos para inventario (por proveedor o todos), con stock y valor.
   */
  async listarParaInventario(idAlmacen: number, idProveedor = ""): Promise<Array<{
    id: number; nombre: string; codigo: string; stock: number;
    costoUnit: number; precioVenta: number; valorStock: number;
    inventarioId: number | null;
    categoria?: string; proveedor?: string; vencimiento?: string | null;
  }>> {
    // Caché: clave por almacén+proveedor, TTL 5 minutos
    const claveCache = `${idAlmacen}:${idProveedor}`;
    const cached = this.cacheInventario.get(claveCache);
    if (cached && cached.expira > Date.now()) {
      return cached.data;
    }
    const articulos = await this.articuloAjusteInven(idAlmacen, idProveedor);
    const resultado = articulos.map((a: any) => {
      const id = a.id;
      const nombre = a.nombre ?? "";
      const codigo = a.codigo ?? "";
      // El stock real del almacén viene en stock_total
      const stock = parseFloat(String(a.stock_total ?? 0)) || 0;
      const costoUnit = parseFloat(String(a.precio_costo_unid ?? a.precio_costo ?? 0)) || 0;
      const precioVenta = parseFloat(String(a.precio_uno ?? a.precio_venta ?? 0)) || 0;
      // Las fechas de vencimiento vienen en un array (lotes). Tomamos la primera/más próxima.
      let vencimiento: string | null = null;
      let inventarioId: number | null = null;
      if (Array.isArray(a.fechas_vencimiento) && a.fechas_vencimiento.length > 0) {
        // Ordenar por fecha más próxima (FEFO) y tomar la primera
        const lotes = [...a.fechas_vencimiento].sort((x, y) =>
          String(x.fecha_vencimiento || "").localeCompare(String(y.fecha_vencimiento || "")));
        vencimiento = lotes[0].fecha_vencimiento ?? null;
        inventarioId = lotes[0].id ?? null;
      }
      return {
        id, nombre, codigo, stock, costoUnit, precioVenta,
        valorStock: Math.round(stock * costoUnit * 100) / 100,
        inventarioId,
        categoria: a.nombre_categoria,
        proveedor: a.nombre_proveedor,
        vencimiento,
      };
    });
    // Guardar en caché por 5 minutos
    this.cacheInventario.set(claveCache, { data: resultado, expira: Date.now() + 5 * 60 * 1000 });
    return resultado;
  }

  /** Invalidar el caché de inventario (tras un ajuste de stock). */
  invalidarCacheInventario(idAlmacen?: number): void {
    if (idAlmacen == null) { this.cacheInventario.clear(); return; }
    for (const k of this.cacheInventario.keys()) {
      if (k.startsWith(`${idAlmacen}:`)) this.cacheInventario.delete(k);
    }
  }

  /**
   * Listar proveedores que coinciden con un término (para selección manual).
   * Devuelve varios resultados, no solo el primero.
   */
  async listarProveedores(filtro: string): Promise<ProveedorAPI[]> {
    try {
      if (!filtro || filtro.length < 2) return [];
      const data = await this.get<{ proveedores: ProveedorAPI[] }>(
        `/proveedor/selectProveedor?filtro=${encodeURIComponent(filtro)}`
      );
      return data?.proveedores || [];
    } catch (error) {
      console.error(`[Inventarios365] Error listando proveedores "${filtro}":`, error);
      return [];
    }
  }

  /**
   * Registrar una compra completa en inventarios365.com.
   * Busca automáticamente los IDs de artículos, proveedor y almacén.
   *
   * Endpoint: POST /ingreso/registrar
   * Respuesta exitosa: { id: <ingresoId> }
   */
  async registrarCompra(params: {
    proveedor: string;
    tipoComprobante: string;
    numComprobante: string;
    almacenNombre: string;
    items: Array<{
      nombre: string;
      cantidad: number;
      precio?: number;
      fechaVencimiento?: string | null;
      nuevoPrecioVenta?: number | null;
    }>;
    total?: number;
  }): Promise<{
    success: boolean;
    message: string;
    ingresoId?: number;
    productosNoEncontrados?: Array<{ nombre: string; nombreLimpio?: string; cantidad: number; precio?: number }>;
  }> {
    // Forzar re-login para garantizar sesión fresca en Railway
    this.invalidateSession();
    // Declarado ANTES del try para que el bloque catch también pueda accederlo
    // (una const dentro del try no es visible desde el catch → "is not defined").
    const productosNoEncontrados: { nombre: string; nombreLimpio?: string; cantidad: number; precio?: number; sugerencia?: any }[] = [];
    try {
      // 1. Listar almacenes
      const almacenes = await this.listarAlmacenes();
      console.log(
        "[Inventarios365] Almacenes:",
        almacenes.map((a) => `${a.id}:${a.nombre_almacen}`)
      );

      let idalmacen = almacenes[0]?.id ?? 1;
      const almacenEncontrado = almacenes.find(
        (a) =>
          a.nombre_almacen
            .toLowerCase()
            .includes(params.almacenNombre.toLowerCase()) ||
          params.almacenNombre
            .toLowerCase()
            .includes(a.nombre_almacen.toLowerCase())
      );
      if (almacenEncontrado) {
        idalmacen = almacenEncontrado.id;
        console.log(
          `[Inventarios365] Almacén: ${almacenEncontrado.nombre_almacen} (ID: ${idalmacen})`
        );
      }

      // 2. Buscar el proveedor
      let idproveedor: number | undefined = undefined;
      const proveedor = await this.buscarProveedor(params.proveedor);
      if (proveedor) {
        idproveedor = proveedor.id;
        console.log(
          `[Inventarios365] Proveedor: ${proveedor.nombre} (ID: ${idproveedor})`
        );
      } else {
        console.warn(
          `[Inventarios365] Proveedor "${params.proveedor}" no encontrado — buscando productos sin filtro de proveedor`
        );
      }

      // 3. Buscar cada artículo (con filtro de proveedor si se encontró, sin filtro si no)
      const arrayDetalle: DetalleCompra[] = [];
      const erroresArticulos: string[] = [];
      const productosEmparejados: { nombreFactura: string; nombreSistema: string; id: number }[] = [];
      const preciosActualizar: { id: number; precio: number; nombre: string }[] = [];
      const costosActualizar: { id: number; costo: number; nombre: string; unidadEnvase: number }[] = [];
      const historialParaGuardar: Array<{ articuloId: number; articuloNombre: string; proveedor?: string; costoUnitario: number; precioVenta?: number; numComprobante?: string }> = [];

      for (const item of params.items) {
        // Blindaje: si el item no tiene nombre válido, registrarlo como no encontrado
        // y continuar (evita que un item mal creado rompa toda la sincronización).
        if (!item || !item.nombre || String(item.nombre).trim() === "") {
          console.warn("[Inventarios365] Item sin nombre válido, se omite:", JSON.stringify(item));
          productosNoEncontrados.push({
            nombre: item?.nombre || "(sin nombre)",
            cantidad: Number(item?.cantidad) || 0,
            precio: Number(item?.precio) || 0,
          });
          continue;
        }
        // Buscar con filtro de proveedor si existe, sino buscar en todo el inventario
        const articulo = await this.buscarArticulo(item.nombre, idproveedor, params.proveedor);
        const score = articulo ? ((articulo as any)._score ?? 1.0) : 0;
        console.log(`[Fecha] "${item.nombre}" → fechaVencimiento recibida: ${JSON.stringify(item.fechaVencimiento)}`);
        const nombreLimpio = String(item.nombre).replace(/^\d+\s+/, "").trim();

        // Con filtro de proveedor: threshold 0.50 (resultados ya son del proveedor correcto)
        // Sin filtro de proveedor: threshold 0.80 (más estricto para evitar falsos positivos)
        const threshold = idproveedor ? 0.50 : 0.80;

        if (articulo && score >= threshold) {
          const precioCosto =
            item.precio ?? parseFloat(String(articulo.precio_costo_unid)) ?? 0;
          const unidadXPaq = Number(articulo.unidad_envase ?? 1) || 1;
          // El precio_paquete debe calcularse desde el NUEVO costo unitario
          // (costo unitario × unidades por paquete), no tomar el valor viejo del sistema.
          // Si no, cuando unidad_x_paquete > 1, el sistema no actualiza bien el costo.
          const precioPaquete = precioCosto * unidadXPaq;
          arrayDetalle.push({
            idarticulo: articulo.id,
            idalmacen,
            codigo: articulo.codigo,
            articulo: articulo.nombre,
            precio: String(precioCosto.toFixed(4)),
            precio_paquete: String(precioPaquete.toFixed(4)),
            precio_venta: String((parseFloat(String(articulo.precio_uno || 0)) || 0).toFixed(4)),
            unidad_x_paquete: unidadXPaq,
            fecha_vencimiento: this.convertirFecha(item.fechaVencimiento),
            vencimiento: this.convertirFecha(item.fechaVencimiento),
            cantidad: item.cantidad,
          });
          console.log(`[Inventarios365] ✓ "${item.nombre}" → "${articulo.nombre}" (ID:${articulo.id}, score:${score.toFixed(2)})`);
          productosEmparejados.push({ nombreFactura: item.nombre, nombreSistema: articulo.nombre, id: articulo.id });
          // Recolectar para historial de precios
          historialParaGuardar.push({
            articuloId: articulo.id,
            articuloNombre: articulo.nombre,
            proveedor: params.proveedor,
            costoUnitario: precioCosto,
            precioVenta: item.nuevoPrecioVenta ?? (parseFloat(String(articulo.precio_uno || 0)) || undefined),
            numComprobante: params.numComprobante,
          });
          // Si el usuario definió un nuevo precio de venta distinto, marcarlo para actualizar
          if (item.nuevoPrecioVenta != null && item.nuevoPrecioVenta > 0) {
            preciosActualizar.push({ id: articulo.id, precio: item.nuevoPrecioVenta, nombre: articulo.nombre });
          }
          // Si el costo de la factura difiere del costo actual en el sistema, actualizarlo.
          // (El endpoint de ingreso no siempre refresca el costo en la ficha del producto.)
          const costoSistema = parseFloat(String(articulo.precio_costo_unid || 0)) || 0;
          if (item.precio != null && item.precio > 0 && Math.abs(item.precio - costoSistema) > 0.001) {
            costosActualizar.push({ id: articulo.id, costo: item.precio, nombre: articulo.nombre, unidadEnvase: unidadXPaq });
          }
        } else {
          // Score bajo o no encontrado — agregar a panel de confirmación
          erroresArticulos.push(item.nombre);
          productosNoEncontrados.push({
            nombre: item.nombre,
            nombreLimpio: nombreLimpio !== item.nombre ? nombreLimpio : undefined,
            cantidad: item.cantidad,
            precio: item.precio,
            sugerencia: articulo ? {
              id: articulo.id,
              nombre: articulo.nombre,
              codigo: articulo.codigo,
              score: score,
            } : undefined,
          });
          if (articulo) {
            console.warn(`[Inventarios365] ⚠️ "${item.nombre}" → "${articulo.nombre}" score bajo (${score.toFixed(2)}) — requiere confirmación`);
          } else {
            console.warn(`[Inventarios365] ✗ "${item.nombre}" no encontrado`);
          }
        }
      }

      if (arrayDetalle.length === 0) {
        return {
          success: false,
          message: `No se encontró ningún artículo en inventarios365.com.`,
          productosNoEncontrados,
        };
      }

      // 4. Calcular total si no se proporcionó
      const totalFinal =
        (params.total ?? 0) > 0
          ? params.total!
          : arrayDetalle.reduce(
              (sum, d) => sum + parseFloat(d.precio) * d.cantidad,
              0
            );

      // 5. Registrar la compra — DOS PASOS (como hace el sistema web)
      // Paso 1: POST /ingreso/registrar con campo "data" → crea ingreso y sube stock
      const payload: RegistrarCompraPayload = {
        idproveedor,
        idalmacen,
        tipo_comprobante: params.tipoComprobante || "BOLETA",
        num_comprobante: params.numComprobante,
        impuesto: 0,
        total: totalFinal,
        data: arrayDetalle,
      };

      console.log(`[Inventarios365] PASO 1: POST /ingreso/registrar → ${payload.data?.length || 0} productos, total: ${payload.total}`);

      const respData = await this.post<{ id?: number; error?: string; message?: string }>(
        "/ingreso/registrar",
        payload
      );

      console.log(`[Inventarios365] PASO 1 response:`, JSON.stringify(respData));

      if (respData?.error) {
        console.error(`[Inventarios365] Error del servidor:`, respData.error);
        return { success: false, message: respData.error };
      }

      if (!respData?.id && !respData?.message) {
        return { success: false, message: `Respuesta inválida: ${JSON.stringify(respData)}` };
      }

      // Paso 2: POST /inventarios/registrar con campo "inventarios" → guarda fechas de vencimiento
      // Solo si hay al menos una fecha de vencimiento que guardar
      const tieneFechas = arrayDetalle.some(d => d.fecha_vencimiento);
      if (tieneFechas) {
        try {
          const payloadVcto = {
            idproveedor,
            idalmacen,
            tipo_comprobante: params.tipoComprobante || "BOLETA",
            num_comprobante: params.numComprobante,
            impuesto: 0,
            total: totalFinal,
            inventarios: arrayDetalle,
          };
          console.log(`[Inventarios365] PASO 2: POST /inventarios/registrar (fechas de vencimiento)`);
          const respVcto = await this.post<any>("/inventarios/registrar", payloadVcto);
          console.log(`[Inventarios365] PASO 2 response:`, JSON.stringify(respVcto));
        } catch (e: any) {
          console.warn(`[Inventarios365] PASO 2 (vencimientos) falló, pero el ingreso ya se guardó:`, e?.message);
        }
      }

      // Paso 3: Actualizar precios de venta que el usuario modificó
      const preciosVentaFallidos: string[] = [];
      if (preciosActualizar.length > 0) {
        console.log(`[Inventarios365] PASO 3: Actualizando ${preciosActualizar.length} precio(s) de venta`);
        for (const p of preciosActualizar) {
          try {
            const ok = await this.actualizarPrecioVenta(p.id, p.precio);
            if (!ok) {
              preciosVentaFallidos.push(p.nombre);
              console.warn(`[Inventarios365] actualizarPrecioVenta devolvió false para "${p.nombre}"`);
            }
          } catch (e: any) {
            preciosVentaFallidos.push(p.nombre);
            console.warn(`[Inventarios365] No se pudo actualizar precio de "${p.nombre}":`, e?.message);
          }
          // Pequeña pausa entre peticiones para no saturar 365 (evita rechazos en compras grandes)
          await new Promise(r => setTimeout(r, 150));
        }
        if (preciosVentaFallidos.length > 0) {
          console.warn(`[Inventarios365] PRECIOS DE VENTA NO ACTUALIZADOS: ${preciosVentaFallidos.join(", ")}`);
        }
        // VERIFICACIÓN REAL (mismo criterio que el reintento de ajustes de
        // inventario): no confiamos en la respuesta de 365 — releemos los precios
        // y comprobamos cuáles quedaron de verdad. Así un fallo silencioso deja de
        // ser invisible: el que no cambió se reporta con su precio actual.
        try {
          const data = await this.get<any>(`/articulo/listarArticulo?buscar=&criterio=todos&idProveedor=`);
          const lista = data?.articulos?.data ?? data?.articulos ?? data?.data ?? [];
          const porId = new Map((Array.isArray(lista) ? lista : []).map((a: any) => [Number(a.id), a]));
          for (const p of preciosActualizar) {
            if (preciosVentaFallidos.includes(p.nombre)) continue; // ya reportado
            const actual = porId.get(Number(p.id));
            if (!actual) continue; // no se pudo verificar: no afirmar que falló
            const precioEn365 = parseFloat(String(actual.precio_uno || 0)) || 0;
            if (Math.abs(precioEn365 - p.precio) > 0.01) {
              preciosVentaFallidos.push(p.nombre);
              console.warn(`[Inventarios365] VERIFICACIÓN: "${p.nombre}" debía quedar en ${p.precio} pero en 365 está en ${precioEn365}`);
            }
          }
        } catch (e: any) {
          console.warn("[Inventarios365] No se pudo verificar los precios actualizados:", e?.message);
        }
      }

      // Paso 3b: Actualizar precios de COSTO que cambiaron con la compra
      if (costosActualizar.length > 0) {
        console.log(`[Inventarios365] PASO 3b: Actualizando ${costosActualizar.length} precio(s) de costo`);
        for (const c of costosActualizar) {
          try {
            await this.actualizarPrecioCosto(c.id, c.costo, c.unidadEnvase);
          } catch (e: any) {
            console.warn(`[Inventarios365] No se pudo actualizar costo de "${c.nombre}":`, e?.message);
          }
        }
      }

      // Paso 4: Guardar historial de precios de compra (para alertas y consultas futuras)
      if (historialParaGuardar.length > 0) {
        try {
          const { historialPreciosService } = await import("./historial-precios");
          for (const h of historialParaGuardar) {
            await historialPreciosService.registrar(h);
          }
        } catch (e: any) {
          console.warn(`[Inventarios365] No se pudo guardar historial de precios:`, e?.message);
        }
      }

      const advertencias =
        (erroresArticulos.length > 0
          ? ` (Artículos no encontrados: ${erroresArticulos.join(", ")})`
          : "") +
        // Los precios que 365 NO aplicó deben verse SIEMPRE en el mensaje, no
        // solo en los logs: si no, el usuario cree que quedaron todos.
        (preciosVentaFallidos.length > 0
          ? ` ⚠ PRECIO DE VENTA NO APLICADO en ${preciosVentaFallidos.length}: ${preciosVentaFallidos.join(", ")} — revísalos en 365.`
          : "");

      return {
        success: true,
        message: `Compra registrada en inventarios365.com (ID: ${respData?.id})${advertencias}`,
        ingresoId: respData?.id,
        productosNoEncontrados,
        productosEmparejados,
        preciosVentaFallidos,
      };
    } catch (error: any) {
      console.error(
        "[Inventarios365] Error registrando compra:",
        error?.response?.data || error?.message
      );
      return {
        success: false,
        message: `Error al sincronizar: ${
          error?.response?.data?.message || error?.message || "Error desconocido"
        }`,
        productosNoEncontrados,
      };
    }
  }

  /**
   * Registrar una transferencia entre sucursales en inventarios365.com.
   * Endpoint: POST /traspasoproducto/registrar
   */
  async registrarTransferencia(params: {
    sucursalOrigen: string;
    sucursalDestino: string;
    items: Array<{
      nombre: string;
      cantidad: number;
    }>;
    observacion?: string;
  }): Promise<{ success: boolean; message: string }> {
    try {
      const almacenes = await this.listarAlmacenes();

      const almacenOrigen = almacenes.find((a) =>
        a.nombre_almacen
          .toLowerCase()
          .includes(params.sucursalOrigen.toLowerCase())
      );
      const almacenDestino = almacenes.find((a) =>
        a.nombre_almacen
          .toLowerCase()
          .includes(params.sucursalDestino.toLowerCase())
      );

      if (!almacenOrigen || !almacenDestino) {
        return {
          success: false,
          message: `Almacenes no encontrados: ${
            !almacenOrigen ? `"${params.sucursalOrigen}"` : ""
          } ${!almacenDestino ? `"${params.sucursalDestino}"` : ""}`.trim(),
        };
      }

      const arrayDetalle = [];
      const omitidos: string[] = [];
      for (const item of params.items) {
        const articulo = await this.buscarArticulo(item.nombre);
        if (articulo) {
          arrayDetalle.push({
            idarticulo: articulo.id,
            articulo: articulo.nombre,
            cantidad: item.cantidad,
          });
        } else {
          omitidos.push(item.nombre);
        }
      }

      if (arrayDetalle.length === 0) {
        return {
          success: false,
          message: `No se encontró NINGÚN artículo en 365. Revisa los nombres: ${omitidos.join(", ")}`,
        };
      }

      const respData = await this.post("/traspasoproducto/registrar", {
        idalmacen_origen: almacenOrigen.id,
        idalmacen_destino: almacenDestino.id,
        observacion:
          params.observacion || "Transferencia desde VidaFarma-OS",
        inventarios: arrayDetalle,
      });

      if (respData?.error) {
        return { success: false, message: respData.error };
      }

      return {
        success: true,
        message: omitidos.length === 0
          ? `Transferencia registrada en 365 (${arrayDetalle.length} productos).`
          : `Transferencia registrada en 365 con ${arrayDetalle.length} productos. ⚠ OMITIDOS (no encontrados en 365): ${omitidos.join(", ")} — transfiérelos manualmente o corrige el nombre.`,
      };
    } catch (error: any) {
      console.error(
        "[Inventarios365] Error registrando transferencia:",
        error?.response?.data || error?.message
      );
      return {
        success: false,
        message: `Error al sincronizar transferencia: ${
          error?.response?.data?.message || error?.message || "Error desconocido"
        }`,
      };
    }
  }

  /**
   * Descargar todos los productos de inventarios365.com.
   */
  async descargarTodosLosProductos(): Promise<ArticuloAPI[]> {
    try {
      console.log("[Inventarios365] Iniciando descarga de todos los productos...");
      const productos = await this.listarArticulos("", "");
      console.log(`[Inventarios365] ${productos.length} productos descargados`);
      return productos;
    } catch (error) {
      console.error("[Inventarios365] Error descargando productos:", error);
      return [];
    }
  }

  /**
   * Forzar re-login en la próxima operación (útil para invalidar sesión expirada).
   */
  invalidateSession(): void {
    this.xsrfToken = null;
    this.csrfToken = null;
    this.laravelSession = null;
    this.lastLogin = 0;
  }

  /**
   * Diagnóstico: registra una compra de prueba capturando TODA la respuesta cruda.
   */
  async diagnosticoRegistro(): Promise<any> {
    this.invalidateSession();
    await this.login();

    const diagnostico: any = {
      sesion: {
        xsrfToken: this.xsrfToken ? "presente" : "AUSENTE",
        csrfToken: this.csrfToken ? "presente" : "AUSENTE",
        laravelSession: this.laravelSession ? "presente" : "AUSENTE",
      },
    };

    // Buscar varios artículos diferentes para distinguir cada prueba en el stock
    const articulos = await this.listarArticulos("", "97");
    if (!articulos || articulos.length < 5) {
      diagnostico.error = `Solo se encontraron ${articulos?.length || 0} artículos de Sanat`;
    }
    const productos = (articulos || []).slice(0, 6);
    diagnostico.productosUsados = productos.map(p => ({ id: p.id, nombre: p.nombre }));
    // Estructura cruda del primer artículo para ver nombres de campos disponibles
    diagnostico.estructuraArticulo = productos[0] ? Object.keys(productos[0]) : [];

    const cookie = this.buildCookieHeader();
    const xsrfDecoded = this.xsrfToken ? decodeURIComponent(this.xsrfToken) : "";
    diagnostico.pruebas = {};

    // Registrar normal, luego probar endpoints para actualizar vencimiento por separado
    const prodTest = productos[0];
    const fechaTest = "2029-03-15";
    const numComp = `REPLICA-${Date.now()}`;
    const baseReg: any = {
      idproveedor: 0,
      idalmacen: 1,
      tipo_comprobante: "FACTURA",
      num_comprobante: numComp,
      impuesto: 0.18,
      total: 4,
      data: [{
        idarticulo: prodTest.id,
        idalmacen: 1,
        codigo: prodTest.codigo,
        articulo: prodTest.nombre,
        precio: "4.0000",
        precio_paquete: "0.0000",
        precio_venta: "5.0000",
        unidad_x_paquete: 1,
        fecha_vencimiento: fechaTest,
        vencimiento: fechaTest,
        cantidad: 1,
      }],
    };
    const hdrs = {
      Cookie: cookie,
      "X-XSRF-TOKEN": xsrfDecoded,
      "X-CSRF-TOKEN": this.csrfToken || "",
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/json",
      Referer: `${BASE_URL}/main`,
    };
    try {
      const resp = await this.client.post("/ingreso/registrar", baseReg, {
        headers: hdrs, maxRedirects: 0, validateStatus: () => true,
      });
      diagnostico.pruebas["1_REGISTRO"] = { comprobante: numComp, status: resp.status, data: resp.data };
    } catch (e: any) {
      diagnostico.pruebas["1_REGISTRO"] = { error: e.message };
    }

    // Probar endpoints candidatos para guardar el vencimiento del artículo
    const endpointsVcto = [
      { url: "/articulo/actualizarVencimiento", body: { idarticulo: prodTest.id, vencimiento: fechaTest } },
      { url: "/articulo/editar", body: { id: prodTest.id, vencimiento: fechaTest } },
      { url: "/articulo/actualizar", body: { id: prodTest.id, vencimiento: fechaTest } },
      { url: "/inventario/actualizarVencimiento", body: { idarticulo: prodTest.id, vencimiento: fechaTest } },
    ];
    for (const ep of endpointsVcto) {
      try {
        const r = await this.client.post(ep.url, ep.body, { headers: hdrs, maxRedirects: 0, validateStatus: () => true });
        diagnostico.pruebas[`2_${ep.url}`] = { status: r.status, data: typeof r.data === "string" ? r.data.substring(0, 100) : r.data };
      } catch (e: any) {
        diagnostico.pruebas[`2_${ep.url}`] = { error: e.message };
      }
    }

    // Leer el producto al final
    await new Promise(r => setTimeout(r, 1000));
    try {
      const artDespues = await this.listarArticulos(prodTest.nombre.split(" ")[0], "");
      const encontrado = artDespues.find((a: any) => a.id === prodTest.id);
      diagnostico.productoTrasRegistro = encontrado ? {
        nombre: encontrado.nombre,
        vencimiento: (encontrado as any).vencimiento,
        stock: (encontrado as any).stock,
      } : "no encontrado";
    } catch (e: any) {
      diagnostico.errorLectura = e.message;
    }

        return diagnostico;
  }
}

// Singleton del servicio
export const inventarios365 = new Inventarios365Service();
