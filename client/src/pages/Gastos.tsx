import { useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  Wallet, Plus, Check, Loader2, Trash2, Home, Zap,
  Wrench, Package, CalendarDays, Building2, Pencil,
} from "lucide-react";
import { toast } from "sonner";

const CATEGORIAS = [
  { id: "alquiler", label: "Alquiler", icon: Home, color: "text-purple-600" },
  { id: "servicios", label: "Servicios (luz, agua, internet)", icon: Zap, color: "text-amber-600" },
  { id: "mantenimiento", label: "Mantenimiento", icon: Wrench, color: "text-blue-600" },
  { id: "insumos", label: "Insumos / equipo", icon: Package, color: "text-teal-600" },
  { id: "otros", label: "Otros", icon: Wallet, color: "text-slate-600" },
];
const catInfo = (id: string) => CATEGORIAS.find((c) => c.id === id) || CATEGORIAS[4];

function mesActual() { const h = new Date(); return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, "0")}`; }

export default function Gastos() {
  const [anioMes, setAnioMes] = useState(mesActual());
  const [sucursal, setSucursal] = useState<string>("");
  const [showNuevoFijo, setShowNuevoFijo] = useState(false);
  const [showNuevoOcasional, setShowNuevoOcasional] = useState(false);

  const utils = trpc.useUtils();
  const sucursales = trpc.ventas.sucursalesDisponibles.useQuery();
  const gastosMes = trpc.gastos.delMes.useQuery({ anioMes, sucursal: sucursal || undefined });
  const sueldos = trpc.gastos.sueldosDelMes.useQuery({ anioMes, sucursal: sucursal || undefined });

  const fmtBs = (n: any) => Number(n || 0).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const marcarPago = trpc.gastos.marcarPago.useMutation({
    onMutate: async (nuevo) => {
      await utils.gastos.delMes.cancel();
      const previo = utils.gastos.delMes.getData({ anioMes, sucursal: sucursal || undefined });
      if (previo) {
        utils.gastos.delMes.setData({ anioMes, sucursal: sucursal || undefined }, {
          ...previo,
          gastos: previo.gastos.map((g: any) => g.id === nuevo.id ? { ...g, pagado: nuevo.pagado ? 1 : 0 } : g),
        });
      }
      return { previo };
    },
    onError: (e, _v, ctx) => { if (ctx?.previo) utils.gastos.delMes.setData({ anioMes, sucursal: sucursal || undefined }, ctx.previo); toast.error(e.message); },
    onSettled: () => utils.gastos.delMes.invalidate(),
  });

  const cambiarFecha = trpc.gastos.cambiarFechaPago.useMutation({
    onSuccess: () => { utils.gastos.delMes.invalidate(); toast.success("Fecha actualizada"); },
    onError: (e) => toast.error(e.message),
  });

  const eliminar = trpc.gastos.eliminar.useMutation({
    onSuccess: () => { utils.gastos.delMes.invalidate(); toast.success("Gasto eliminado"); },
    onError: (e) => toast.error(e.message),
  });
  const editar = trpc.gastos.editar.useMutation({
    onSuccess: () => { utils.gastos.delMes.invalidate(); toast.success("Gasto actualizado"); },
    onError: (e) => toast.error(e.message),
  });

  const data = gastosMes.data;
  const gastos = data?.gastos ?? [];
  const fijos = gastos.filter((g: any) => !g.esOcasional);
  const ocasionales = gastos.filter((g: any) => g.esOcasional);
  const totalGastos = Number(data?.totalPagado ?? 0) + Number(data?.totalPendiente ?? 0);
  const totalSueldos = Number(sueldos.data?.total ?? 0);
  const totalMes = totalGastos + totalSueldos;
  const sucList = sucursales.data ?? [];

  return (
    <div className="min-h-full bg-gradient-to-b from-muted/30 to-transparent">
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-5">

        {/* Cabecera */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <Wallet className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight leading-none">Gastos</h1>
              <p className="text-[11px] text-muted-foreground mt-0.5">Control de gastos por sucursal</p>
            </div>
          </div>
          <input type="month" value={anioMes} onChange={(e) => setAnioMes(e.target.value)}
            className="text-xs rounded-lg border bg-card px-3 py-2 shadow-sm font-medium" />
        </div>

        {/* Selector de sucursal */}
        {sucList.length > 0 && (
          <div className="flex gap-1 flex-wrap items-center">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground mr-1" />
            <button onClick={() => setSucursal("")}
              className={`text-[11px] px-2.5 py-1 rounded-lg font-medium transition ${!sucursal ? "bg-primary text-primary-foreground" : "bg-card border hover:bg-muted"}`}>
              Todas
            </button>
            {sucList.map((s: string) => (
              <button key={s} onClick={() => setSucursal(s)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-medium transition ${sucursal === s ? "bg-primary text-primary-foreground" : "bg-card border hover:bg-muted"}`}>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Resumen */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-xl border bg-card p-3.5 shadow-sm">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Gastos operativos</p>
            <p className="text-lg font-black tabular-nums">Bs {fmtBs(totalGastos)}</p>
          </div>
          <div className="rounded-xl border bg-card p-3.5 shadow-sm">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Sueldos personal</p>
            <p className="text-lg font-black tabular-nums text-indigo-600">Bs {fmtBs(totalSueldos)}</p>
          </div>
          <div className="rounded-xl border bg-card p-3.5 shadow-sm">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Pendiente</p>
            <p className="text-lg font-black tabular-nums text-amber-600">Bs {fmtBs(data?.totalPendiente)}</p>
          </div>
          <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3.5 shadow-sm">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Total egresos</p>
            <p className="text-lg font-black tabular-nums text-primary">Bs {fmtBs(totalMes)}</p>
          </div>
        </div>

        {/* Personal de la sucursal (sueldos) */}
        {(sueldos.data?.detalle?.length ?? 0) > 0 && (
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <h2 className="text-sm font-bold flex items-center gap-2 mb-3">
              <Building2 className="h-4 w-4 text-indigo-600" /> Personal {sucursal ? `de ${sucursal}` : "(toda la farmacia)"}
            </h2>
            <div className="space-y-1.5">
              {sueldos.data!.detalle.map((s: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="font-medium">{s.nombre}</span>
                  <span className="font-bold tabular-nums text-indigo-600">Bs {fmtBs(s.sueldo)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between text-xs pt-1.5 mt-1.5 border-t font-bold">
                <span>Total sueldos</span>
                <span className="tabular-nums text-indigo-600">Bs {fmtBs(totalSueldos)}</span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">El personal se gestiona en Asistencia. Aquí se muestra para ver el egreso total{sucursal ? " de esta sucursal" : ""}.</p>
          </div>
        )}

        {gastosMes.isLoading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <>
            {/* Gastos fijos del mes */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold flex items-center gap-2"><CalendarDays className="h-4 w-4" /> Gastos fijos del mes</h2>
                <button onClick={() => setShowNuevoFijo(!showNuevoFijo)}
                  className="text-[11px] inline-flex items-center gap-1 rounded-lg border px-2 py-1 hover:bg-muted transition">
                  <Plus className="h-3 w-3" /> Nuevo fijo
                </button>
              </div>

              {showNuevoFijo && <NuevoFijoForm sucList={sucList} sucursalActual={sucursal} onClose={() => setShowNuevoFijo(false)} />}

              {fijos.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Aún no hay gastos fijos{sucursal ? ` en ${sucursal}` : ""}. Crea uno (alquiler, luz, internet...) y aparecerá cada mes.</p>
              ) : (
                <div className="space-y-1.5">
                  {fijos.map((g: any) => <GastoFila key={g.id} g={g} fmtBs={fmtBs} marcarPago={marcarPago} eliminar={eliminar} cambiarFecha={cambiarFecha} editar={editar} sucList={sucList} />)}
                </div>
              )}
            </div>

            {/* Gastos ocasionales */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold flex items-center gap-2"><Package className="h-4 w-4" /> Gastos ocasionales</h2>
                <button onClick={() => setShowNuevoOcasional(!showNuevoOcasional)}
                  className="text-[11px] inline-flex items-center gap-1 rounded-lg border px-2 py-1 hover:bg-muted transition">
                  <Plus className="h-3 w-3" /> Registrar gasto
                </button>
              </div>

              {showNuevoOcasional && <NuevoOcasionalForm anioMes={anioMes} sucList={sucList} sucursalActual={sucursal} onClose={() => setShowNuevoOcasional(false)} />}

              {ocasionales.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">Sin gastos ocasionales este mes (reparaciones, compras puntuales, etc.).</p>
              ) : (
                <div className="space-y-1.5">
                  {ocasionales.map((g: any) => <GastoFila key={g.id} g={g} fmtBs={fmtBs} marcarPago={marcarPago} eliminar={eliminar} cambiarFecha={cambiarFecha} editar={editar} sucList={sucList} />)}
                </div>
              )}
            </div>

            <p className="text-[10px] text-muted-foreground text-center">
              Los sueldos se gestionan en Asistencia y se suman aparte para la rentabilidad total.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function GastoFila({ g, fmtBs, marcarPago, eliminar, cambiarFecha, editar, sucList }: any) {
  const info = catInfo(g.categoria);
  const Icon = info.icon;
  const [editando, setEditando] = useState(false);
  const [eNombre, setENombre] = useState(g.nombre);
  const [eCategoria, setECategoria] = useState(g.categoria);
  const [eMonto, setEMonto] = useState(String(g.monto));
  const [eSuc, setESuc] = useState(g.sucursal || "");

  function guardarEdicion() {
    editar.mutate({ id: g.id, nombre: eNombre, categoria: eCategoria, monto: parseFloat(eMonto) || 0, sucursal: eSuc || undefined });
    setEditando(false);
  }

  function pedirEliminar() {
    if (g.gastoFijoId) {
      // Es un gasto fijo: preguntar si solo este mes o el fijo completo
      const soloMes = window.confirm("Este es un gasto FIJO.\n\nAceptar = eliminar el gasto fijo para siempre (no aparecerá más).\nCancelar = quitarlo solo de este mes.");
      eliminar.mutate({ id: g.id, eliminarPlantilla: soloMes });
    } else {
      if (window.confirm("¿Eliminar este gasto?")) eliminar.mutate({ id: g.id });
    }
  }

  if (editando) {
    return (
      <div className="rounded-lg border bg-muted/40 p-2.5 space-y-2">
        <input value={eNombre} onChange={(e) => setENombre(e.target.value)} className="w-full text-xs rounded-md border px-2 py-1.5 bg-background" />
        <div className="flex gap-2 flex-wrap">
          <select value={eCategoria} onChange={(e) => setECategoria(e.target.value)} className="flex-1 min-w-[120px] text-xs rounded-md border px-2 py-1.5 bg-background">
            {CATEGORIAS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <input type="number" value={eMonto} onChange={(e) => setEMonto(e.target.value)} className="w-24 text-xs rounded-md border px-2 py-1.5 bg-background" />
        </div>
        {sucList.length > 0 && (
          <select value={eSuc} onChange={(e) => setESuc(e.target.value)} className="text-xs rounded-md border px-2 py-1.5 bg-background w-full">
            <option value="">Toda la farmacia</option>
            {sucList.map((s: string) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={() => setEditando(false)} className="text-xs px-2 py-1 rounded-md hover:bg-muted">Cancelar</button>
          <button onClick={guardarEdicion} className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground font-medium">Guardar</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 rounded-lg px-3 py-2 transition ${g.pagado ? "bg-emerald-50 dark:bg-emerald-950/20" : "bg-muted/40"}`}>
      <Icon className={`h-4 w-4 shrink-0 ${info.color}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate">{g.nombre}</p>
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          {info.label}
          {g.sucursal && <span className="inline-flex items-center gap-0.5"><Building2 className="h-2.5 w-2.5" />{g.sucursal}</span>}
        </p>
      </div>
      {g.pagado ? (
        <input type="date" value={g.fechaPago || ""} onChange={(e) => cambiarFecha.mutate({ id: g.id, fechaPago: e.target.value })}
          className="text-[10px] rounded border px-1 py-0.5 bg-background shrink-0 w-[110px]" title="Fecha de pago" />
      ) : null}
      <span className="text-xs font-bold tabular-nums shrink-0">Bs {fmtBs(g.monto)}</span>
      <button onClick={() => marcarPago.mutate({ id: g.id, pagado: !g.pagado })}
        className={`shrink-0 h-6 w-6 rounded-md grid place-items-center transition ${g.pagado ? "bg-emerald-600 text-white" : "border hover:bg-background"}`}
        title={g.pagado ? "Marcar como no pagado" : "Marcar como pagado"}>
        <Check className="h-3.5 w-3.5" />
      </button>
      <button onClick={() => setEditando(true)} className="shrink-0 h-6 w-6 rounded-md grid place-items-center text-muted-foreground hover:text-primary hover:bg-primary/10 transition" title="Editar">
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button onClick={pedirEliminar} className="shrink-0 h-6 w-6 rounded-md grid place-items-center text-muted-foreground hover:text-red-600 hover:bg-red-50 transition" title="Eliminar">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SucursalSelect({ sucList, value, onChange }: { sucList: string[]; value: string; onChange: (v: string) => void }) {
  if (sucList.length === 0) return null;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="text-xs rounded-md border px-2 py-1.5 bg-background">
      <option value="">Toda la farmacia</option>
      {sucList.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

function NuevoFijoForm({ sucList, sucursalActual, onClose }: { sucList: string[]; sucursalActual: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [nombre, setNombre] = useState("");
  const [categoria, setCategoria] = useState("servicios");
  const [monto, setMonto] = useState("");
  const [suc, setSuc] = useState(sucursalActual);
  const crear = trpc.gastos.crearFijo.useMutation({
    onSuccess: () => { utils.gastos.delMes.invalidate(); toast.success("Gasto fijo creado"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="rounded-lg border bg-muted/30 p-3 mb-3 space-y-2">
      <input placeholder="Nombre (ej. Alquiler local)" value={nombre} onChange={(e) => setNombre(e.target.value)}
        className="w-full text-xs rounded-md border px-2 py-1.5 bg-background" />
      <div className="flex gap-2 flex-wrap">
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="flex-1 min-w-[140px] text-xs rounded-md border px-2 py-1.5 bg-background">
          {CATEGORIAS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input type="number" placeholder="Monto Bs" value={monto} onChange={(e) => setMonto(e.target.value)}
          className="w-24 text-xs rounded-md border px-2 py-1.5 bg-background" />
      </div>
      <SucursalSelect sucList={sucList} value={suc} onChange={setSuc} />
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="text-xs px-2 py-1 rounded-md hover:bg-muted">Cancelar</button>
        <button onClick={() => nombre && monto && crear.mutate({ nombre, categoria, montoEstimado: parseFloat(monto), sucursal: suc || undefined })}
          disabled={crear.isPending || !nombre || !monto}
          className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50">
          {crear.isPending ? "Guardando..." : "Crear"}
        </button>
      </div>
    </div>
  );
}

function NuevoOcasionalForm({ anioMes, sucList, sucursalActual, onClose }: { anioMes: string; sucList: string[]; sucursalActual: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [nombre, setNombre] = useState("");
  const [categoria, setCategoria] = useState("otros");
  const [monto, setMonto] = useState("");
  const [pagado, setPagado] = useState(true);
  const [suc, setSuc] = useState(sucursalActual);
  const [fechaPago, setFechaPago] = useState(new Date().toISOString().slice(0, 10));
  const crear = trpc.gastos.registrarOcasional.useMutation({
    onSuccess: () => { utils.gastos.delMes.invalidate(); toast.success("Gasto registrado"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="rounded-lg border bg-muted/30 p-3 mb-3 space-y-2">
      <input placeholder="Concepto (ej. Reparación refrigerador)" value={nombre} onChange={(e) => setNombre(e.target.value)}
        className="w-full text-xs rounded-md border px-2 py-1.5 bg-background" />
      <div className="flex gap-2 flex-wrap">
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="flex-1 min-w-[140px] text-xs rounded-md border px-2 py-1.5 bg-background">
          {CATEGORIAS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <input type="number" placeholder="Monto Bs" value={monto} onChange={(e) => setMonto(e.target.value)}
          className="w-24 text-xs rounded-md border px-2 py-1.5 bg-background" />
      </div>
      <SucursalSelect sucList={sucList} value={suc} onChange={setSuc} />
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={pagado} onChange={(e) => setPagado(e.target.checked)} /> Ya está pagado
        </label>
        {pagado && (
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Fecha: <input type="date" value={fechaPago} onChange={(e) => setFechaPago(e.target.value)} className="text-[11px] rounded border px-1 py-0.5 bg-background" />
          </label>
        )}
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onClose} className="text-xs px-2 py-1 rounded-md hover:bg-muted">Cancelar</button>
        <button onClick={() => nombre && monto && crear.mutate({ anioMes, nombre, categoria, monto: parseFloat(monto), pagado, sucursal: suc || undefined, fechaPago: pagado ? fechaPago : undefined })}
          disabled={crear.isPending || !nombre || !monto}
          className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50">
          {crear.isPending ? "Guardando..." : "Registrar"}
        </button>
      </div>
    </div>
  );
}
