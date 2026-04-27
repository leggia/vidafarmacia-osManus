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
  precio: number;
  precio_paquete: number;
  precio_venta: number;
  unidad_x_paquete: number;
  fecha_vencimiento: string | null;
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
    // URL-decode el XSRF-TOKEN para el header
    const xsrfDecoded = this.xsrfToken
      ? decodeURIComponent(this.xsrfToken)
      : "";
    const resp = await this.client.post<T>(path, payload, {
      headers: {
        Cookie: cookie,
        "X-XSRF-TOKEN": xsrfDecoded,
        "Content-Type": "application/json",
        Referer: `${BASE_URL}/main`,
      },
    });
    return resp.data;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Métodos públicos
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Buscar un artículo por nombre o código en inventarios365.com.
   * Endpoint: GET /articulo/buscarArticulo?filtro=<nombre>
   */
  async buscarArticulo(nombre: string): Promise<ArticuloAPI | null> {
    try {
      const data = await this.get<{ articulos: ArticuloAPI[] }>(
        `/articulo/buscarArticulo?filtro=${encodeURIComponent(nombre)}`
      );
      const articulos: ArticuloAPI[] = data?.articulos || [];
      return articulos.length > 0 ? articulos[0] : null;
    } catch (error) {
      console.error(`[Inventarios365] Error buscando artículo "${nombre}":`, error);
      return null;
    }
  }

  /**
   * Listar artículos con búsqueda opcional.
   * Endpoint: GET /articulo/listarArticulo?buscar=&criterio=todos&idProveedor=
   */
  async listarArticulos(buscar = ""): Promise<ArticuloAPI[]> {
    try {
      const data = await this.get<{ articulos: ArticuloAPI[] | { data: ArticuloAPI[] } }>(
        `/articulo/listarArticulo?buscar=${encodeURIComponent(buscar)}&criterio=todos&idProveedor=`
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
      const data = await this.get<{ proveedores: ProveedorAPI[] }>(
        `/proveedor/selectProveedor?filtro=${encodeURIComponent(nombre)}`
      );
      const proveedores: ProveedorAPI[] = data?.proveedores || [];
      return proveedores.length > 0 ? proveedores[0] : null;
    } catch (error) {
      console.error(`[Inventarios365] Error buscando proveedor "${nombre}":`, error);
      return null;
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
    }>;
    total: number;
  }): Promise<{ success: boolean; message: string; ingresoId?: number }> {
    try {
      // 1. Obtener almacenes y encontrar el correcto
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
      let idproveedor = 1;
      const proveedor = await this.buscarProveedor(params.proveedor);
      if (proveedor) {
        idproveedor = proveedor.id;
        console.log(
          `[Inventarios365] Proveedor: ${proveedor.nombre} (ID: ${idproveedor})`
        );
      } else {
        console.warn(
          `[Inventarios365] Proveedor "${params.proveedor}" no encontrado, usando ID 1`
        );
      }

      // 3. Buscar cada artículo y construir el arrayDetalle
      const arrayDetalle: DetalleCompra[] = [];
      const erroresArticulos: string[] = [];

      for (const item of params.items) {
        const articulo = await this.buscarArticulo(item.nombre);
        if (articulo) {
          const precioCosto =
            item.precio ?? parseFloat(String(articulo.precio_costo_unid)) ?? 0;
          arrayDetalle.push({
            idarticulo: articulo.id,
            idalmacen,
            codigo: articulo.codigo,
            articulo: articulo.nombre,
            precio: precioCosto,
            precio_paquete: parseFloat(String(articulo.precio_costo_paq)) ?? 0,
            precio_venta: parseFloat(String(articulo.precio_uno)) ?? 0,
            unidad_x_paquete: articulo.unidad_envase ?? 1,
            fecha_vencimiento: item.fechaVencimiento ?? null,
            cantidad: item.cantidad,
          });
          console.log(
            `[Inventarios365] ✓ "${item.nombre}" → ID ${articulo.id}, cant: ${item.cantidad}`
          );
        } else {
          erroresArticulos.push(item.nombre);
          console.warn(
            `[Inventarios365] ✗ Artículo "${item.nombre}" no encontrado`
          );
        }
      }

      if (arrayDetalle.length === 0) {
        return {
          success: false,
          message: `No se encontró ningún artículo en inventarios365.com. No encontrados: ${erroresArticulos.join(", ")}`,
        };
      }

      // 4. Calcular total si no se proporcionó
      const totalFinal =
        params.total > 0
          ? params.total
          : arrayDetalle.reduce(
              (sum, d) => sum + d.precio * d.cantidad,
              0
            );

      // 5. Registrar la compra
      const payload: RegistrarCompraPayload = {
        idproveedor,
        idalmacen,
        tipo_comprobante: params.tipoComprobante || "BOLETA",
        num_comprobante: params.numComprobante,
        impuesto: 0,
        total: totalFinal,
        data: arrayDetalle,
      };

      console.log(
        "[Inventarios365] POST /ingreso/registrar →",
        JSON.stringify(payload, null, 2)
      );

      const respData = await this.post<{ id?: number; error?: string }>(
        "/ingreso/registrar",
        payload
      );

      if (respData?.error) {
        return { success: false, message: respData.error };
      }

      const advertencias =
        erroresArticulos.length > 0
          ? ` (Artículos no encontrados: ${erroresArticulos.join(", ")})`
          : "";

      return {
        success: true,
        message: `Compra registrada en inventarios365.com (ID: ${respData?.id})${advertencias}`,
        ingresoId: respData?.id,
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
        data: arrayDetalle,
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
   * Forzar re-login en la próxima operación (útil para invalidar sesión expirada).
   */
  invalidateSession(): void {
    this.xsrfToken = null;
    this.laravelSession = null;
    this.lastLogin = 0;
  }
}

// Singleton del servicio
export const inventarios365 = new Inventarios365Service();
