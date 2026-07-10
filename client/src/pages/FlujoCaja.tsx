import { trpc } from "@/lib/trpc";
import { TrendingUp, TrendingDown, AlertTriangle, Wallet, Package, Users, Landmark, Receipt } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Cell, Tooltip, ReferenceLine } from "recharts";

const bs = (n: number) => `Bs ${n.toLocaleString("es-BO", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

/**
 * FLUJO DE CAJA — "modo empresarial": histórico real + proyección de próximos
 * meses, con TODOS los compromisos (costo de mercadería, gastos operativos,
 * sueldos, cuotas de créditos). Metodología siempre visible — nunca caja negra.
 */
export default function FlujoCaja() {
  const { data, isLoading } = trpc.flujoCaja.ver.useQuery({ mesesHistoria: 6, mesesProyectar: 3 });

  if (isLoading) return <div className="max-w-4xl mx-auto px-4 py-10 text-center text-sm text-muted-foreground">Calculando flujo de caja…</div>;
  if (!data || (data as any).error) return <div className="max-w-4xl mx-auto px-4 py-10 text-center text-sm text-red-600">No se pudo calcular el flujo de caja.</div>;

  const todos = [...data.historico, ...data.proyeccion];
  const chartData = todos.map((m) => ({
    mes: m.mesNombre.split(" ")[0] + (m.esProyeccion ? "*" : ""),
    neto: m.neto,
    esProyeccion: m.esProyeccion,
  }));

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        <Wallet className="w-5 h-5 text-emerald-600" />
        <h1 className="text-xl font-black">Flujo de Caja</h1>
      </div>
      <p className="text-xs text-muted-foreground mb-5">
        Histórico real de los últimos {data.historico.length} meses + proyección de los próximos {data.proyeccion.length}.
        Los meses proyectados están marcados con <b>*</b>.
      </p>

      {/* Alerta */}
      {data.resumen.alerta && (
        <div className="mb-5 p-3 rounded-2xl bg-red-50 dark:bg-red-950/20 border border-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <p className="text-xs text-red-800 dark:text-red-300">{data.resumen.alerta}</p>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-2 mb-5">
        <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-100">
          <p className="text-[10px] text-emerald-700 font-bold">Excedente promedio (histórico)</p>
          <p className={`text-lg font-black ${data.resumen.excedentePromedioHistorico >= 0 ? "text-emerald-700" : "text-red-700"}`}>{bs(data.resumen.excedentePromedioHistorico)}</p>
        </div>
        <div className="p-3 rounded-2xl bg-sky-50 dark:bg-sky-950/20 border border-sky-100">
          <p className="text-[10px] text-sky-700 font-bold">Excedente promedio (proyectado)</p>
          <p className={`text-lg font-black ${data.resumen.excedentePromedioProyectado >= 0 ? "text-sky-700" : "text-red-700"}`}>{bs(data.resumen.excedentePromedioProyectado)}</p>
        </div>
      </div>

      {/* Gráfico de neto por mes */}
      <div className="mb-6">
        <p className="text-xs font-bold text-muted-foreground mb-2">Flujo neto mensual (ingresos − todos los egresos)</p>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={chartData}>
            <XAxis dataKey="mes" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
            <Tooltip formatter={(v: any) => bs(Number(v))} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
            <ReferenceLine y={0} stroke="#999" />
            <Bar dataKey="neto" radius={[4, 4, 0, 0]}>
              {chartData.map((d, i) => (
                <Cell key={i} fill={d.neto < 0 ? "#dc2626" : d.esProyeccion ? "#38bdf8" : "#059669"} fillOpacity={d.esProyeccion ? 0.6 : 1} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div className="flex gap-3 text-[10px] text-muted-foreground mt-1">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-600" /> Real</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-sky-400" /> Proyectado</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-600" /> Negativo</span>
        </div>
      </div>

      {/* Compromisos fijos mensuales */}
      <div className="mb-6">
        <p className="text-xs font-bold text-muted-foreground mb-2">Compromisos fijos cada mes (no dependen de las ventas)</p>
        <div className="grid grid-cols-3 gap-2">
          <div className="p-3 rounded-xl bg-white dark:bg-card border text-center">
            <Receipt className="w-4 h-4 mx-auto text-amber-600 mb-1" />
            <p className="text-[10px] text-muted-foreground">Gastos fijos</p>
            <p className="text-sm font-black">{bs(data.compromisosFijosMensuales.gastosFijos)}</p>
          </div>
          <div className="p-3 rounded-xl bg-white dark:bg-card border text-center">
            <Users className="w-4 h-4 mx-auto text-sky-600 mb-1" />
            <p className="text-[10px] text-muted-foreground">Sueldos (aprox)</p>
            <p className="text-sm font-black">{bs(data.compromisosFijosMensuales.sueldosAprox)}</p>
          </div>
          <div className="p-3 rounded-xl bg-white dark:bg-card border text-center">
            <Landmark className="w-4 h-4 mx-auto text-red-600 mb-1" />
            <p className="text-[10px] text-muted-foreground">Cuotas créditos</p>
            <p className="text-sm font-black">{bs(data.compromisosFijosMensuales.cuotasCreditos)}</p>
          </div>
        </div>
        <p className="text-center text-xs font-bold mt-2">Total comprometido: <span className="text-red-700">{bs(data.compromisosFijosMensuales.total)}</span>/mes, pase lo que pase con las ventas</p>
      </div>

      {/* Detalle mes a mes */}
      <p className="text-xs font-bold text-muted-foreground mb-2">Detalle mes a mes</p>
      <div className="space-y-2 mb-6">
        {todos.map((m: any) => (
          <div key={m.anioMes} className={`p-3 rounded-xl border ${m.esProyeccion ? "bg-sky-50/40 dark:bg-sky-950/10 border-sky-200 border-dashed" : "bg-white dark:bg-card"} ${m.negativo ? "border-red-300" : ""}`}>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-black">{m.mesNombre}{m.esProyeccion && <span className="text-sky-600 font-normal"> (proyectado)</span>}</p>
              <span className={`text-sm font-black flex items-center gap-1 ${m.neto >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                {m.neto >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />} {bs(m.neto)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              <p>+ Ingresos (ventas): <b className="text-foreground">{bs(m.ingresos)}</b></p>
              <p className="flex items-center gap-1"><Package className="w-3 h-3" /> Costo mercadería: <b className="text-foreground">-{bs(m.costoMercaderia)}</b></p>
              <p>Gastos operativos: <b className="text-foreground">-{bs(m.gastosOperativos)}</b></p>
              <p>Sueldos: <b className="text-foreground">-{bs(m.sueldos)}</b></p>
              <p>Cuotas créditos: <b className="text-foreground">-{bs(m.cuotasCreditos)}</b></p>
            </div>
          </div>
        ))}
      </div>

      {/* Metodología (transparencia total) */}
      <div className="p-3 rounded-xl bg-muted text-[11px] text-muted-foreground">
        <p className="font-bold mb-1">📐 Metodología de la proyección</p>
        <p>{data.metodologia}</p>
      </div>
    </div>
  );
}
