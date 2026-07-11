import { useState, useMemo, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ClipboardCheck, Search, Loader2, Check, AlertTriangle,
  Package, TrendingUp, Filter, Save, RotateCcw, ChevronRight,
  Plus, FolderOpen, Building2, CheckCircle2, Clock, Printer, Camera, X,
} from "lucide-react";
import { toast } from "sonner";

interface ConteoItem {
  id: number;
  nombre: string;
  codigo: string;
  stock: number;
  costoUnit: number;
  precioVenta: number;
  valorStock: number;
  clase: string;
  categoria?: string;
  vencimiento?: string | null;
  inventarioId?: number | null;
  fisico: number | null;
}

type Vista = "sesiones" | "nueva" | "proveedores" | "conteo";

export default function Inventario() {
  const [vista, setVista] = useState<Vista>("sesiones");
  const utils = trpc.useUtils();

  const [sesionActiva, setSesionActiva] = useState<any>(null);

  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoTipo, setNuevoTipo] = useState<"anual" | "ciclico_abc">("anual");
  const [nuevoAlmacen, setNuevoAlmacen] = useState<{ id: number; nombre: string } | null>(null);

  const [proveedorFiltro, setProveedorFiltro] = useState("");
  const [proveedoresLista, setProveedoresLista] = useState<any[]>([]);
  const [buscandoProv, setBuscandoProv] = useState(false);
  const [proveedorActivo, setProveedorActivo] = useState<{ id: string; nombre: string } | null>(null);
  const [items, setItems] = useState<ConteoItem[]>([]);
  const [resumen, setResumen] = useState<any>(null);
  const [cargando, setCargando] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [busquedaHistorial, setBusquedaHistorial] = useState("");
  const [filtroEstadoHistorial, setFiltroEstadoHistorial] = useState<"todos" | "completado" | "en_progreso">("todos");
  const [soloDiferencias, setSoloDiferencias] = useState(false);
  const [filtroClase, setFiltroClase] = useState<string | null>(null);
  const [ajustarStock, setAjustarStock] = useState(true);
  // Conteo puntual: caché de productos + búsqueda en vivo multi-palabra
  const [busquedaPuntual, setBusquedaPuntual] = useState("");
  const fotoConteoRef = useRef<HTMLInputElement>(null);
  const [procesandoFoto, setProcesandoFoto] = useState(false);
  const [revisionFoto, setRevisionFoto] = useState<any[] | null>(null);
  const [busquedaManual, setBusquedaManual] = useState<Record<number, string>>({});
  const [corrigiendo, setCorrigiendo] = useState<Record<number, boolean>>({});
  const extraerConteoFoto = trpc.inventario.extraerConteoFoto.useMutation();

  // Comprimir y enviar la foto de la hoja de conteo; abrir modal de revisión
  // Mismo orden que el PDF impreso (alfabético, TODOS los items sin filtrar) con
  // numeración 1..N — es la clave para emparejar por número de fila desde la foto.
  const itemsNumerados = useMemo(() => {
    return [...items].sort((a, b) => a.nombre.localeCompare(b.nombre)).map((it, i) => ({ ...it, numero: i + 1 }));
  }, [items]);

  const procesarFotoConteo = (file: File) => {
    const img = new Image();
    img.onload = async () => {
      const MAX = 1600; // hojas de conteo: más resolución para leer números
      let { width, height } = img;
      if (width > MAX || height > MAX) { const e = MAX / Math.max(width, height); width = Math.round(width*e); height = Math.round(height*e); }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
      const b64 = canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
      URL.revokeObjectURL(img.src);
      setProcesandoFoto(true);
      try {
        const r: any = await extraerConteoFoto.mutateAsync({
          fileBase64: b64, mimeType: "image/jpeg",
          productos: itemsNumerados.map(i => ({ id: i.id, nombre: i.nombre, codigo: i.codigo, stock: i.stock, numero: i.numero })),
        });
        if (r?.error) { toast.error(r.error, { duration: 7000 }); return; }
        setRevisionFoto(r.resultados);
        toast.success(`${r.total} cantidades leídas · ${r.emparejados} emparejadas`);
      } catch (e: any) {
        toast.error(e?.message || "Error procesando la foto");
      } finally {
        setProcesandoFoto(false);
      }
    };
    img.src = URL.createObjectURL(file);
  };

  // Aplicar las cantidades revisadas a la lista de conteo
  const aplicarConteoFoto = () => {
    if (!revisionFoto) return;
    let aplicados = 0;
    setItems(prev => {
      const copia = [...prev];
      for (const r of revisionFoto) {
        const destino = r.elegidoId !== undefined ? r.elegidoId : r.sugerido?.id;
        if (destino == null) continue;
        const idx = copia.findIndex(it => it.id === destino);
        if (idx >= 0) { copia[idx] = { ...copia[idx], fisico: r.cantidad }; aplicados++; }
      }
      return copia;
    });
    toast.success(`${aplicados} cantidad(es) cargada(s) al conteo`);
    setRevisionFoto(null); setBusquedaManual({}); setCorrigiendo({});
  };
  const [cacheProductos, setCacheProductos] = useState<any[]>([]);
  const [cargandoCache, setCargandoCache] = useState(false);

  const esConteoPuntual = proveedorActivo?.nombre === "Conteo puntual";

  // Cargar TODOS los productos del almacén una sola vez (caché para búsqueda instantánea)
  const cargarCacheProductos = useCallback(async () => {
    if (cacheProductos.length > 0 || cargandoCache) return;
    setCargandoCache(true);
    try {
      const res = await utils.inventario.listar.fetch({
        idAlmacen: sesionActiva?.almacenId ?? 1,
        idProveedor: "",
      });
      setCacheProductos(res.productos || []);
    } catch (e: any) {
      toast.error("Error cargando productos: " + (e.message || ""));
    }
    setCargandoCache(false);
  }, [cacheProductos.length, cargandoCache, sesionActiva, utils]);

  // Búsqueda en vivo sobre el caché: todas las palabras deben coincidir (en cualquier orden)
  const resultadosPuntual = useMemo(() => {
    const q = busquedaPuntual.trim().toLowerCase();
    if (q.length < 2) return [];
    const palabras = q.split(/\s+/).filter(Boolean);
    const yaAgregados = new Set(items.map(it => it.id));
    return cacheProductos
      .filter(p => !yaAgregados.has(p.id))
      .filter(p => {
        // Buscar en nombre, código Y proveedor (como en el módulo de Compras).
        // Permite escribir "fluco sanat" para filtrar por producto + proveedor.
        const texto = `${p.nombre} ${p.codigo || ""} ${p.nombreProveedor || ""}`.toLowerCase();
        // cada palabra escrita debe aparecer en el texto (coincidencia parcial)
        return palabras.every(w => texto.includes(w));
      })
      .slice(0, 25);
  }, [busquedaPuntual, cacheProductos, items]);

  const agregarProductoPuntual = (prod: any) => {
    if (items.some(it => it.id === prod.id)) { toast.info("Ya está en la lista"); return; }
    setItems(prev => [...prev, { ...prod, fisico: null }]);
    setBusquedaPuntual("");
    toast.success(`Agregado: ${prod.nombre}`);
  };

  const { data: sesiones, isLoading: cargandoSesiones, error: errorSesiones } = trpc.inventario.listarSesiones.useQuery(undefined, {
    enabled: vista === "sesiones",
  });
  const crearSesion = trpc.inventario.crearSesion.useMutation();
  const guardarConteoProveedor = trpc.inventario.guardarConteoProveedor.useMutation();
  const reintentarAjuste = trpc.inventario.reintentarAjuste.useMutation();
  const [reintentandoId, setReintentandoId] = useState<number | null>(null);
  const reintentarAhora = async (registroId: number) => {
    setReintentandoId(registroId);
    try {
      const r = await reintentarAjuste.mutateAsync({ registroId });
      if (r.ok) toast.success(r.mensaje, { duration: 8000 });
      else toast.error(r.mensaje, { duration: 10000 });
      if (sesionActiva) {
        const detalle = await utils.inventario.detalleSesion.fetch({ sesionId: sesionActiva.id });
        if (detalle) setSesionActiva((prev: any) => ({ ...prev, proveedores: detalle.proveedores }));
      }
    } catch (e: any) {
      toast.error("No se pudo reintentar: " + (e.message || ""), { duration: 8000 });
    } finally {
      setReintentandoId(null);
    }
  };
  const completarSesion = trpc.inventario.completarSesion.useMutation();

  const almacenes = [
    { id: 1, nombre: "ALMACEN PRINCIPAL" },
    { id: 2, nombre: "Almacen Petrolera" },
    { id: 3, nombre: "Almacen Lanza" },
    { id: 4, nombre: "Almacen Cobol" },
  ];

  const handleCrearSesion = async () => {
    if (!nuevoNombre.trim()) { toast.error("Ponle un nombre al inventario"); return; }
    if (!nuevoAlmacen) { toast.error("Elige la sucursal"); return; }
    try {
      const res = await crearSesion.mutateAsync({
        nombre: nuevoNombre.trim(), tipo: nuevoTipo,
        almacenId: nuevoAlmacen.id, almacenNombre: nuevoAlmacen.nombre,
      });
      setSesionActiva({ id: res.id, nombre: nuevoNombre.trim(), tipo: nuevoTipo, almacenId: nuevoAlmacen.id, almacenNombre: nuevoAlmacen.nombre, totalProveedores: res.totalProveedores ?? 0, estado: "en_progreso", proveedores: [] });
      toast.success("Inventario creado");
      setVista("proveedores");
      setNuevoNombre(""); setNuevoAlmacen(null);
      await utils.inventario.listarSesiones.invalidate();
    } catch (e: any) { toast.error("Error: " + (e.message || "")); }
  };

  const abrirSesion = (s: any) => { setSesionActiva(s); setVista("proveedores"); };

  const buscarProveedores = useCallback(async () => {
    setBuscandoProv(true);
    try {
      const provs = await utils.confirmaciones.listarProveedores.fetch({ filtro: proveedorFiltro });
      setProveedoresLista(Array.isArray(provs) ? provs : []);
    } catch { setProveedoresLista([]); }
    setBuscandoProv(false);
  }, [proveedorFiltro, utils]);

  const cargarProductos = useCallback(async (idProveedor: string, nombreProv: string) => {
    setCargando(true);
    setProveedorActivo({ id: idProveedor, nombre: nombreProv });
    setProveedoresLista([]);
    setVista("conteo");
    try {
      const res = await utils.inventario.listar.fetch({
        idAlmacen: sesionActiva?.almacenId ?? 1,
        idProveedor,
      });
      let productos = res.productos.map((p: any) => ({ ...p, fisico: null }));
      const provGuardado = sesionActiva?.proveedores?.find((p: any) => p.proveedorNombre === nombreProv);
      if (provGuardado) {
        try {
          const detalle = await utils.inventario.detalleSesion.fetch({ sesionId: sesionActiva.id });
          const provData = detalle?.proveedores?.find((p: any) => p.proveedorNombre === nombreProv);
          if (provData?.conteos && Array.isArray(provData.conteos)) {
            const previos = new Map(provData.conteos.map((c: any) => [c.articuloId, c.stockFisico]));
            productos = productos.map((p: any) => previos.has(p.id) ? { ...p, fisico: previos.get(p.id) } : p);
            toast.info("Recuperado conteo previo");
          }
        } catch {}
      }
      if (sesionActiva?.tipo === "ciclico_abc") {
        const orden: any = { A: 0, B: 1, C: 2 };
        productos = productos.sort((a: any, b: any) => orden[a.clase] - orden[b.clase]);
      }
      setItems(productos);
      setResumen(res.resumen);
      if (productos.length === 0) toast.info("Este proveedor no tiene productos");
    } catch (e: any) { toast.error("Error cargando productos: " + (e.message || "")); }
    setCargando(false);
  }, [sesionActiva, utils]);

  const setFisico = (id: number, valor: string) => {
    const v = valor === "" ? null : parseInt(valor);
    setItems(prev => prev.map(it => it.id === id ? { ...it, fisico: isNaN(v as any) ? null : v } : it));
  };

  const stats = useMemo(() => {
    const contados = items.filter(i => i.fisico !== null);
    const conDif = contados.filter(i => i.fisico !== i.stock);
    const valorDiferencias = conDif.reduce((acc, i) => acc + ((i.fisico! - i.stock) * i.costoUnit), 0);
    return {
      total: items.length, contados: contados.length,
      pendientes: items.length - contados.length, conDiferencia: conDif.length,
      valorDiferencias: Math.round(valorDiferencias * 100) / 100,
    };
  }, [items]);

  const itemsFiltrados = useMemo(() => {
    let r = items;
    if (busqueda) {
      // Permitir varias palabras en cualquier orden (igual que el módulo de Compras)
      const palabras = busqueda.toLowerCase().trim().split(/\s+/).filter(Boolean);
      r = r.filter(i => {
        const texto = `${i.nombre} ${i.codigo || ""} ${(i as any).nombreProveedor || ""}`.toLowerCase();
        return palabras.every(w => texto.includes(w));
      });
    }
    if (filtroClase) r = r.filter(i => i.clase === filtroClase);
    if (soloDiferencias) r = r.filter(i => i.fisico !== null && i.fisico !== i.stock);
    // Ordenar alfabéticamente A-Z por nombre (igual que el PDF)
    return [...r].sort((a, b) => a.nombre.localeCompare(b.nombre));
  }, [items, busqueda, filtroClase, soloDiferencias]);

  const guardarProveedor = async (completar: boolean) => {
    // Los productos con Físico escrito: van con su cantidad real.
    const contadosExplicitos = items.filter(i => i.fisico !== null).map(i => ({
      articuloId: i.id, nombre: i.nombre, stockSistema: i.stock,
      stockFisico: i.fisico!, diferencia: i.fisico! - i.stock,
      fechaVencimiento: i.vencimiento || null,
      inventarioId: i.inventarioId ?? null,
    }));
    // Al COMPLETAR: los productos que quedaron en blanco se entienden como
    // REVISADOS Y COINCIDENTES con el sistema (el flujo real es contar todo
    // físicamente y solo anotar lo que difiere) — quedan registrados con
    // diferencia 0 para el respaldo/auditoría, y el inventario avanza al 100%.
    // Mientras se sigue contando (guardar borrador), NO se asume esto — solo se
    // guarda lo que ya se marcó, para no dar por completado algo a medio hacer.
    const confirmadosSinCambio = completar
      ? items.filter(i => i.fisico === null).map(i => ({
          articuloId: i.id, nombre: i.nombre, stockSistema: i.stock,
          stockFisico: i.stock, diferencia: 0,
          fechaVencimiento: i.vencimiento || null,
          inventarioId: i.inventarioId ?? null,
        }))
      : [];
    const conteos = [...contadosExplicitos, ...confirmadosSinCambio];
    if (conteos.length === 0) { toast.error("No has contado ningún producto"); return; }

    // Confirmación antes de ajustar el stock real (operación que modifica el inventario)
    const conDif = conteos.filter(c => c.diferencia !== 0).length;
    if (completar && ajustarStock && conDif > 0) {
      const ok = window.confirm(
        `Vas a ajustar el stock real de ${conDif} producto(s) en inventarios365.\n\n` +
        `Esto modificará el inventario del sistema según tu conteo físico. Esta acción queda registrada como "Ajuste periódico".\n\n` +
        `¿Confirmas el ajuste?`
      );
      if (!ok) return;
    }

    try {
      const res = await guardarConteoProveedor.mutateAsync({
        sesionId: sesionActiva.id, proveedorId: proveedorActivo?.id,
        proveedorNombre: proveedorActivo!.nombre, totalProductos: items.length,
        completar, ajustarStock: completar && ajustarStock, conteos,
      });
      if (completar && ajustarStock && res.ajuste) {
        if (res.ajuste.ok) {
          toast.success(`Proveedor completado. ${res.ajuste.ajustados} producto(s) ajustados en el sistema.`, { duration: 6000 });
        } else {
          toast.error(`Tu conteo quedó guardado a salvo, pero el ajuste en 365 falló: ${res.ajuste.mensaje}. Puedes reintentar desde la lista de proveedores sin volver a contar.`, { duration: 10000 });
        }
      } else {
        toast.success(completar ? "Proveedor completado" : "Progreso guardado", { duration: 4000 });
      }
      const detalle = await utils.inventario.detalleSesion.fetch({ sesionId: sesionActiva.id });
      if (detalle) setSesionActiva((prev: any) => ({ ...prev, proveedores: detalle.proveedores }));
      await utils.inventario.listarSesiones.invalidate();
      if (completar) { setVista("proveedores"); setProveedorActivo(null); setItems([]); }
    } catch (e: any) { toast.error("Error: " + (e.message || "")); }
  };

  // Generar hoja de conteo imprimible (PDF vía navegador) — optimizada para tinta y papel
  const imprimirHojaConteo = () => {
    if (items.length === 0) { toast.error("No hay productos para imprimir"); return; }
    const fecha = new Date().toLocaleDateString("es-BO", { day: "2-digit", month: "short", year: "numeric" });
    const proveedor = proveedorActivo?.nombre || "Todos";
    const sucursal = sesionActiva?.almacenNombre || "";
    const nombreSesion = sesionActiva?.nombre || "Inventario";

    // Mismo orden y numeración que se usará para leer la foto de vuelta
    const ordenados = itemsNumerados;
    const totalItems = ordenados.length;

    // Filas: #, ABC, Producto, Sistema, Físico (en blanco)
    const filas = ordenados.map((it) => `
      <tr>
        <td class="num">${it.numero}</td>
        <td class="c">${it.clase}</td>
        <td class="n">${it.nombre}</td>
        <td class="s">${it.stock}</td>
        <td class="f"></td>
      </tr>`).join("");

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Conteo ${proveedor}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 12mm 10mm; color: #000; font-size: 9.5px; }
      /* Encabezado en una sola fila para ahorrar espacio */
      .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px;
        border-bottom: 1.5px solid #000; padding-bottom: 5px; margin-bottom: 8px; }
      .head .t { font-size: 13px; font-weight: 800; letter-spacing: -0.2px; }
      .head .it { font-size: 9.5px; } .head .it b { font-weight: 700; }
      .head .resp { margin-left: auto; font-size: 9px; }
      .head .resp u { text-decoration: none; border-bottom: 1px solid #000; padding: 0 26px; }
      /* Lista en 2 columnas por página para ahorrar hojas */
      .cols { column-count: 2; column-gap: 8mm; }
      table { width: 100%; border-collapse: collapse; }
      thead { display: table-header-group; }
      th { font-size: 8px; text-transform: uppercase; letter-spacing: 0.3px; text-align: left;
        padding: 2px 3px; border-bottom: 1.2px solid #000; font-weight: 700; }
      td { padding: 2.5px 3px; border-bottom: 0.4px solid #bbb; font-size: 9.5px; vertical-align: middle; }
      tr { break-inside: avoid; }
      .num { width: 24px; text-align: center; color: #000; font-size: 9.5px; font-weight: 800; background: #eee; border-radius: 2px; }
      .c { width: 16px; text-align: center; font-weight: 700; color: #000; }
      .n { line-height: 1.15; }
      .s { width: 34px; text-align: center; font-weight: 700; }
      .f { width: 42px; border: 0.8px solid #000; }
      th.thc { text-align: center; }
      .leyenda { font-size: 7.5px; color: #555; margin-top: 8px; column-span: all; }
      @media print {
        body { margin: 10mm 8mm; }
        .noprint { display: none; }
      }
      .btn { background: #15803d; color: #fff; border: none; padding: 10px 18px; border-radius: 6px; font-size: 14px; cursor: pointer; margin: 8px 4px; }
    </style></head><body>
      <div class="noprint" style="text-align:center; margin-bottom:10px;">
        <button class="btn" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
        <button class="btn" style="background:#666" onclick="window.close()">Cerrar</button>
      </div>
      <div class="head">
        <span class="t">${nombreSesion}</span>
        <span class="it"><b>Prov:</b> ${proveedor}</span>
        <span class="it"><b>Suc:</b> ${sucursal}</span>
        <span class="it"><b>Fecha:</b> ${fecha}</span>
        <span class="it"><b>Items:</b> ${ordenados.length}</span>
        <span class="resp">Responsable: <u></u></span>
      </div>
      <div class="cols">
        <table>
          <thead><tr>
            <th class="num">#</th><th>A</th><th>Producto</th><th class="thc">Sis</th><th class="thc">Físico</th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>
        <div class="leyenda">A/B/C = prioridad por valor. Anote en "Físico" TODAS las cantidades contadas (el número "#" de cada fila ayuda a cargar el conteo por foto en la app con más precisión). Luego suba una foto de esta hoja o ingrese las diferencias manualmente.</div>
      </div>
    </body></html>`;

    const win = window.open("", "_blank");
    if (!win) { toast.error("Permite las ventanas emergentes para imprimir"); return; }
    win.document.write(html);
    win.document.close();
    toast.success("Hoja de conteo generada");
  };

  const claseColor = (c: string) =>
    c === "A" ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
    : c === "B" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
    : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

  // Historial siempre accesible: filtro para encontrar una sesión pasada
  // (soporte para revisiones posteriores) sin depender de scrollear todo.
  const sesionesFiltradas = useMemo(() => {
    if (!sesiones) return [];
    let r = sesiones;
    if (busquedaHistorial.trim()) {
      const q = busquedaHistorial.toLowerCase().trim();
      r = r.filter((s: any) => `${s.nombre} ${s.almacenNombre || ""}`.toLowerCase().includes(q));
    }
    if (filtroEstadoHistorial !== "todos") r = r.filter((s: any) => s.estado === filtroEstadoHistorial);
    return r;
  }, [sesiones, busquedaHistorial, filtroEstadoHistorial]);

  // ─── VISTA: Lista de sesiones ──────────────────────────────
  if (vista === "sesiones") {
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3 border-b border-foreground pb-4">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-lg bg-primary/10 flex items-center justify-center">
              <ClipboardCheck className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-black uppercase tracking-tight">Inventario Físico</h1>
              <p className="text-xs text-muted-foreground">Gestión por sucursal y proveedor</p>
            </div>
          </div>
          <Button onClick={() => setVista("nueva")} className="gap-2"><Plus className="h-4 w-4" /> Nuevo</Button>
        </div>

        {(sesiones?.length || 0) > 0 && (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input value={busquedaHistorial} onChange={(e) => setBusquedaHistorial(e.target.value)} placeholder="Buscar en el historial (nombre, sucursal)…" className="h-9 text-xs pl-8" />
            </div>
            <select value={filtroEstadoHistorial} onChange={(e) => setFiltroEstadoHistorial(e.target.value as any)}
              className="h-9 px-2 rounded-lg border text-xs bg-background">
              <option value="todos">Todos</option>
              <option value="completado">Completados</option>
              <option value="en_progreso">En progreso</option>
            </select>
          </div>
        )}

        {cargandoSesiones ? (
          <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>
        ) : errorSesiones ? (
          <div className="text-center py-16 border border-dashed border-red-300 rounded-lg bg-red-50 dark:bg-red-950/10">
            <AlertTriangle className="h-10 w-10 mx-auto text-red-500 mb-3" />
            <p className="text-sm font-bold text-red-700">No se pudieron cargar tus inventarios</p>
            <p className="text-xs text-red-600 mb-4">Esto NO significa que se hayan perdido — es un error al cargar la lista. Intenta de nuevo.</p>
            <Button variant="outline" onClick={() => utils.inventario.listarSesiones.invalidate()} className="gap-2"><RotateCcw className="h-4 w-4" /> Reintentar</Button>
          </div>
        ) : !sesiones || sesiones.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-foreground/20 rounded-lg">
            <FolderOpen className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium">No hay inventarios todavía</p>
            <p className="text-xs text-muted-foreground mb-4">Crea tu primer inventario para empezar</p>
            <Button onClick={() => setVista("nueva")} className="gap-2"><Plus className="h-4 w-4" /> Nuevo inventario</Button>
          </div>
        ) : sesionesFiltradas.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-foreground/20 rounded-lg">
            <Search className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium">Sin resultados para ese filtro</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sesionesFiltradas.map((s: any) => {
              // Progreso sobre el TOTAL de proveedores del sistema
              const totalProv = s.totalProveedores > 0 ? s.totalProveedores : s.proveedoresInventariados;
              const pct = totalProv > 0 ? Math.round((s.proveedoresCompletados / totalProv) * 100) : 0;
              return (
                <button key={s.id} onClick={() => abrirSesion(s)} className="w-full text-left rounded-lg border border-foreground/15 hover:border-primary/50 hover:bg-primary/5 p-4 transition-all">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-bold text-sm truncate">{s.nombre}</span>
                      {s.estado === "completado"
                        ? <span className="text-[10px] px-2 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300 font-medium uppercase shrink-0">Completado</span>
                        : <span className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300 font-medium uppercase shrink-0">En progreso</span>}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground mb-2 flex-wrap">
                    <span className="flex items-center gap-1"><Building2 className="h-3 w-3" /> {s.almacenNombre || "—"}</span>
                    <span className="px-1.5 py-0.5 rounded bg-muted">{s.tipo === "anual" ? "Anual" : "Cíclico ABC"}</span>
                    <span>{s.proveedoresCompletados}/{totalProv} proveedores</span>
                    <span className="font-medium text-primary">{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ─── VISTA: Nueva sesión ──────────────────────────────
  if (vista === "nueva") {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3 border-b border-foreground pb-4">
          <Button variant="ghost" size="icon" onClick={() => setVista("sesiones")}><RotateCcw className="h-5 w-5" /></Button>
          <h1 className="text-xl font-black uppercase tracking-tight">Nuevo Inventario</h1>
        </div>
        <Card>
          <CardContent className="pt-6 space-y-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Nombre del inventario</p>
              <Input value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} placeholder="Ej: Inventario MAYO Suc 1" />
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Tipo de conteo</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button onClick={() => setNuevoTipo("anual")} className={`text-left rounded-lg border-2 p-4 transition-all ${nuevoTipo === "anual" ? "border-primary bg-primary/5" : "border-foreground/15"}`}>
                  <div className="flex items-center gap-2 mb-1"><Package className="h-4 w-4 text-primary" /><span className="font-bold text-sm">Anual</span></div>
                  <p className="text-xs text-muted-foreground">Completo, proveedor por proveedor.</p>
                </button>
                <button onClick={() => setNuevoTipo("ciclico_abc")} className={`text-left rounded-lg border-2 p-4 transition-all ${nuevoTipo === "ciclico_abc" ? "border-primary bg-primary/5" : "border-foreground/15"}`}>
                  <div className="flex items-center gap-2 mb-1"><TrendingUp className="h-4 w-4 text-primary" /><span className="font-bold text-sm">Cíclico ABC</span></div>
                  <p className="text-xs text-muted-foreground">Prioriza alto valor. Cada 3 meses.</p>
                </button>
              </div>
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Sucursal</p>
              <div className="grid grid-cols-2 gap-2">
                {almacenes.map((a) => (
                  <button key={a.id} onClick={() => setNuevoAlmacen(a)} className={`text-left rounded-lg border-2 p-3 transition-all ${nuevoAlmacen?.id === a.id ? "border-primary bg-primary/5" : "border-foreground/15"}`}>
                    <div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-primary" /><span className="text-sm font-medium">{a.nombre}</span></div>
                  </button>
                ))}
              </div>
            </div>
            <Button onClick={handleCrearSesion} disabled={crearSesion.isPending} className="w-full gap-2">
              {crearSesion.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Crear y empezar
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ─── VISTA: Proveedores de la sesión ──────────────────────────────
  if (vista === "proveedores") {
    const provsHechos = sesionActiva?.proveedores || [];
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3 border-b border-foreground pb-4">
          <Button variant="ghost" size="icon" onClick={() => { setVista("sesiones"); setSesionActiva(null); }}><RotateCcw className="h-5 w-5" /></Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-black uppercase tracking-tight truncate">{sesionActiva?.nombre}</h1>
            <p className="text-xs text-muted-foreground flex items-center gap-1"><Building2 className="h-3 w-3" /> {sesionActiva?.almacenNombre} · {sesionActiva?.tipo === "anual" ? "Anual" : "Cíclico ABC"}</p>
          </div>
        </div>

        {/* Progreso global del inventario (sobre todos los proveedores del sistema) */}
        {(() => {
          const totalProv = sesionActiva?.totalProveedores > 0 ? sesionActiva.totalProveedores : provsHechos.length;
          const completados = provsHechos.filter((p: any) => p.estado === "completado").length;
          const pct = totalProv > 0 ? Math.round((completados / totalProv) * 100) : 0;
          return (
            <div className="bg-muted/40 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">Progreso del inventario</span>
                <span className="text-muted-foreground">{completados} de {totalProv} proveedores · <strong className="text-primary">{pct}%</strong></span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })()}

        {provsHechos.length > 0 && (
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Proveedores inventariados</p>
            <div className="space-y-2">
              {provsHechos.map((p: any) => (
                <div key={p.id} className="rounded-lg border border-foreground/15 overflow-hidden">
                  <button onClick={() => cargarProductos(p.proveedorId || "", p.proveedorNombre)} className="w-full flex items-center justify-between gap-2 hover:border-primary/50 p-3 transition-all">
                    <div className="flex items-center gap-2 min-w-0">
                      {p.estado === "completado" ? <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" /> : <Clock className="h-4 w-4 text-amber-600 shrink-0" />}
                      <div className="text-left min-w-0">
                        <p className="text-sm font-medium truncate">{p.proveedorNombre}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {p.productosContados}/{p.totalProductos} contados
                          {p.conDiferencia > 0 && <span className="text-red-600"> · {p.conDiferencia} dif.</span>}
                        </p>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  </button>
                  {/* Contingencia: si el ajuste real en 365 no se aplicó (o quedó ambiguo), avisar y ofrecer reintentar sin perder el conteo */}
                  {(p.ajusteEstado === "fallo" || p.ajusteEstado === "revisar") && (
                    <div className={`px-3 py-2 border-t text-[11px] flex items-center justify-between gap-2 ${p.ajusteEstado === "fallo" ? "bg-red-50 dark:bg-red-950/20" : "bg-amber-50 dark:bg-amber-950/20"}`}>
                      <span className={p.ajusteEstado === "fallo" ? "text-red-700" : "text-amber-700"}>
                        {p.ajusteEstado === "fallo" ? "⚠ El ajuste en 365 no se aplicó" : "⚠ Requiere revisión"} — tu conteo está a salvo.
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); reintentarAhora(p.id); }} disabled={reintentandoId === p.id}
                        className="shrink-0 h-7 px-2.5 rounded-lg bg-white dark:bg-card border font-bold disabled:opacity-50">
                        {reintentandoId === p.id ? "Reintentando…" : "Reintentar"}
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Otras formas de contar</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
            <button
              onClick={() => cargarProductos("", "Inventario completo (ABC)")}
              className="text-left rounded-lg border border-foreground/15 hover:border-primary/50 hover:bg-primary/5 p-3 transition-all"
            >
              <div className="flex items-center gap-2 mb-1"><TrendingUp className="h-4 w-4 text-primary" /><span className="font-bold text-sm">Inventario completo ABC</span></div>
              <p className="text-xs text-muted-foreground">Todos los productos clasificados A, B, C. Filtra por clase para contar primero los de alto valor.</p>
            </button>
            <button
              onClick={() => { setProveedorActivo({ id: "", nombre: "Conteo puntual" }); setItems([]); setBusqueda(""); setBusquedaPuntual(""); setVista("conteo"); cargarCacheProductos(); }}
              className="text-left rounded-lg border border-foreground/15 hover:border-primary/50 hover:bg-primary/5 p-3 transition-all"
            >
              <div className="flex items-center gap-2 mb-1"><Search className="h-4 w-4 text-primary" /><span className="font-bold text-sm">Conteo puntual</span></div>
              <p className="text-xs text-muted-foreground">Busca productos uno por uno y agrégalos. Ideal para contar 5, 10 o más productos específicos.</p>
            </button>
          </div>
        </div>

        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Inventariar otro proveedor</p>
          <div className="flex gap-2">
            <Input value={proveedorFiltro} onChange={(e) => setProveedorFiltro(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") buscarProveedores(); }} placeholder="Buscar proveedor..." className="flex-1" />
            <Button onClick={buscarProveedores} disabled={buscandoProv} className="gap-2">
              {buscandoProv ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Buscar
            </Button>
          </div>
          {proveedoresLista.length > 0 && (
            <div className="mt-2 space-y-1 max-h-60 overflow-y-auto">
              {proveedoresLista.map((prov: any) => (
                <button key={prov.id} onClick={() => cargarProductos(String(prov.id), prov.nombre)} className="w-full flex items-center justify-between bg-muted/40 hover:bg-primary/10 rounded-lg px-3 py-2.5 transition-colors text-left">
                  <span className="text-sm font-medium">{prov.nombre}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>

        {provsHechos.length > 0 && sesionActiva?.estado !== "completado" && (
          <Button variant="outline" className="w-full gap-2" onClick={async () => {
            await completarSesion.mutateAsync({ sesionId: sesionActiva.id });
            toast.success("Inventario marcado como completado");
            await utils.inventario.listarSesiones.invalidate();
            setVista("sesiones"); setSesionActiva(null);
          }}>
            <CheckCircle2 className="h-4 w-4" /> Marcar inventario como completado
          </Button>
        )}
      </div>
    );
  }

  // ─── VISTA: Conteo de un proveedor ──────────────────────────────
  return (
    <div className="space-y-5">
      {cargando ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Cargando productos de {proveedorActivo?.nombre}...</p>
        </div>
      ) : (
        <>
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-foreground/10 -mx-4 px-4 py-3 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <Button variant="ghost" size="sm" onClick={() => { setVista("proveedores"); setProveedorActivo(null); setItems([]); }} className="gap-1 text-xs h-8 shrink-0">
                  <RotateCcw className="h-3 w-3" /> Volver
                </Button>
                <span className="text-sm font-bold truncate">{proveedorActivo?.nombre}</span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={imprimirHojaConteo} className="gap-1 h-8 text-xs" title="Imprimir hoja para conteo manual">
                  <Printer className="h-3 w-3" /> PDF
                </Button>
                <Button variant="outline" size="sm" onClick={() => guardarProveedor(false)} disabled={guardarConteoProveedor.isPending || stats.contados === 0} className="gap-1 h-8 text-xs">
                  <Save className="h-3 w-3" /> Guardar
                </Button>
                <Button size="sm" onClick={() => guardarProveedor(true)} disabled={guardarConteoProveedor.isPending || stats.contados === 0} className="gap-1 h-8 text-xs bg-green-700 hover:bg-green-800 text-white">
                  {guardarConteoProveedor.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Completar
                </Button>
              </div>
            </div>

            {/* Toggle: ajustar stock real en el sistema al completar */}
            <button
              onClick={() => setAjustarStock(!ajustarStock)}
              className={`w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs transition-colors ${ajustarStock ? "bg-green-50 dark:bg-green-950/40 border border-green-300 dark:border-green-800" : "bg-muted/40 border border-foreground/10"}`}
            >
              <span className="flex items-center gap-2">
                <span className={`h-4 w-4 rounded flex items-center justify-center shrink-0 ${ajustarStock ? "bg-green-600 text-white" : "border border-foreground/30"}`}>
                  {ajustarStock && <Check className="h-3 w-3" />}
                </span>
                <span className={ajustarStock ? "text-green-800 dark:text-green-300 font-medium" : "text-muted-foreground"}>
                  Al completar, ajustar el stock real en inventarios365
                </span>
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">{ajustarStock ? "Activado" : "Solo guardar"}</span>
            </button>

            <div className="grid grid-cols-4 gap-2">
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className="text-lg font-black">{stats.contados}<span className="text-xs text-muted-foreground font-normal">/{stats.total}</span></p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Contados</p>
              </div>
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className="text-lg font-black text-amber-600">{stats.pendientes}</p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Pendientes</p>
              </div>
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className={`text-lg font-black ${stats.conDiferencia > 0 ? "text-red-600" : ""}`}>{stats.conDiferencia}</p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Diferencias</p>
              </div>
              <div className="text-center bg-muted/40 rounded-lg py-2">
                <p className={`text-sm font-black ${stats.valorDiferencias < 0 ? "text-red-600" : stats.valorDiferencias > 0 ? "text-green-600" : ""}`}>
                  {stats.valorDiferencias > 0 ? "+" : ""}{stats.valorDiferencias.toFixed(0)}
                </p>
                <p className="text-[10px] uppercase text-muted-foreground tracking-wider">Bs dif.</p>
              </div>
            </div>

            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${stats.total > 0 ? (stats.contados / stats.total) * 100 : 0}%` }} />
            </div>

            {!esConteoPuntual && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[140px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input value={busqueda} onChange={(e) => setBusqueda(e.target.value)} placeholder="Filtrar por nombre, código o proveedor..." className="h-8 text-xs pl-7" />
              </div>
              {["A", "B", "C"].map(c => (
                <button key={c} onClick={() => setFiltroClase(filtroClase === c ? null : c)} className={`text-[11px] px-2.5 py-1 rounded font-bold ${claseColor(c)} ${filtroClase === c ? "ring-2 ring-offset-1 ring-current" : ""}`}>
                  {c} {resumen ? `(${c === "A" ? resumen.claseA : c === "B" ? resumen.claseB : resumen.claseC})` : ""}
                </button>
              ))}
              <button onClick={() => setSoloDiferencias(!soloDiferencias)} className={`text-[11px] px-2.5 py-1 rounded font-medium flex items-center gap-1 ${soloDiferencias ? "bg-red-600 text-white" : "bg-muted text-muted-foreground"}`}>
                <Filter className="h-3 w-3" /> Dif.
              </button>
              <button onClick={() => fotoConteoRef.current?.click()} disabled={procesandoFoto}
                className="text-[11px] px-2.5 py-1 rounded font-bold flex items-center gap-1 bg-emerald-600 text-white disabled:opacity-50">
                {procesandoFoto ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />} Foto conteo
              </button>
            </div>
            )}
          </div>

          {/* Buscador para conteo puntual: búsqueda en vivo sobre caché */}
          {esConteoPuntual && (
            <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-lg p-3 space-y-2">
              <p className="text-xs font-medium text-blue-800 dark:text-blue-300">
                Busca y agrega productos para contar
                {cargandoCache && <span className="text-muted-foreground"> · cargando catálogo...</span>}
                {!cargandoCache && cacheProductos.length > 0 && <span className="text-muted-foreground"> · {cacheProductos.length} productos disponibles</span>}
              </p>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={busquedaPuntual}
                  onChange={(e) => setBusquedaPuntual(e.target.value)}
                  placeholder="Nombre, código o proveedor (ej: amox bago)..."
                  className="h-9 pl-8"
                  autoFocus
                />
                {cargandoCache && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
              </div>
              {busquedaPuntual.trim().length >= 2 && (
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {resultadosPuntual.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-2 text-center">Sin coincidencias</p>
                  ) : resultadosPuntual.map((prod: any) => (
                    <button key={prod.id} onClick={() => agregarProductoPuntual(prod)}
                      className="w-full flex items-center justify-between bg-white dark:bg-gray-900 rounded px-2 py-1.5 border border-gray-200 dark:border-gray-700 hover:border-blue-400 text-left">
                      <span className="text-xs font-medium line-clamp-2 leading-snug flex-1">{prod.nombre}</span>
                      <span className="text-[11px] text-muted-foreground mx-2 shrink-0">stock: {prod.stock}</span>
                      <Plus className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            {itemsFiltrados.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-10">{esConteoPuntual ? "Busca productos arriba para agregarlos al conteo." : "No hay productos que coincidan."}</p>
            ) : itemsFiltrados.map((item) => {
              const dif = item.fisico !== null ? item.fisico - item.stock : null;
              const contado = item.fisico !== null;
              return (
                <div key={item.id} className={`rounded-lg border px-3 py-2.5 transition-colors ${
                  dif !== null && dif !== 0 ? "border-red-300 bg-red-50/50 dark:bg-red-950/20"
                  : contado ? "border-green-300 bg-green-50/50 dark:bg-green-950/20" : "border-foreground/10"
                }`}>
                  {/* Fila 1: clase + NOMBRE COMPLETO (hasta 2 líneas, todo el ancho) */}
                  <div className="flex items-start gap-2 mb-1.5">
                    <span className={`text-[10px] font-black w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5 ${claseColor(item.clase)}`}>{item.clase}</span>
                    <p className="text-sm font-medium leading-snug line-clamp-2 flex-1">{item.nombre}</p>
                  </div>
                  {/* Fila 2: código/costo/vto + sistema + físico + diferencia */}
                  <div className="flex items-center gap-3">
                    <p className="text-[11px] text-muted-foreground flex-1 min-w-0 truncate">Cód: {item.codigo}{item.costoUnit > 0 ? ` · Costo ${item.costoUnit.toFixed(2)} Bs` : ""}{item.vencimiento ? ` · Vto: ${item.vencimiento}` : ""}</p>
                    <div className="text-center shrink-0 w-12">
                      <p className="text-sm font-bold">{item.stock}</p>
                      <p className="text-[9px] uppercase text-muted-foreground">Sistema</p>
                    </div>
                    <div className="shrink-0 w-20">
                      <Input type="number" inputMode="numeric" value={item.fisico ?? ""} onChange={(e) => setFisico(item.id, e.target.value)} placeholder="Físico"
                        className={`h-9 text-center text-sm font-bold ${dif !== null && dif !== 0 ? "border-red-400" : contado ? "border-green-400" : ""}`} />
                    </div>
                    <div className="text-center shrink-0 w-10">
                      {dif !== null ? (dif === 0 ? <Check className="h-4 w-4 text-green-600 mx-auto" /> : <span className={`text-sm font-black ${dif < 0 ? "text-red-600" : "text-blue-600"}`}>{dif > 0 ? "+" : ""}{dif}</span>) : <span className="text-xs text-muted-foreground">—</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Input de foto oculto (cámara o galería del celular) */}
          <input ref={fotoConteoRef} type="file" accept="image/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) procesarFotoConteo(f); e.target.value = ""; }} />

          {/* Modal de revisión del conteo leído por foto */}
          {revisionFoto && (
            <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => setRevisionFoto(null)}>
              <div className="bg-white dark:bg-card rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b">
                  <div>
                    <h3 className="font-black">Revisar conteo de la foto</h3>
                    <p className="text-[11px] text-muted-foreground">Verifica el producto y la cantidad antes de cargar. Corrige lo que haga falta.</p>
                  </div>
                  <button onClick={() => setRevisionFoto(null)} className="p-1"><X className="h-5 w-5" /></button>
                </div>
                {/* Encabezado de columnas — refleja el mismo orden de la hoja impresa (#, Producto, Sistema, Físico) */}
                <div className="flex items-center gap-2 px-4 py-1.5 border-b bg-muted/50 text-[9px] font-bold text-muted-foreground uppercase">
                  <span className="w-7 shrink-0">#</span>
                  <span className="flex-1">Producto</span>
                  <span className="w-14 text-center shrink-0">Sistema</span>
                  <span className="w-14 text-center shrink-0">Físico</span>
                  <span className="w-8 shrink-0"></span>
                </div>
                <div className="overflow-y-auto p-3 space-y-2 flex-1">
                  {revisionFoto.map((r: any, idx: number) => {
                    const destino = r.elegidoId !== undefined ? r.elegidoId : (r.sugerido?.id ?? null);
                    const prodElegido = destino != null ? itemsNumerados.find(p => p.id === destino) : null;
                    const abierto = !!corrigiendo[idx];
                    const buscando = busquedaManual[idx] || "";
                    const resultadosManual = buscando.trim().length >= 2
                      ? itemsNumerados.filter(p => p.nombre.toLowerCase().includes(buscando.toLowerCase())).slice(0, 8)
                      : [];
                    return (
                      <div key={idx} className={`rounded-lg border p-2 ${destino ? "border-green-300 bg-green-50/40 dark:bg-green-950/10" : "border-red-300 bg-red-50/40 dark:bg-red-950/10"}`}>
                        {/* Fila estilo "como la hoja impresa": # · Nombre · Sistema · Físico */}
                        <div className="flex items-center gap-2">
                          {r.numeroLeido != null ? (
                            <span className={`text-[10px] font-black shrink-0 px-1.5 py-0.5 rounded text-white ${r.numeroSospechoso ? "bg-amber-600 line-through decoration-2" : "bg-gray-800"}`}
                              title={r.numeroSospechoso ? "Este número no encaja en la secuencia con sus filas vecinas — probablemente mal leído, no se usó para identificar el producto" : "Número de fila leído en la hoja impresa"}>#{r.numeroLeido}</span>
                          ) : (
                            <span className="text-[10px] font-bold shrink-0 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700" title="No se pudo leer el número de fila">#?</span>
                          )}
                          <div className="min-w-0 flex-1">
                            {prodElegido ? (
                              <p className="text-sm font-black leading-tight truncate">{prodElegido.nombre}</p>
                            ) : (
                              <p className="text-sm font-black leading-tight text-red-600 truncate">Sin coincidencia</p>
                            )}
                            <p className="text-[10px] text-muted-foreground truncate">leído: "{r.textoLeido}"</p>
                          </div>
                          {/* Sistema: leído en la foto vs. el valor REAL que ya conocemos */}
                          <div className="text-center shrink-0 w-14">
                            <p className="text-[9px] text-muted-foreground uppercase">Sistema</p>
                            <p className={`text-xs font-bold ${prodElegido && r.sistemaLeido != null && r.sistemaLeido !== prodElegido.stock ? "text-amber-600" : ""}`}>
                              {r.sistemaLeido ?? "—"}{prodElegido && r.sistemaLeido != null && r.sistemaLeido !== prodElegido.stock && <span className="block text-[8px]">real: {prodElegido.stock}</span>}
                            </p>
                          </div>
                          <div className="text-center shrink-0">
                            <p className="text-[9px] text-muted-foreground uppercase">Físico</p>
                            <input type="number" inputMode="numeric" value={r.cantidad}
                              onChange={(e) => setRevisionFoto(prev => prev!.map((x, i) => i === idx ? { ...x, cantidad: parseInt(e.target.value) || 0 } : x))}
                              className="w-14 h-8 text-center text-sm font-bold border rounded-lg bg-white dark:bg-background" />
                          </div>
                          <button type="button" onClick={() => setCorrigiendo(prev => ({ ...prev, [idx]: !prev[idx] }))}
                            className="h-8 w-8 shrink-0 rounded-lg bg-muted flex items-center justify-center" title="Corregir producto">
                            ✏️
                          </button>
                        </div>
                        {/* Señales que coincidieron (triangulación): más señales = más confianza */}
                        {r.señales && r.señales.length > 0 && (
                          <p className="text-[9px] text-muted-foreground mt-1 pl-6">
                            ✓ coincide por: {r.señales.join(", ")}
                            {r.señales.length >= 2 && <span className="text-emerald-700 font-bold"> (doble verificación)</span>}
                          </p>
                        )}

                        {/* Corrección (oculta por defecto): candidatos cercanos + búsqueda manual */}
                        {abierto && (
                          <div className="mt-2 pt-2 border-t space-y-1.5">
                            {r.candidatos && r.candidatos.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {r.candidatos.map((c: any) => (
                                  <button key={c.id} type="button"
                                    onClick={() => { setRevisionFoto(prev => prev!.map((x, i) => i === idx ? { ...x, elegidoId: c.id } : x)); setCorrigiendo(prev => ({ ...prev, [idx]: false })); }}
                                    className={`text-[10px] px-2 py-1 rounded-full border font-bold active:scale-95 ${c.id === destino ? "bg-emerald-600 text-white border-emerald-600" : "bg-white dark:bg-background text-gray-700 border-gray-300"}`}>
                                    {c.nombre.length > 32 ? c.nombre.slice(0, 32) + "…" : c.nombre} {c.stock != null ? `(Sist: ${c.stock})` : ""}
                                  </button>
                                ))}
                              </div>
                            )}
                            <input type="text" value={buscando} placeholder="🔍 Buscar otro producto por nombre…"
                              onChange={(e) => setBusquedaManual(prev => ({ ...prev, [idx]: e.target.value }))}
                              className="w-full h-7 text-[11px] border rounded-lg px-2 bg-white dark:bg-background" />
                            {resultadosManual.length > 0 && (
                              <div className="max-h-28 overflow-y-auto border rounded-lg divide-y">
                                {resultadosManual.map(p => (
                                  <button key={p.id} type="button"
                                    onClick={() => { setRevisionFoto(prev => prev!.map((x, i) => i === idx ? { ...x, elegidoId: p.id } : x)); setBusquedaManual(prev => ({ ...prev, [idx]: "" })); setCorrigiendo(prev => ({ ...prev, [idx]: false })); }}
                                    className="w-full text-left px-2 py-1.5 text-[11px] hover:bg-emerald-50 flex justify-between gap-2">
                                    <span className="truncate">#{p.numero} {p.nombre}</span>
                                    <span className="text-muted-foreground shrink-0">Sist: {p.stock}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                            <button type="button" onClick={() => { setRevisionFoto(prev => prev!.map((x, i) => i === idx ? { ...x, elegidoId: null } : x)); }}
                              className="text-[10px] text-red-600 font-bold">No cargar esta fila</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="p-3 border-t flex gap-2">
                  <button onClick={() => setRevisionFoto(null)} className="flex-1 h-11 rounded-xl bg-muted font-bold text-sm">Cancelar</button>
                  <button onClick={aplicarConteoFoto} className="flex-[2] h-11 rounded-xl bg-emerald-600 text-white font-bold text-sm">
                    Cargar cantidades al conteo
                  </button>
                </div>
              </div>
            </div>
          )}

          {stats.conDiferencia > 0 && (
            <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded-lg p-3 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <span className="text-amber-800 dark:text-amber-300">
                <strong>{stats.conDiferencia}</strong> producto(s) con diferencia. Valor: <strong>{stats.valorDiferencias.toFixed(2)} Bs</strong>.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
