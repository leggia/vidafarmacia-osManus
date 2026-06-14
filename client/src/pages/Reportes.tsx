import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TrendingUp, RefreshCw, Loader2, Package, Users, Building2,
  Calendar, DollarSign, ShoppingCart, Award,
} from "lucide-react";
import { toast } from "sonner";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell } from "recharts";

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

// Primer y último día del mes actual por defecto
function rangoMesActual() {
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { desde: fmt(ini), hasta: fmt(hoy) };
}

export default function Reportes() {
  const r0 = rangoMesActual();
  const [desde, setDesde] = useState(r0.desde);
  const [hasta, setHasta] = useState(r0.hasta);
  const [sucursal, setSucursal] = useState<string>("");

  const utils = trpc.useUtils();
  const estado = trpc.ventas.estado.useQuery();
  const sucursales = trpc.ventas.sucursalesDisponibles.useQuery();
  const reportes = trpc.ventas.reportes.useQuery({ desde, hasta, sucursal: sucursal || undefined });

  const sincronizar = trpc.ventas.sincronizar.useMutation({
    onSuccess: (d: any) => {
      if (d?.omitido) toast.success("Punto de partida establecido. Vuelve a sincronizar para traer ventas nuevas.");
      else toast.success(`Sincronización lista: ${d?.nuevas ?? 0} ventas nuevas`);
      utils.ventas.estado.invalidate();
      utils.ventas.reportes.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const d = reportes.data;
  const fmtBs = (n: any) => Number(n || 0).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between border-b border-foreground pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-black uppercase tracking-tight">Reportes de ventas</h1>
        </div>
        <Button size="sm" onClick={() => sincronizar.mutate()} disabled={sincronizar.isPending} className="gap-1 text-xs">
          {sincronizar.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Sincronizar
        </Button>
      </div>

      {/* Estado de datos */}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground bg-muted/40 rounded px-3 py-2">
        <span>{estado.data?.totalVentas ?? 0} ventas · {estado.data?.totalClientes ?? 0} clientes guardados</span>
        {estado.data?.ultimaSync && <span>Últ. sync: {new Date(estado.data.ultimaSync).toLocaleString("es-BO")}</span>}
      </div>

      {/* Filtros de fecha y sucursal */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-muted-foreground">Desde</label>
          <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} className="h-9" />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">Hasta</label>
          <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} className="h-9" />
        </div>
      </div>
      {(sucursales.data?.length ?? 0) > 0 && (
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setSucursal("")} className={`text-[11px] px-2 py-1 rounded ${!sucursal ? "bg-primary text-white" : "bg-muted"}`}>Todas</button>
          {sucursales.data!.map((s: string) => (
            <button key={s} onClick={() => setSucursal(s)} className={`text-[11px] px-2 py-1 rounded ${sucursal === s ? "bg-primary text-white" : "bg-muted"}`}>{s}</button>
          ))}
        </div>
      )}

      {reportes.isLoading ? (
        <div className="text-center py-12"><Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" /></div>
      ) : !d || (d.totales?.ventas ?? 0) === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <ShoppingCart className="h-10 w-10 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No hay ventas en este periodo.</p>
          <p className="text-[11px] mt-1">Usa "Sincronizar" para traer ventas desde inventarios365.</p>
        </div>
      ) : (
        <>
          {/* Totales */}
          <div className="grid grid-cols-3 gap-2">
            <Card><CardContent className="p-3">
              <div className="flex items-center gap-1 text-muted-foreground text-[11px] mb-1"><ShoppingCart className="h-3 w-3" /> Ventas</div>
              <p className="text-lg font-black">{d.totales.ventas}</p>
            </CardContent></Card>
            <Card><CardContent className="p-3">
              <div className="flex items-center gap-1 text-muted-foreground text-[11px] mb-1"><DollarSign className="h-3 w-3" /> Total</div>
              <p className="text-lg font-black">{fmtBs(d.totales.monto)}</p>
            </CardContent></Card>
            <Card><CardContent className="p-3">
              <div className="flex items-center gap-1 text-muted-foreground text-[11px] mb-1"><TrendingUp className="h-3 w-3" /> Promedio</div>
              <p className="text-lg font-black">{fmtBs(d.totales.promedio)}</p>
            </CardContent></Card>
          </div>

          {/* Productos más vendidos */}
          <Card><CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3 text-sm font-bold"><Package className="h-4 w-4 text-primary" /> Productos más vendidos</div>
            <div className="space-y-1.5">
              {d.masVendidos.map((p: any, i: number) => (
                <div key={i} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="text-muted-foreground w-4 text-right">{i + 1}</span>
                    <span className="truncate">{p.articuloNombre}</span>
                  </span>
                  <span className="font-bold shrink-0">{Number(p.unidades)} u.</span>
                </div>
              ))}
            </div>
          </CardContent></Card>

          {/* Mejores vendedores */}
          <Card><CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3 text-sm font-bold"><Award className="h-4 w-4 text-primary" /> Mejores vendedores</div>
            <div className="space-y-1.5">
              {d.vendedores.map((v: any, i: number) => (
                <div key={i} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${i === 0 ? "bg-amber-400 text-amber-900" : "bg-muted"}`}>{i + 1}</span>
                    {v.vendedor || "—"}
                  </span>
                  <span className="font-bold">{fmtBs(v.monto)} Bs <span className="text-muted-foreground font-normal">({v.ventas})</span></span>
                </div>
              ))}
            </div>
          </CardContent></Card>

          {/* Ventas por sucursal */}
          {d.sucursales.length > 1 && (
            <Card><CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3 text-sm font-bold"><Building2 className="h-4 w-4 text-primary" /> Ventas por sucursal</div>
              <div className="space-y-1.5">
                {d.sucursales.map((s: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span>{s.nombreSucursal || "—"}</span>
                    <span className="font-bold">{fmtBs(s.monto)} Bs <span className="text-muted-foreground font-normal">({s.ventas})</span></span>
                  </div>
                ))}
              </div>
            </CardContent></Card>
          )}

          {/* Mejores días de la semana (gráfica) */}
          <Card><CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3 text-sm font-bold"><Calendar className="h-4 w-4 text-primary" /> Ventas por día de la semana</div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={DIAS.map((nombre, idx) => {
                const row = d.diasSemana.find((x: any) => Number(x.diaSemana) === idx);
                return { dia: nombre.slice(0, 3), monto: row ? Number(row.monto) : 0 };
              })}>
                <XAxis dataKey="dia" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} width={45} />
                <Bar dataKey="monto" radius={[4, 4, 0, 0]}>
                  {DIAS.map((_, idx) => <Cell key={idx} fill={idx === 0 || idx === 6 ? "#f59e0b" : "#3b82f6"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent></Card>
        </>
      )}
    </div>
  );
}
