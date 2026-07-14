import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import {
  TrendingUp, RefreshCw, Loader2, Package, Building2, Calendar,
  ShoppingCart, Award, Coins, Percent, ChevronDown, ChevronUp, ArrowUpRight, Users,
} from "lucide-react";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, ResponsiveContainer, Cell } from "recharts";

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const DIAS_CORTO = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function rangoMes(offset: number) {
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth() + offset, 1);
  const fin = offset === 0 ? hoy : new Date(hoy.getFullYear(), hoy.getMonth() + offset + 1, 0);
  return { desde: ymd(ini), hasta: ymd(fin) };
}

export default function Reportes() {
  const [periodo, setPeriodo] = useState<"actual" | "anterior" | "custom">("actual");
  const r0 = rangoMes(0);
  const [desde, setDesde] = useState(r0.desde);
  const [hasta, setHasta] = useState(r0.hasta);
  const [sucursal, setSucursal] = useState<string>("");
  const [showCustom, setShowCustom] = useState(false);

  const utils = trpc.useUtils();
  const estado = trpc.ventas.estado.useQuery();
  const sucursales = trpc.ventas.sucursalesDisponibles.useQuery();
  const reportes = trpc.ventas.reportes.useQuery({ desde, hasta, sucursal: sucursal || undefined });
  const rentabilidad = trpc.ventas.rentabilidad.useQuery({ desde, hasta, sucursal: sucursal || undefined });
  // Rentabilidad real por sucursal: SIEMPRE mensual (sueldos, luz, alquiler son mensuales)
  const [mesRentabilidad, setMesRentabilidad] = useState(() => {
    const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}`;
  });
  const rentSucursal = trpc.ventas.rentabilidadPorSucursal.useQuery(
    { anioMes: mesRentabilidad },
    { placeholderData: (prev) => prev }
  );
  // Compras realizadas del mes (usa el mismo selector de mes que la rentabilidad)
  const comprasMes = trpc.ventas.comprasDelMes.useQuery({ anioMes: mesRentabilidad });

  function seleccionarPeriodo(p: "actual" | "anterior") {
    setPeriodo(p);
    setShowCustom(false);
    const r = rangoMes(p === "actual" ? 0 : -1);
    setDesde(r.desde); setHasta(r.hasta);
  }

  const rellenarHuecos = trpc.ventas.rellenarHuecos.useMutation({
    onSuccess: (d: any) => {
      if ((d?.rescatadas ?? 0) > 0) toast.success(`${d.rescatadas} ventas recuperadas de días faltantes`);
      utils.ventas.estado.invalidate();
      utils.ventas.reportes.invalidate();
      utils.ventas.rentabilidad.invalidate();
    },
  });

  const sincronizar = trpc.ventas.sincronizar.useMutation({
    onSuccess: (d: any) => {
      if ((d?.nuevas ?? 0) > 0) toast.success(`${d.nuevas} ventas nuevas`);
      else toast.success("Ya está al día");
      utils.ventas.estado.invalidate();
      utils.ventas.reportes.invalidate();
      utils.ventas.rentabilidad.invalidate();
      // Tras sincronizar, rescatar cualquier día reciente que haya quedado sin traer
      rellenarHuecos.mutate({ dias: 10 });
    },
    onError: (e) => toast.error(e.message),
  });

  // Diagnóstico de completitud del mes + rescate (ventas faltantes / sin detalle)
  // Tendencias y alertas proactivas (semana vs semana + serie 6 meses)
  const [verTendencias, setVerTendencias] = useState(false);
  const tendencias = trpc.ventas.tendencias.useQuery();

  const [verDiagnostico, setVerDiagnostico] = useState(false);
  const anioMesActual = new Date().toISOString().slice(0, 7);
  const diagnostico = trpc.ventas.diagnosticoMes.useQuery({ anioMes: anioMesActual }, { enabled: verDiagnostico });
  const resincMes = trpc.ventas.resincronizarMes.useMutation({
    onSuccess: (d: any) => {
      toast.success(d.rescatadas > 0 ? `${d.rescatadas} venta(s) rescatada(s) de 365` : "No faltaba ninguna venta del mes");
      diagnostico.refetch();
      utils.ventas.estado.invalidate(); utils.ventas.reportes.invalidate(); utils.ventas.rentabilidad.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const repararDetalles = trpc.ventas.repararDetalles.useMutation({
    onSuccess: (d: any) => {
      toast.success(`${d.reparadas} venta(s) reparada(s)${d.pendientes > 0 ? ` · ${d.pendientes} pendientes (repite)` : ""}`);
      diagnostico.refetch();
      utils.ventas.reportes.invalidate(); utils.ventas.rentabilidad.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [histProgreso, setHistProgreso] = useState<string>("");
  const cargarHistorico = trpc.ventas.cargarHistoricoLote.useMutation({
    onSuccess: (d: any) => {
      setHistProgreso(d.mensaje);
      utils.ventas.estado.invalidate();
      utils.ventas.reportes.invalidate();
      utils.ventas.rentabilidad.invalidate();
      if (d.terminado) toast.success("Histórico completo");
      else if (!d.enRango) toast.info("Avanzando hacia el mes anterior, sigue presionando");
      else toast.success(`+${d.guardadas} ventas del histórico`);
    },
    onError: (e) => toast.error(e.message),
  });

  const d = reportes.data;
  const rent = rentabilidad.data;
  const fmtBs = (n: any) => Number(n || 0).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtNum = (n: any) => Number(n || 0).toLocaleString("es-BO");
  const cargando = reportes.isLoading || rentabilidad.isLoading;
  const sinDatos = !d || (d.totales?.ventas ?? 0) === 0;

  // Máximo para escalar barras del top de productos
  const maxUnidades = useMemo(() => Math.max(1, ...(d?.masVendidos ?? []).map((p: any) => Number(p.unidades))), [d]);
  const [vistaProductos, setVistaProductos] = useState<"cantidad" | "valor">("cantidad");
  const [clienteAbierto, setClienteAbierto] = useState<number | null>(null);
  const productosCliente = trpc.ventas.productosCliente.useQuery(
    { idCliente: clienteAbierto ?? 0, desde, hasta },
    { enabled: clienteAbierto !== null }
  );
  const listaProductos = vistaProductos === "cantidad" ? (d?.masVendidos ?? []) : ((d as any)?.masVendidosValor ?? []);
  const maxProducto = useMemo(() => {
    const campo = vistaProductos === "cantidad" ? "unidades" : "monto";
    return Math.max(1, ...listaProductos.map((p: any) => Number(p[campo])));
  }, [listaProductos, vistaProductos]);

  const margenGlobal = rent?.resumen && Number(rent.resumen.ingreso) > 0
    ? (Number(rent.resumen.ganancia) / Number(rent.resumen.ingreso) * 100) : 0;

  return (
    <div className="min-h-full bg-gradient-to-b from-muted/30 to-transparent">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">

        {/* ─── Cabecera ─── */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-black tracking-tight leading-none">Reportes de ventas</h1>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {estado.data?.totalVentas ?? 0} ventas guardadas
                  {estado.data?.ultimaSync && ` · actualizado ${new Date(estado.data.ultimaSync).toLocaleDateString("es-BO")}`}
                </p>
              </div>
            </div>
          </div>
          <button
            onClick={() => sincronizar.mutate()} disabled={sincronizar.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary text-primary-foreground px-3.5 py-2 text-xs font-semibold shadow-sm hover:opacity-90 disabled:opacity-50 transition">
            {sincronizar.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Actualizar
          </button>
        </div>

        {/* ─── Tendencias y alertas proactivas ─── */}
        <div className="rounded-xl border bg-card p-3">
          <button onClick={() => setVerTendencias(!verTendencias)} className="w-full flex items-center justify-between text-xs font-bold">
            <span>📈 Tendencias y alertas {tendencias.data?.resumen?.hayAlertas && !verTendencias && <span className="text-red-600">(¡hay avisos!)</span>}</span>
            <span className="text-muted-foreground">{verTendencias ? "▲" : "▼"}</span>
          </button>
          {verTendencias && (
            <div className="mt-3 space-y-3 text-xs">
              {tendencias.isLoading ? <p className="text-muted-foreground">Comparando semanas…</p> : tendencias.data && !("error" in tendencias.data) ? (
                <>
                  {tendencias.data.resumen.mensajes.map((m: string, i: number) => (
                    <p key={i} className="p-2 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 text-red-700 font-bold">⚠ {m}</p>
                  ))}
                  {!tendencias.data.resumen.hayAlertas && (
                    <p className="text-emerald-700 font-bold">✓ Sin caídas ni subidas fuera de lo normal esta semana.</p>
                  )}
                  <div>
                    <p className="font-bold text-muted-foreground mb-1">Esta semana vs. la anterior, por sucursal</p>
                    <div className="space-y-1">
                      {tendencias.data.semana.porSucursal.map((s: any) => (
                        <div key={s.sucursal} className="flex items-center justify-between">
                          <span>{s.sucursal}</span>
                          <span className={`font-bold ${s.direccion === "bajo" ? "text-red-600" : s.direccion === "subio" ? "text-emerald-700" : "text-muted-foreground"}`}>
                            Bs {s.montoActual.toLocaleString("es-BO")} {s.cambioPct != null && `(${s.cambioPct > 0 ? "+" : ""}${s.cambioPct}%)`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="font-bold text-muted-foreground mb-1">Últimos 6 meses (total farmacia)</p>
                    <ResponsiveContainer width="100%" height={140}>
                      <BarChart data={tendencias.data.historicoMensual.map((m: any) => ({ mes: m.anioMes.slice(5), monto: m.monto }))}>
                        <XAxis dataKey="mes" tick={{ fontSize: 10 }} />
                        <Bar dataKey="monto" radius={[4, 4, 0, 0]} fill="#0ea5e9" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : <p className="text-red-600">No se pudo calcular.</p>}
            </div>
          )}
        </div>

        {/* ─── Diagnóstico de completitud de datos (ventas faltantes / sin detalle) ─── */}
        <div className="rounded-xl border bg-card p-3">
          <button onClick={() => setVerDiagnostico(!verDiagnostico)} className="w-full flex items-center justify-between text-xs font-bold">
            <span>🔎 Verificar datos del mes (¿está todo lo vendido?)</span>
            <span className="text-muted-foreground">{verDiagnostico ? "▲" : "▼"}</span>
          </button>
          {verDiagnostico && (
            <div className="mt-3 space-y-2 text-xs">
              {diagnostico.isLoading ? <p className="text-muted-foreground">Analizando…</p> : diagnostico.data && !("error" in diagnostico.data) ? (
                <>
                  <p><b>{diagnostico.data.totalVentas}</b> ventas del mes en la base local · Bs {diagnostico.data.montoTotal.toLocaleString("es-BO")}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {diagnostico.data.porSucursal.map((s: any) => (
                      <span key={s.sucursal} className="px-2 py-0.5 rounded-full bg-muted text-[11px]">{s.sucursal}: {s.ventas} ventas</span>
                    ))}
                  </div>
                  {diagnostico.data.ventasSinDetalle > 0 && (
                    <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 flex items-center justify-between gap-2">
                      <span className="text-amber-800">⚠ {diagnostico.data.ventasSinDetalle} venta(s) sin el detalle de productos — los reportes por producto/proveedor quedan incompletos</span>
                      <button onClick={() => repararDetalles.mutate()} disabled={repararDetalles.isPending}
                        className="shrink-0 h-7 px-2.5 rounded-lg bg-amber-600 text-white font-bold disabled:opacity-50">{repararDetalles.isPending ? "Reparando…" : "Reparar"}</button>
                    </div>
                  )}
                  {diagnostico.data.diasSinVenta.length > 0 && (
                    <p className="text-red-600">⚠ Días del mes sin ninguna venta registrada: {diagnostico.data.diasSinVenta.map((d: string) => d.slice(8)).join(", ")} — posible hueco de sincronización.</p>
                  )}
                  <button onClick={() => resincMes.mutate({ anioMes: anioMesActual })} disabled={resincMes.isPending}
                    className="w-full h-9 rounded-xl bg-primary text-primary-foreground font-bold disabled:opacity-50">
                    {resincMes.isPending ? "Rescatando ventas faltantes de 365…" : "Resincronizar el mes completo desde 365"}
                  </button>
                  {diagnostico.data.ventasSinDetalle === 0 && diagnostico.data.diasSinVenta.length === 0 && (
                    <p className="text-emerald-700 font-bold">✓ Sin señales de datos faltantes este mes.</p>
                  )}
                </>
              ) : <p className="text-red-600">No se pudo analizar.</p>}
            </div>
          )}
        </div>

        {/* ─── Selector de periodo ─── */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex rounded-lg border bg-card p-0.5 shadow-sm">
            <button onClick={() => seleccionarPeriodo("actual")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${periodo === "actual" && !showCustom ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              Este mes
            </button>
            <button onClick={() => seleccionarPeriodo("anterior")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${periodo === "anterior" && !showCustom ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              Mes anterior
            </button>
            <button onClick={() => { setShowCustom(!showCustom); setPeriodo("custom"); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition inline-flex items-center gap-1 ${showCustom ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              <Calendar className="h-3 w-3" /> Personalizado <ChevronDown className="h-3 w-3" />
            </button>
          </div>
          {/* Filtro de sucursal */}
          {(sucursales.data?.length ?? 0) > 0 && (
            <select value={sucursal} onChange={(e) => setSucursal(e.target.value)}
              className="text-xs rounded-lg border bg-card px-3 py-1.5 shadow-sm font-medium">
              <option value="">Todas las sucursales</option>
              {sucursales.data!.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
        </div>

        {/* Rango personalizado desplegable */}
        {showCustom && (
          <div className="flex items-end gap-2 flex-wrap bg-card border rounded-lg p-3 shadow-sm">
            <div>
              <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Desde</label>
              <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="block h-8 text-xs rounded-md border px-2 mt-0.5" />
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Hasta</label>
              <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="block h-8 text-xs rounded-md border px-2 mt-0.5" />
            </div>
          </div>
        )}

        {cargando ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
            <p className="text-xs text-muted-foreground">Calculando reportes…</p>
          </div>
        ) : sinDatos ? (
          <div className="text-center py-20 bg-card rounded-2xl border border-dashed">
            <ShoppingCart className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
            <p className="text-sm font-medium">No hay ventas en este periodo</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">Usa "Actualizar" para traer las ventas recientes, o carga el histórico del mes anterior abajo.</p>
          </div>
        ) : (
          <>
            {/* ─── KPIs principales ─── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <KpiCard label="Ventas" valor={fmtNum(d.totales.ventas)} icon={<ShoppingCart className="h-4 w-4" />} tono="neutral" />
              <KpiCard label="Ingreso total" valor={`Bs ${fmtBs(d.totales.monto)}`} icon={<Coins className="h-4 w-4" />} tono="primary" />
              {rent?.resumen && Number(rent.resumen.ganancia) > 0 ? (
                <>
                  <KpiCard label="Ganancia est." valor={`Bs ${fmtBs(rent.resumen.ganancia)}`} icon={<ArrowUpRight className="h-4 w-4" />} tono="success" />
                  <KpiCard label="Margen global" valor={`${margenGlobal.toFixed(1)}%`} icon={<Percent className="h-4 w-4" />} tono="info" />
                </>
              ) : (
                <>
                  <KpiCard label="Ticket promedio" valor={`Bs ${fmtBs(d.totales.promedio)}`} icon={<TrendingUp className="h-4 w-4" />} tono="info" />
                  <KpiCard label="Productos" valor={fmtNum(d.masVendidos.length)} icon={<Package className="h-4 w-4" />} tono="neutral" />
                </>
              )}
            </div>

            {/* ─── Grid principal de 2 columnas ─── */}
            <div className="grid lg:grid-cols-2 gap-4">

              {/* Productos más vendidos con barras (por cantidad o valor) */}
              <Panel titulo="Productos más vendidos" icon={<Package className="h-4 w-4" />}>
                <div className="inline-flex rounded-lg border bg-card p-0.5 shadow-sm mb-3">
                  <button onClick={() => setVistaProductos("cantidad")}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition ${vistaProductos === "cantidad" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                    Por cantidad
                  </button>
                  <button onClick={() => setVistaProductos("valor")}
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition ${vistaProductos === "valor" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                    Por valor (Bs)
                  </button>
                </div>
                <div className="space-y-2.5">
                  {listaProductos.slice(0, 8).map((p: any, i: number) => {
                    const valor = vistaProductos === "cantidad" ? Number(p.unidades) : Number(p.monto);
                    return (
                      <div key={i}>
                        <div className="flex items-center justify-between gap-2 text-xs mb-1">
                          <span className="truncate font-medium">{p.articuloNombre}</span>
                          <span className="font-bold tabular-nums shrink-0">
                            {vistaProductos === "cantidad" ? `${fmtNum(p.unidades)} u.` : `Bs ${fmtBs(p.monto)}`}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-primary/70" style={{ width: `${valor / maxProducto * 100}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Panel>

              {/* Productos que más ganancia generaron */}
              {(rent?.masGanancia?.length ?? 0) > 0 ? (
                <Panel titulo="Mayor ganancia generada" icon={<Coins className="h-4 w-4 text-emerald-600" />} acento="emerald">
                  <div className="space-y-2">
                    {rent!.masGanancia.slice(0, 8).map((p: any, i: number) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="w-4 text-right text-muted-foreground tabular-nums">{i + 1}</span>
                          <span className="truncate font-medium">{p.articuloNombre}</span>
                        </span>
                        <span className="font-bold text-emerald-600 tabular-nums shrink-0">+{fmtBs(p.ganancia)}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              ) : (
                <Panel titulo="Mejores vendedores" icon={<Award className="h-4 w-4" />}>
                  <div className="space-y-2">
                    {d.vendedores.slice(0, 8).map((v: any, i: number) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2">
                          <span className={`w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold ${i === 0 ? "bg-amber-400 text-amber-950" : i === 1 ? "bg-slate-300 text-slate-700" : i === 2 ? "bg-orange-300 text-orange-900" : "bg-muted text-muted-foreground"}`}>{i + 1}</span>
                          <span className="font-medium">{v.vendedor || "—"}</span>
                        </span>
                        <span className="font-bold tabular-nums">Bs {fmtBs(v.monto)}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </div>

            {/* ─── Segunda fila ─── */}
            <div className="grid lg:grid-cols-2 gap-4">
              {/* Mayor margen */}
              {(rent?.mayorMargen?.length ?? 0) > 0 && (
                <Panel titulo="Mayor margen de ganancia" icon={<Percent className="h-4 w-4 text-blue-600" />} acento="blue">
                  <div className="space-y-2">
                    {rent!.mayorMargen.slice(0, 8).map((p: any, i: number) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="w-4 text-right text-muted-foreground tabular-nums">{i + 1}</span>
                          <span className="truncate font-medium">{p.articuloNombre}</span>
                        </span>
                        <span className="font-bold text-blue-600 tabular-nums shrink-0">{Number(p.margenPct).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {/* Mejores vendedores (si ganancia ocupó la col anterior) */}
              {(rent?.masGanancia?.length ?? 0) > 0 && (
                <Panel titulo="Mejores vendedores" icon={<Award className="h-4 w-4" />}>
                  <div className="space-y-2">
                    {d.vendedores.slice(0, 8).map((v: any, i: number) => (
                      <div key={i} className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2">
                          <span className={`w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold ${i === 0 ? "bg-amber-400 text-amber-950" : i === 1 ? "bg-slate-300 text-slate-700" : i === 2 ? "bg-orange-300 text-orange-900" : "bg-muted text-muted-foreground"}`}>{i + 1}</span>
                          <span className="font-medium">{v.vendedor || "—"}</span>
                        </span>
                        <span className="font-bold tabular-nums">Bs {fmtBs(v.monto)}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </div>

            {/* ─── Ventas por día (gráfica ancha) ─── */}
            <Panel titulo="Ventas por día de la semana" icon={<Calendar className="h-4 w-4" />}>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={DIAS.map((_, idx) => {
                  const row = d.diasSemana.find((x: any) => Number(x.diaSemana) === idx);
                  return { dia: DIAS_CORTO[idx], monto: row ? Number(row.monto) : 0 };
                })} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                  <XAxis dataKey="dia" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Bar dataKey="monto" radius={[6, 6, 0, 0]}>
                    {DIAS.map((_, idx) => <Cell key={idx} fill={idx === 0 || idx === 6 ? "#f59e0b" : "hsl(var(--primary))"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            {/* ─── Sucursales ─── */}
            {d.sucursales.length > 1 && (
              <Panel titulo="Desempeño por sucursal" icon={<Building2 className="h-4 w-4" />}>
                <div className="grid sm:grid-cols-2 gap-2">
                  {d.sucursales.map((s: any, i: number) => (
                    <div key={i} className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
                      <span className="text-xs font-medium truncate">{s.nombreSucursal || "—"}</span>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-bold tabular-nums">Bs {fmtBs(s.monto)}</p>
                        <p className="text-[10px] text-muted-foreground">{fmtNum(s.ventas)} ventas</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Panel>
            )}

            {/* ─── Mejores clientes (más Bs pagados en el periodo) ─── */}
            {(d.mejoresClientes?.length ?? 0) > 0 && (
              <Panel titulo="Mejores clientes" icon={<Users className="h-4 w-4" />}>
                <div className="space-y-1.5">
                  {d.mejoresClientes.map((c: any, i: number) => {
                    const idCliente = Number(c.idCliente);
                    const abierto = clienteAbierto === idCliente;
                    return (
                      <div key={idCliente} className="rounded-lg border overflow-hidden">
                        <button
                          onClick={() => setClienteAbierto(abierto ? null : idCliente)}
                          className="w-full flex items-center justify-between gap-2 text-xs px-2.5 py-2 hover:bg-muted/40 transition"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <span className={`w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold shrink-0 ${i === 0 ? "bg-amber-400 text-amber-950" : i === 1 ? "bg-slate-300 text-slate-700" : i === 2 ? "bg-orange-300 text-orange-900" : "bg-muted text-muted-foreground"}`}>{i + 1}</span>
                            <span className="font-medium truncate">{c.razonSocialCliente || "—"}</span>
                          </span>
                          <span className="flex items-center gap-2 shrink-0">
                            <span className="text-[10px] text-muted-foreground">{fmtNum(c.ventas)} compras</span>
                            <span className="font-bold tabular-nums">Bs {fmtBs(c.monto)}</span>
                            {abierto ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                          </span>
                        </button>
                        {abierto && (
                          <div className="border-t bg-muted/20 px-2.5 py-2">
                            {productosCliente.isLoading ? (
                              <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1">
                                <Loader2 className="h-3 w-3 animate-spin" /> Cargando productos...
                              </div>
                            ) : (productosCliente.data?.productos?.length ?? 0) === 0 ? (
                              <p className="text-[11px] text-muted-foreground py-1">Sin productos en este periodo.</p>
                            ) : (
                              <div className="space-y-1">
                                {productosCliente.data!.productos.map((p: any, j: number) => (
                                  <div key={j} className="flex items-center justify-between gap-2 text-[11px]">
                                    <span className="truncate">{p.articuloNombre}</span>
                                    <span className="flex items-center gap-2 shrink-0 text-muted-foreground">
                                      <span>{fmtNum(p.unidades)} un.</span>
                                      <span className="font-semibold text-foreground tabular-nums">Bs {fmtBs(p.monto)}</span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Panel>
            )}

            {/* ─── Rentabilidad REAL por sucursal (¿cubre los gastos?) ─── */}
            {(rentSucursal.data?.sucursales?.length ?? 0) > 0 && (
              <Panel titulo="Rentabilidad real por sucursal" icon={<Coins className="h-4 w-4 text-emerald-600" />}>
                <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
                  <p className="text-[11px] text-muted-foreground">Ingresos − costo de productos − sueldos − gastos. Reporte <strong>mensual</strong>.</p>
                  <div className="flex items-center gap-2">
                    {rentSucursal.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                    <input type="month" value={mesRentabilidad} onChange={(e) => setMesRentabilidad(e.target.value)}
                      className="text-xs rounded-lg border bg-card px-2 py-1 shadow-sm font-medium" />
                  </div>
                </div>
                <div className="space-y-3">
                  {rentSucursal.data!.sucursales.map((s: any, i: number) => {
                    const maxAbs = Math.max(...rentSucursal.data!.sucursales.map((x: any) => Math.abs(x.ingreso)), 1);
                    return (
                      <div key={i} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-sm font-bold flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5" /> {s.sucursal}
                          </span>
                          <span className={`text-xs font-black px-2 py-0.5 rounded-full ${s.cubreGastos ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40" : "bg-red-100 text-red-700 dark:bg-red-950/40"}`}>
                            {s.cubreGastos ? "Rentable" : "En pérdida"}
                          </span>
                        </div>
                        {/* Desglose */}
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                          <div className="flex justify-between"><span className="text-muted-foreground">Ingresos</span><span className="font-semibold tabular-nums">Bs {fmtBs(s.ingreso)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">− Costo prod.</span><span className="tabular-nums">Bs {fmtBs(s.costo)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">− Sueldos</span><span className="tabular-nums">Bs {fmtBs(s.sueldos)}</span></div>
                          <div className="flex justify-between"><span className="text-muted-foreground">− Gastos</span><span className="tabular-nums">Bs {fmtBs(s.gastos)}</span></div>
                        </div>
                        {/* Ganancia neta */}
                        <div className="flex items-center justify-between mt-2 pt-2 border-t">
                          <span className="text-xs font-bold">Ganancia neta</span>
                          <span className={`text-sm font-black tabular-nums ${s.netaAntesGenerales >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                            {s.netaAntesGenerales >= 0 ? "+" : ""}{fmtBs(s.netaAntesGenerales)} Bs
                          </span>
                        </div>
                        {/* Confiabilidad: % de lo vendido con costo conocido */}
                        {s.coberturaCosto != null && s.coberturaCosto < 90 && (
                          <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-400">
                            ⚠ Solo {s.coberturaCosto}% de lo vendido tiene costo conocido; la ganancia real es menor.
                          </p>
                        )}
                        {/* Barra visual: ganancia vs ingreso */}
                        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={`h-full rounded-full ${s.netaAntesGenerales >= 0 ? "bg-emerald-500" : "bg-red-500"}`}
                            style={{ width: `${Math.min(100, Math.abs(s.netaAntesGenerales) / maxAbs * 100)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                {(rentSucursal.data?.gastosGenerales ?? 0) > 0 && (
                  <div className="mt-3 flex items-center justify-between text-[11px] bg-amber-50 dark:bg-amber-950/20 rounded-lg px-3 py-2">
                    <span className="text-muted-foreground">Gastos generales (sin sucursal asignada)</span>
                    <span className="font-bold tabular-nums text-amber-700">Bs {fmtBs(rentSucursal.data!.gastosGenerales)}</span>
                  </div>
                )}
                {(rentSucursal.data?.gastosNoCancelados?.length ?? 0) > 0 && (
                  <div className="mt-3 bg-red-50 dark:bg-red-950/20 rounded-lg px-3 py-2">
                    <p className="text-[11px] font-semibold text-red-700 dark:text-red-400 mb-1">⚠ Gastos NO cancelados este mes</p>
                    <div className="space-y-1">
                      {rentSucursal.data!.gastosNoCancelados!.map((g: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-[11px]">
                          <span className="text-muted-foreground">{g.nombre} <span className="opacity-60">({g.sucursal})</span></span>
                          <span className="font-bold tabular-nums text-red-700 dark:text-red-400">Bs {fmtBs(g.monto)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground mt-2">El costo de productos solo considera los que tienen costo conocido. Para mayor precisión, mantén actualizado el cache de productos.</p>
              </Panel>
            )}

            {/* ─── Compras realizadas del mes ─── */}
            {(comprasMes.data?.cantidad ?? 0) > 0 && (
              <Panel titulo="Compras realizadas del mes" icon={<ShoppingCart className="h-4 w-4 text-blue-600" />}>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[11px] text-muted-foreground">{comprasMes.data!.cantidad} compra{comprasMes.data!.cantidad !== 1 ? "s" : ""} registrada{comprasMes.data!.cantidad !== 1 ? "s" : ""}</p>
                  <span className="text-sm font-black tabular-nums text-blue-700">Total: Bs {fmtBs(comprasMes.data!.total)}</span>
                </div>

                {/* Por proveedor */}
                {(comprasMes.data?.proveedores?.length ?? 0) > 0 && (
                  <div className="mb-3">
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Por proveedor</p>
                    <div className="space-y-1">
                      {comprasMes.data!.proveedores.slice(0, 6).map((pr: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="truncate">{pr.nombre}</span>
                          <span className="font-semibold tabular-nums shrink-0">Bs {fmtBs(pr.monto)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Lista de compras */}
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Cada factura del mes (mayor a menor) · toca para ver productos</p>
                <div className="space-y-1 max-h-96 overflow-auto pr-1">
                  {comprasMes.data!.compras.map((c: any) => (
                    <ComprasMesFila key={c.id} compra={c} fmtBs={fmtBs} />
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">Compras registradas y sincronizadas en este mes. El total es lo invertido en inventario.</p>
              </Panel>
            )}
          </>
        )}

        {/* ─── Carga histórica (discreta, al final) ─── */}
        <div className="rounded-xl border border-dashed bg-muted/20 p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <p className="text-xs font-semibold flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" /> Cargar histórico (mes anterior)</p>
            <p className="text-[10px] text-muted-foreground">{histProgreso || "Trae las ventas pasadas por lotes. Presiona hasta \"completo\"."}</p>
          </div>
          <button disabled={cargarHistorico.isPending}
            onClick={() => cargarHistorico.mutate(rangoMes(-1))}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-xs font-medium shadow-sm hover:bg-muted disabled:opacity-50 transition shrink-0">
            {cargarHistorico.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Cargar lote
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Componentes ───
function KpiCard({ label, valor, icon, tono }: { label: string; valor: string; icon: React.ReactNode; tono: "neutral" | "primary" | "success" | "info" }) {
  const tonos: Record<string, string> = {
    neutral: "text-foreground",
    primary: "text-primary",
    success: "text-emerald-600",
    info: "text-blue-600",
  };
  const bgs: Record<string, string> = {
    neutral: "bg-muted text-muted-foreground",
    primary: "bg-primary/10 text-primary",
    success: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40",
    info: "bg-blue-100 text-blue-600 dark:bg-blue-950/40",
  };
  return (
    <div className="rounded-xl border bg-card p-3.5 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className={`h-7 w-7 rounded-lg grid place-items-center ${bgs[tono]}`}>{icon}</span>
      </div>
      <p className={`text-xl font-black tabular-nums leading-none ${tonos[tono]}`}>{valor}</p>
    </div>
  );
}

function Panel({ titulo, icon, children, acento }: { titulo: string; icon: React.ReactNode; children: React.ReactNode; acento?: "emerald" | "blue" }) {
  const borde = acento === "emerald" ? "border-emerald-200/60 dark:border-emerald-900/40" : acento === "blue" ? "border-blue-200/60 dark:border-blue-900/40" : "";
  return (
    <div className={`rounded-xl border bg-card p-4 shadow-sm ${borde}`}>
      <div className="flex items-center gap-2 mb-3 text-sm font-bold">{icon} {titulo}</div>
      {children}
    </div>
  );
}

// Fila de compra del mes con detalle expandible (factura completa)
function ComprasMesFila({ compra, fmtBs }: { compra: any; fmtBs: (n: any) => string }) {
  const [abierto, setAbierto] = useState(false);
  const detalle = trpc.purchases.getById.useQuery({ id: compra.id }, { enabled: abierto });

  return (
    <div className="bg-muted/30 rounded-md overflow-hidden">
      <button onClick={() => setAbierto(!abierto)} className="w-full flex items-center justify-between gap-2 text-xs px-2.5 py-1.5 hover:bg-muted/50 transition">
        <div className="min-w-0 flex-1 text-left">
          <p className="font-medium truncate flex items-center gap-1">
            {compra.receiptNumber || `Compra #${compra.id}`}
            {compra.posibleDuplicado && <span className="text-[8px] px-1 rounded bg-amber-100 text-amber-700 font-bold shrink-0">POSIBLE DUPLICADO</span>}
          </p>
          <p className="text-[10px] text-muted-foreground truncate">
            {compra.supplier || "Sin proveedor"}{compra.branchName ? ` · ${compra.branchName}` : ""} · {new Date(compra.createdAt).toLocaleDateString("es-BO")}
          </p>
        </div>
        <span className="font-bold tabular-nums shrink-0">Bs {fmtBs(compra.totalAmount)}</span>
        {abierto ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {abierto && (
        <div className="px-2.5 pb-2 pt-1 border-t border-border/50">
          {detalle.isLoading ? (
            <p className="text-[10px] text-muted-foreground py-1">Cargando detalle...</p>
          ) : detalle.data?.items?.length ? (
            <div className="space-y-1">
              {detalle.data.items.map((it: any, i: number) => (
                <div key={i} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate flex-1">{it.productName}</span>
                  <span className="tabular-nums text-muted-foreground shrink-0">{fmtBs(it.quantity)} × {fmtBs(it.unitCost)}</span>
                  <span className="tabular-nums font-semibold shrink-0 w-20 text-right">Bs {fmtBs(it.subtotal)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground py-1">Sin detalle de productos.</p>
          )}
        </div>
      )}
    </div>
  );
}
