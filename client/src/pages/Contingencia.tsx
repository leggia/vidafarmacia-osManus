import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { ShieldAlert, Plus, Trash2, CheckCircle2, Search, Loader2, X, ClipboardList } from "lucide-react";
import { useAuth } from "../_core/hooks/useAuth";

const bs = (n: number) => `Bs ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const SUCURSALES = ["Casa Matriz", "Sucursal Petrolera", "Sucursal Lanza", "Casa Matriz Cobol"];
const METODOS = [{ v: "efectivo", t: "Efectivo" }, { v: "qr", t: "QR" }, { v: "tarjeta", t: "Tarjeta" }, { v: "otro", t: "Otro" }];

type Linea = { articuloId: number | null; nombre: string; cantidad: number; precioUnit: number };

/**
 * MODO CONTINGENCIA — si inventarios365 se cae, la venta NO se pierde: cada
 * sucursal la registra aquí (precios desde el cache local) y al volver 365 el
 * cierre asistido permite pasarlas una por una sin perder ninguna.
 */
export default function Contingencia() {
  const { user } = useAuth();
  const esAdmin = user?.role === "admin" || user?.role === "regente";
  const utils = trpc.useUtils();
  const { data: estado } = trpc.contingencia.estado.useQuery(undefined, { refetchInterval: 60000 });

  // ── registro de venta ──
  const [sucursal, setSucursal] = useState<string>("");
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [q, setQ] = useState("");
  const [metodo, setMetodo] = useState("efectivo");
  const [nota, setNota] = useState("");
  const { data: sugerencias, isFetching: buscando } = trpc.contingencia.buscarProducto.useQuery({ q }, { enabled: q.trim().length >= 2 });

  const registrar = trpc.contingencia.registrarVenta.useMutation({
    onSuccess: (r) => {
      toast.success(`Venta guardada (${bs(r.total)}). No se pierde: se pasará a 365 en el cierre.`, { duration: 6000 });
      setLineas([]); setNota(""); setQ("");
      utils.contingencia.estado.invalidate(); utils.contingencia.listar.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // ── mis ventas / cierre ──
  const { data: ventas } = trpc.contingencia.listar.useQuery({ estado: "pendiente" });
  const marcar = trpc.contingencia.marcarRegistrada.useMutation({
    onSuccess: () => { utils.contingencia.listar.invalidate(); utils.contingencia.estado.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const activar = trpc.contingencia.activar.useMutation({
    onSuccess: () => { toast.success("Modo contingencia ACTIVADO"); utils.contingencia.estado.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const desactivar = trpc.contingencia.desactivar.useMutation({
    onSuccess: () => { toast.success("Contingencia finalizada — realiza el cierre de las ventas pendientes"); utils.contingencia.estado.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const total = Math.round(lineas.reduce((s, l) => s + l.cantidad * l.precioUnit, 0) * 100) / 100;

  const agregarProducto = (p: any) => {
    setLineas((prev) => [...prev, { articuloId: p.articuloId || null, nombre: p.nombre, cantidad: 1, precioUnit: p.precio || 0 }]);
    setQ("");
  };

  const guardar = () => {
    if (!sucursal) { toast.error("Elige tu sucursal"); return; }
    if (lineas.length === 0) { toast.error("Agrega al menos un producto"); return; }
    if (lineas.some((l) => l.precioUnit <= 0)) { toast.error("Hay un producto con precio 0 — corrígelo"); return; }
    registrar.mutate({ sucursal, items: lineas, metodoPago: metodo, nota: nota || undefined });
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5">
      <div className="border-b pb-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className={`w-6 h-6 ${estado?.activa ? "text-red-600" : "text-muted-foreground"}`} />
          <h1 className="text-2xl font-black tracking-tight">Ventas de Contingencia</h1>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Cuando inventarios365 falla, registra aquí cada venta — no se pierde nada: al volver el sistema se pasan una por una en el cierre.
        </p>
      </div>

      {/* Estado + control (admin/regente) */}
      <div className={`p-3 rounded-2xl border flex items-center justify-between gap-2 ${estado?.activa ? "bg-red-50 dark:bg-red-950/20 border-red-300" : "bg-muted/40"}`}>
        <div>
          <p className={`text-sm font-black ${estado?.activa ? "text-red-700" : ""}`}>
            {estado?.activa ? "🔴 CONTINGENCIA ACTIVA" : "🟢 Sistema normal"}
          </p>
          {estado?.activa && estado?.motivo && <p className="text-[11px] text-red-600">{estado.motivo}</p>}
          {(estado?.pendientes || 0) > 0 && (
            <p className="text-[11px] font-bold text-amber-700">{estado!.pendientes} venta(s) por pasar a 365 — {bs(estado!.montoPendiente || 0)}</p>
          )}
        </div>
        {esAdmin && (
          estado?.activa ? (
            <button onClick={() => desactivar.mutate()} disabled={desactivar.isPending}
              className="shrink-0 h-9 px-3 rounded-xl bg-emerald-600 text-white text-xs font-black disabled:opacity-50">Finalizar contingencia</button>
          ) : (
            <button onClick={() => { const m = window.prompt("Motivo (ej: 365 caído, sin internet):"); if (m && m.trim().length >= 3) activar.mutate({ motivo: m.trim() }); }}
              disabled={activar.isPending}
              className="shrink-0 h-9 px-3 rounded-xl bg-red-600 text-white text-xs font-black disabled:opacity-50">Activar contingencia</button>
          )
        )}
      </div>

      {/* Formulario de venta */}
      <div className="rounded-2xl border bg-card p-4 space-y-3">
        <p className="text-xs font-black uppercase text-muted-foreground">Registrar venta</p>
        <select value={sucursal} onChange={(e) => setSucursal(e.target.value)} className="w-full h-10 px-3 rounded-xl border text-sm bg-background">
          <option value="">— Elige tu sucursal —</option>
          {SUCURSALES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        {/* Buscador offline */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar producto (funciona sin 365)…"
            className="w-full h-10 pl-9 pr-3 rounded-xl border text-sm bg-background" />
          {buscando && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
          {q.trim().length >= 2 && (sugerencias?.length || 0) > 0 && (
            <div className="absolute z-20 mt-1 w-full bg-white dark:bg-card border rounded-xl shadow-lg max-h-56 overflow-y-auto">
              {sugerencias!.map((p: any) => (
                <button key={p.articuloId} onClick={() => agregarProducto(p)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-muted flex justify-between gap-2">
                  <span className="truncate">{p.nombre}</span>
                  <span className="font-bold shrink-0">{bs(p.precio)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Líneas */}
        {lineas.map((l, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate font-medium">{l.nombre}</span>
            <input type="number" inputMode="numeric" value={l.cantidad} min={1}
              onChange={(e) => setLineas((prev) => prev.map((x, j) => j === i ? { ...x, cantidad: Math.max(1, parseInt(e.target.value) || 1) } : x))}
              className="w-14 h-8 text-center border rounded-lg bg-background" />
            <input type="number" inputMode="decimal" value={l.precioUnit} step="0.1"
              onChange={(e) => setLineas((prev) => prev.map((x, j) => j === i ? { ...x, precioUnit: parseFloat(e.target.value) || 0 } : x))}
              className="w-20 h-8 text-center border rounded-lg bg-background" />
            <span className="w-16 text-right font-bold shrink-0">{bs(l.cantidad * l.precioUnit)}</span>
            <button onClick={() => setLineas((prev) => prev.filter((_, j) => j !== i))} className="shrink-0 text-red-500"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}

        {lineas.length > 0 && (
          <>
            <div className="flex items-center justify-between border-t pt-2">
              <div className="flex gap-1">
                {METODOS.map((m) => (
                  <button key={m.v} onClick={() => setMetodo(m.v)}
                    className={`h-8 px-2.5 rounded-lg text-[11px] font-bold border ${metodo === m.v ? "bg-primary text-primary-foreground" : "bg-background"}`}>{m.t}</button>
                ))}
              </div>
              <p className="text-base font-black">{bs(total)}</p>
            </div>
            <input value={nota} onChange={(e) => setNota(e.target.value)} placeholder="Nota (opcional: cliente, receta…)"
              className="w-full h-9 px-3 rounded-xl border text-xs bg-background" />
            <button onClick={guardar} disabled={registrar.isPending}
              className="w-full h-11 rounded-xl bg-red-600 text-white font-black disabled:opacity-50">
              {registrar.isPending ? "Guardando…" : "Guardar venta de contingencia"}
            </button>
          </>
        )}
      </div>

      {/* Pendientes de pasar a 365 (cierre asistido) */}
      {(ventas?.length || 0) > 0 && (
        <div className="rounded-2xl border bg-card p-4 space-y-2">
          <p className="text-xs font-black uppercase text-muted-foreground flex items-center gap-1.5">
            <ClipboardList className="w-4 h-4" /> Por pasar a 365 ({ventas!.length})
          </p>
          <p className="text-[11px] text-muted-foreground">Cuando 365 vuelva: registra cada venta allá (factura real) y márcala aquí. Así ninguna se pierde ni se duplica.</p>
          {ventas!.map((v: any) => (
            <div key={v.id} className="rounded-xl border p-2.5 text-xs space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-black">{v.fecha} {String(v.hora).slice(0, 5)} · {v.sucursal}</span>
                <span className="font-black">{bs(v.total)}</span>
              </div>
              <p className="text-muted-foreground">
                {(v.items || []).map((i: any) => `${i.cantidad}× ${i.nombre}`).join(" · ")}
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">{v.metodoPago} · {v.usuario}{v.nota ? ` · ${v.nota}` : ""}</span>
                {esAdmin && (
                  <button onClick={() => marcar.mutate({ id: v.id })} disabled={marcar.isPending}
                    className="shrink-0 h-7 px-2.5 rounded-lg bg-emerald-600 text-white text-[11px] font-bold flex items-center gap-1 disabled:opacity-50">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Ya está en 365
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
