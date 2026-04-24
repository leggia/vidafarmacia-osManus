/**
 * Servicio de sincronización con inventarios365.com
 * Utiliza la API REST interna de la plataforma para registrar compras automáticamente.
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
  precio_costo_unid: number;
  precio_costo_paq: number;
  precio_uno: number;
  unidad_envase: number;
  medida: string;
}

// Estructura de almacén devuelto por la API
export interface AlmacenAPI {
  id: number;
  nombre: string;
}

// Estructura de proveedor devuelto por la API
export interface ProveedorAPI {
  id: number;
  nombre: string;
}

class Inventarios365Service {
  private client: AxiosInstance;
  private sessionCookie: string | null = null;
  private lastLogin: number = 0;
  private SESSION_TTL = 30 * 60 * 1000; // 30 minutos

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
  }

  /**
   * Autenticarse en inventarios365.com y obtener la cookie de sesión.
   */
  private async login(): Promise<void> {
    const now = Date.now();
    if (this.sessionCookie && (now - this.lastLogin) < this.SESSION_TTL) {
      return; // Sesión válida
    }

    try {
      // Primero obtener el CSRF token
      const loginPageResp = await axios.get(`${BASE_URL}/login`, {
        headers: { "Accept": "text/html" },
        maxRedirects: 5,
      });

      // Extraer cookies de la respuesta
      const setCookieHeader = loginPageResp.headers["set-cookie"] || [];
      const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      const sessionCookies = cookies.map((c: string) => c.split(";")[0]).join("; ");

      // Extraer CSRF token del HTML
      const csrfMatch = loginPageResp.data.match(/name="_token"\s+value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : "";

      // Hacer login con form data
      const formData = new URLSearchParams();
      formData.append("_token", csrfToken);
      formData.append("usuario", CREDENTIALS.usuario);
      formData.append("password", CREDENTIALS.password);

      const loginResp = await axios.post(`${BASE_URL}/login`, formData.toString(), {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": sessionCookies,
          "Accept": "text/html,application/xhtml+xml",
          "Referer": `${BASE_URL}/login`,
        },
        maxRedirects: 5,
        validateStatus: (status) => status < 500,
      });

      // Recopilar todas las cookies de la sesión
      const allSetCookies = loginResp.headers["set-cookie"] || [];
      const allCookies = Array.isArray(allSetCookies) ? allSetCookies : [allSetCookies];
      const finalCookies = [...cookies, ...allCookies]
        .map((c: string) => c.split(";")[0])
        .join("; ");

      this.sessionCookie = finalCookies;
      this.lastLogin = now;

      // Configurar el cliente con las cookies de sesión
      this.client.defaults.headers.common["Cookie"] = this.sessionCookie;

      console.log("[Inventarios365] Login exitoso");
    } catch (error) {
      console.error("[Inventarios365] Error en login:", error);
      throw new Error("No se pudo autenticar en inventarios365.com");
    }
  }

  /**
   * Buscar un artículo por nombre en inventarios365.com.
   */
  async buscarArticulo(nombre: string): Promise<ArticuloAPI | null> {
    await this.login();
    try {
      const resp = await this.client.get(`/articulo/buscarArticulo?filtro=${encodeURIComponent(nombre)}`);
      const articulos: ArticuloAPI[] = resp.data?.articulos?.data || resp.data?.articulos || [];
      if (articulos.length > 0) {
        return articulos[0];
      }
      return null;
    } catch (error) {
      console.error(`[Inventarios365] Error buscando artículo "${nombre}":`, error);
      return null;
    }
  }

  /**
   * Obtener la lista de almacenes disponibles.
   */
  async listarAlmacenes(): Promise<AlmacenAPI[]> {
    await this.login();
    try {
      const resp = await this.client.get("/almacen/almaceneslista");
      return resp.data?.almacenes || resp.data || [];
    } catch (error) {
      console.error("[Inventarios365] Error listando almacenes:", error);
      return [];
    }
  }

  /**
   * Buscar un proveedor por nombre.
   */
  async buscarProveedor(nombre: string): Promise<ProveedorAPI | null> {
    await this.login();
    try {
      const resp = await this.client.get(`/proveedor/selectProveedor?filtro=${encodeURIComponent(nombre)}`);
      const proveedores: ProveedorAPI[] = resp.data?.proveedores || [];
      if (proveedores.length > 0) {
        return proveedores[0];
      }
      return null;
    } catch (error) {
      console.error(`[Inventarios365] Error buscando proveedor "${nombre}":`, error);
      return null;
    }
  }

  /**
   * Registrar una compra completa en inventarios365.com.
   * Busca automáticamente los IDs de artículos y proveedor.
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
    }>;
    total: number;
  }): Promise<{ success: boolean; message: string; ingresoId?: number }> {
    await this.login();

    try {
      // 1. Obtener almacenes y encontrar el correcto
      const almacenes = await this.listarAlmacenes();
      console.log("[Inventarios365] Almacenes disponibles:", almacenes.map((a: AlmacenAPI) => a.nombre));

      let idalmacen = 1; // Default: almacén principal
      const almacenEncontrado = almacenes.find((a: AlmacenAPI) =>
        a.nombre.toLowerCase().includes("principal") ||
        a.nombre.toLowerCase().includes("central") ||
        a.nombre.toLowerCase() === params.almacenNombre.toLowerCase()
      );
      if (almacenEncontrado) {
        idalmacen = almacenEncontrado.id;
      }

      // 2. Buscar el proveedor
      let idproveedor = 1; // Default
      const proveedor = await this.buscarProveedor(params.proveedor);
      if (proveedor) {
        idproveedor = proveedor.id;
        console.log(`[Inventarios365] Proveedor encontrado: ${proveedor.nombre} (ID: ${proveedor.id})`);
      } else {
        console.warn(`[Inventarios365] Proveedor "${params.proveedor}" no encontrado, usando ID por defecto`);
      }

      // 3. Buscar cada artículo y construir el arrayDetalle
      const arrayDetalle: DetalleCompra[] = [];
      const erroresArticulos: string[] = [];

      for (const item of params.items) {
        const articulo = await this.buscarArticulo(item.nombre);
        if (articulo) {
          arrayDetalle.push({
            idarticulo: articulo.id,
            idalmacen: idalmacen,
            codigo: articulo.codigo,
            articulo: articulo.nombre,
            precio: item.precio ?? articulo.precio_costo_unid,
            precio_paquete: articulo.precio_costo_paq,
            precio_venta: articulo.precio_uno,
            unidad_x_paquete: articulo.unidad_envase,
            fecha_vencimiento: null,
            cantidad: item.cantidad,
          });
          console.log(`[Inventarios365] Artículo "${item.nombre}" → ID ${articulo.id}, cantidad: ${item.cantidad}`);
        } else {
          erroresArticulos.push(item.nombre);
          console.warn(`[Inventarios365] Artículo "${item.nombre}" no encontrado en el sistema`);
        }
      }

      if (arrayDetalle.length === 0) {
        return {
          success: false,
          message: `No se encontró ningún artículo en inventarios365.com. Artículos no encontrados: ${erroresArticulos.join(", ")}`,
        };
      }

      // 4. Calcular el total real basado en los artículos encontrados
      const totalCalculado = arrayDetalle.reduce((sum, item) => sum + (item.precio * item.cantidad), 0);

      // 5. Registrar la compra
      const payload: RegistrarCompraPayload = {
        idproveedor,
        idalmacen,
        tipo_comprobante: params.tipoComprobante || "BOLETA",
        num_comprobante: params.numComprobante,
        impuesto: 0,
        total: params.total || totalCalculado,
        data: arrayDetalle,
      };

      console.log("[Inventarios365] Registrando compra con payload:", JSON.stringify(payload, null, 2));

      const resp = await this.client.post("/ingreso/registrar", payload);

      if (resp.data?.error) {
        return { success: false, message: resp.data.error };
      }

      const advertencias = erroresArticulos.length > 0
        ? ` (Artículos no encontrados: ${erroresArticulos.join(", ")})`
        : "";

      return {
        success: true,
        message: `Compra registrada exitosamente en inventarios365.com${advertencias}`,
        ingresoId: resp.data?.id,
      };
    } catch (error: any) {
      console.error("[Inventarios365] Error registrando compra:", error?.response?.data || error?.message);
      return {
        success: false,
        message: `Error al sincronizar: ${error?.response?.data?.message || error?.message || "Error desconocido"}`,
      };
    }
  }

  /**
   * Registrar una transferencia entre sucursales en inventarios365.com.
   * Usa el endpoint de traspasos.
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
    await this.login();

    try {
      // Obtener almacenes
      const almacenes = await this.listarAlmacenes();

      const almacenOrigen = almacenes.find((a: AlmacenAPI) =>
        a.nombre.toLowerCase().includes(params.sucursalOrigen.toLowerCase())
      );
      const almacenDestino = almacenes.find((a: AlmacenAPI) =>
        a.nombre.toLowerCase().includes(params.sucursalDestino.toLowerCase())
      );

      if (!almacenOrigen || !almacenDestino) {
        return {
          success: false,
          message: `No se encontraron los almacenes: ${!almacenOrigen ? params.sucursalOrigen : ""} ${!almacenDestino ? params.sucursalDestino : ""}`,
        };
      }

      // Buscar artículos
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
        return { success: false, message: "No se encontraron artículos para transferir" };
      }

      // Registrar el traspaso
      const resp = await this.client.post("/traspasoproducto/registrar", {
        idalmacen_origen: almacenOrigen.id,
        idalmacen_destino: almacenDestino.id,
        observacion: params.observacion || "Transferencia desde VidaFarma-OS",
        data: arrayDetalle,
      });

      if (resp.data?.error) {
        return { success: false, message: resp.data.error };
      }

      return {
        success: true,
        message: "Transferencia registrada exitosamente en inventarios365.com",
      };
    } catch (error: any) {
      console.error("[Inventarios365] Error registrando transferencia:", error?.response?.data || error?.message);
      return {
        success: false,
        message: `Error al sincronizar transferencia: ${error?.response?.data?.message || error?.message || "Error desconocido"}`,
      };
    }
  }
}

// Singleton del servicio
export const inventarios365 = new Inventarios365Service();
