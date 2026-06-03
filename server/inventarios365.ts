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
const CREDENTIALS = {
  usuario: "superadmin",
  password: "superadmin",
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
  nombre_categoria?: string;
  nombre_proveedor?: string;
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
   * Actualizar el precio de venta de un producto.
   * Endpoint: POST /articulo/actualizarPrecioVenta con { id, precio_uno }
   */
  async actualizarPrecioVenta(idarticulo: number, precioUno: number): Promise<boolean> {
    try {
      const respData = await this.post<any>("/articulo/actualizarPrecioVenta", {
        id: idarticulo,
        precio_uno: precioUno,
      });
      console.log(`[Inventarios365] Precio actualizado: artículo ${idarticulo} → ${precioUno} Bs`, JSON.stringify(respData).substring(0, 100));
      return true;
    } catch (error: any) {
      console.error(`[Inventarios365] Error actualizando precio del artículo ${idarticulo}:`, error?.message);
      return false;
    }
  }

  /**
   * Crear un producto nuevo. POST /articulo/registrar (multipart form-data)
   */
  async crearProducto(params: {
    nombre: string;
    codigo: string;
    descripcion?: string;
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
      form.append("nombre_generico", "");
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
    try {
      // Generar términos de búsqueda progresivamente más cortos
      const terminos = this.extractSearchTerms(nombre);
      const intentos = [nombre, ...terminos].slice(0, 5);

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
      const productosNoEncontrados: { nombre: string; nombreLimpio?: string; cantidad: number; precio?: number; sugerencia?: any }[] = [];
      const productosEmparejados: { nombreFactura: string; nombreSistema: string; id: number }[] = [];
      const preciosActualizar: { id: number; precio: number; nombre: string }[] = [];
      const historialParaGuardar: Array<{ articuloId: number; articuloNombre: string; proveedor?: string; costoUnitario: number; precioVenta?: number; numComprobante?: string }> = [];

      for (const item of params.items) {
        // Buscar con filtro de proveedor si existe, sino buscar en todo el inventario
        const articulo = await this.buscarArticulo(item.nombre, idproveedor, params.proveedor);
        const score = articulo ? ((articulo as any)._score ?? 1.0) : 0;
        console.log(`[Fecha] "${item.nombre}" → fechaVencimiento recibida: ${JSON.stringify(item.fechaVencimiento)}`);
        const nombreLimpio = item.nombre.replace(/^\d+\s+/, "").trim();

        // Con filtro de proveedor: threshold 0.50 (resultados ya son del proveedor correcto)
        // Sin filtro de proveedor: threshold 0.80 (más estricto para evitar falsos positivos)
        const threshold = idproveedor ? 0.50 : 0.80;

        if (articulo && score >= threshold) {
          const precioCosto =
            item.precio ?? parseFloat(String(articulo.precio_costo_unid)) ?? 0;
          arrayDetalle.push({
            idarticulo: articulo.id,
            idalmacen,
            codigo: articulo.codigo,
            articulo: articulo.nombre,
            precio: String(precioCosto.toFixed(4)),
            precio_paquete: String((parseFloat(String(articulo.precio_costo_paq || 0)) || 0).toFixed(4)),
            precio_venta: String((parseFloat(String(articulo.precio_uno || 0)) || 0).toFixed(4)),
            unidad_x_paquete: articulo.unidad_envase ?? 1,
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
      if (preciosActualizar.length > 0) {
        console.log(`[Inventarios365] PASO 3: Actualizando ${preciosActualizar.length} precio(s) de venta`);
        for (const p of preciosActualizar) {
          try {
            await this.actualizarPrecioVenta(p.id, p.precio);
          } catch (e: any) {
            console.warn(`[Inventarios365] No se pudo actualizar precio de "${p.nombre}":`, e?.message);
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
        erroresArticulos.length > 0
          ? ` (Artículos no encontrados: ${erroresArticulos.join(", ")})`
          : "";

      return {
        success: true,
        message: `Compra registrada en inventarios365.com (ID: ${respData?.id})${advertencias}`,
        ingresoId: respData?.id,
        productosNoEncontrados,
        productosEmparejados,
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
      for (const item of params.items) {
        const articulo = await this.buscarArticulo(item.nombre);
        if (articulo) {
          arrayDetalle.push({
            idarticulo: articulo.id,
            articulo: articulo.nombre,
            cantidad: item.cantidad,
          });
        }
      }

      if (arrayDetalle.length === 0) {
        return {
          success: false,
          message: "No se encontraron artículos para transferir",
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
        message: "Transferencia registrada exitosamente en inventarios365.com",
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
