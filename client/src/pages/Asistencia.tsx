import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Users, Plus, Clock, AlertTriangle, Calendar, DollarSign,
  Loader2, Save, ChevronLeft, Pencil, TrendingDown,
} from "lucide-react";
import { toast } from "sonner";

type Vista = "resumen" | "trabajadores" | "form";

const mesActual = () => new Date().toISOString().slice(0, 7);

export default function Asistencia() {
  const [vista, setVista] = useState<Vista>("resumen");
  const [trabajadorSel, setTrabajadorSel] = useState<number | null>(null);
  const [anioMes, setAnioMes] = useState(mesActual());
  const [editando, setEditando] = useState<any>(null);

  const utils = trpc.useUtils();
  const { data: trabajadores, isLoading } = trpc.asistencia.listarTrabajadores.useQuery();
  const { data: usuariosSistema } = trpc.asistencia.listarUsuariosSistema.useQuery();
  const guardarMut = trpc.asistencia.guardarTrabajador.useMutation({
    onSuccess: () => { utils.asistencia.listarTrabajadores.invalidate(); toast.success("Trabajador guardado"); setVista("trabajadores"); },
    onError: (e) => toast.error(e.message),
  });

  const resumen = trpc.asistencia.resumenMensual.useQuery(
    { trabajadorId: trabajadorSel || 0, anioMes },
    { enabled: !!trabajadorSel }
  );

  // ─── Vista: Resumen mensual (principal) ───
  if (vista === "resumen") {
    return (
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between border-b border-foreground pb-3">
          <div className="flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-black uppercase tracking-tight">Asistencia</h1>
          </div>
          <Button variant="outline" size="sm" onClick={() => setVista("trabajadores")} className="gap-1 text-xs">
            <Pencil className="h-3 w-3" /> Trabajadores
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          El resumen se calcula con las aperturas de caja registradas en inventarios365. La hora de apertura es la hora de entrada.
        </p>

        {/* Selección de trabajador y mes */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Trabajador</Label>
            <select
              value={trabajadorSel || ""}
              onChange={(e) => setTrabajadorSel(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Selecciona...</option>
              {(trabajadores || []).filter((t: any) => t.activo).map((t: any) => (
                <option key={t.id} value={t.id}>{t.nombre}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Mes</Label>
            <Input type="month" value={anioMes} onChange={(e) => setAnioMes(e.target.value)} className="h-10" />
          </div>
        </div>

        {!trabajadorSel && (
          <div className="text-center py-12 text-muted-foreground">
            <Calendar className="h-10 w-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">Selecciona un trabajador para ver su resumen del mes.</p>
          </div>
        )}

        {trabajadorSel && resumen.isLoading && (
          <div className="text-center py-12"><Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" /></div>
        )}

        {trabajadorSel && resumen.data && (
          <div className="space-y-4">
            {/* Tarjetas resumen */}
            <div className="grid grid-cols-2 gap-3">
              <Card><CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Calendar className="h-3.5 w-3.5" /> Días trabajados</div>
                <p className="text-2xl font-black">{resumen.data.diasTrabajados}</p>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Clock className="h-3.5 w-3.5" /> Horas totales</div>
                <p className="text-2xl font-black">{resumen.data.horasTotales}</p>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="flex items-center gap-2 text-orange-600 text-xs mb-1"><AlertTriangle className="h-3.5 w-3.5" /> Retrasos</div>
                <p className="text-2xl font-black text-orange-600">{resumen.data.cantidadRetrasos}</p>
                <p className="text-[11px] text-muted-foreground">{resumen.data.minutosRetrasoTotal} min acumulados</p>
              </CardContent></Card>
              <Card><CardContent className="p-4">
                <div className="flex items-center gap-2 text-red-600 text-xs mb-1"><TrendingDown className="h-3.5 w-3.5" /> Descuento</div>
                <p className="text-2xl font-black text-red-600">{resumen.data.descuento.toFixed(2)}</p>
                <p className="text-[11px] text-muted-foreground">Bs por retrasos</p>
              </CardContent></Card>
            </div>

            {/* Sueldo a pagar */}
            <Card className="border-2 border-primary">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-muted-foreground text-xs"><DollarSign className="h-4 w-4" /> Sueldo a pagar</div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {resumen.data.trabajador.sueldoMensual.toFixed(2)} − {resumen.data.descuento.toFixed(2)} descuento
                    </p>
                  </div>
                  <p className="text-3xl font-black text-primary">{resumen.data.sueldoFinal.toFixed(2)} <span className="text-base">Bs</span></p>
                </div>
              </CardContent>
            </Card>

            {/* Detalle de días */}
            {resumen.data.detalle.length > 0 ? (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Detalle por día</p>
                <div className="space-y-1">
                  {resumen.data.detalle.map((d: any, i: number) => (
                    <div key={i} className="flex items-center justify-between bg-muted/40 rounded px-3 py-2 text-xs">
                      <span className="font-medium">{d.fecha}</span>
                      <span className="text-muted-foreground">Entró: {d.horaEntrada?.slice(0, 5) || "—"}</span>
                      <span>{d.horasTrabajadas}h</span>
                      {d.minutosRetraso > 0
                        ? <span className="text-orange-600 font-medium">+{d.minutosRetraso} min</span>
                        : <span className="text-green-600">A tiempo</span>}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-center text-sm text-muted-foreground py-6">
                No hay aperturas de caja registradas este mes para este trabajador.
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  // ─── Vista: Lista de trabajadores ───
  if (vista === "trabajadores") {
    return (
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between border-b border-foreground pb-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setVista("resumen")}><ChevronLeft className="h-5 w-5" /></Button>
            <h1 className="text-lg font-black uppercase tracking-tight">Trabajadores</h1>
          </div>
          <Button size="sm" onClick={() => { setEditando(null); setVista("form"); }} className="gap-1 text-xs">
            <Plus className="h-3 w-3" /> Nuevo
          </Button>
        </div>

        {isLoading ? (
          <div className="text-center py-12"><Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" /></div>
        ) : (trabajadores || []).length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No hay trabajadores. Agrega el primero.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {(trabajadores || []).map((t: any) => (
              <Card key={t.id} className={t.activo ? "" : "opacity-50"}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-sm">{t.nombre}</p>
                    <p className="text-[11px] text-muted-foreground">
                      Entra {t.horaIngreso} · {t.horasDia}h/día · {parseFloat(t.sueldoMensual).toFixed(0)} Bs/mes
                      {t.usuarioSistemaNombre ? ` · Caja: ${t.usuarioSistemaNombre}` : " · ⚠️ sin usuario"}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => { setEditando(t); setVista("form"); }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Vista: Formulario de trabajador ───
  return <FormTrabajador
    editando={editando}
    usuariosSistema={usuariosSistema || []}
    onCancel={() => setVista("trabajadores")}
    onSave={(data) => guardarMut.mutate(data)}
    guardando={guardarMut.isPending}
  />;
}

function FormTrabajador({ editando, usuariosSistema, onCancel, onSave, guardando }: any) {
  const [nombre, setNombre] = useState(editando?.nombre || "");
  const [usuarioId, setUsuarioId] = useState(editando?.usuarioSistemaId || "");
  const [horaIngreso, setHoraIngreso] = useState(editando?.horaIngreso || "08:00");
  const [horasDia, setHorasDia] = useState(editando ? parseFloat(editando.horasDia) : 8);
  const [diasMes, setDiasMes] = useState(editando?.diasMes || 26);
  const [sueldo, setSueldo] = useState(editando ? parseFloat(editando.sueldoMensual) : 0);
  const [tipoDescuento, setTipoDescuento] = useState(editando?.tipoDescuento || "proporcional");
  const [montoFijo, setMontoFijo] = useState(editando ? parseFloat(editando.montoDescuentoFijo) : 10);
  const [tolerancia, setTolerancia] = useState(editando?.toleranciaMin ?? 5);

  const guardar = () => {
    if (!nombre.trim()) { toast.error("El nombre es obligatorio"); return; }
    const usel = usuariosSistema.find((u: any) => u.id === usuarioId);
    onSave({
      id: editando?.id,
      nombre: nombre.trim(),
      usuarioSistemaId: usuarioId || null,
      usuarioSistemaNombre: usel?.nombre || null,
      horaIngreso,
      horasDia: Number(horasDia),
      diasMes: Number(diasMes),
      sueldoMensual: Number(sueldo),
      tipoDescuento,
      montoDescuentoFijo: Number(montoFijo),
      toleranciaMin: Number(tolerancia),
    });
  };

  return (
    <div className="max-w-2xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2 border-b border-foreground pb-3">
        <Button variant="ghost" size="icon" onClick={onCancel}><ChevronLeft className="h-5 w-5" /></Button>
        <h1 className="text-lg font-black uppercase tracking-tight">{editando ? "Editar" : "Nuevo"} trabajador</h1>
      </div>

      <div className="space-y-3">
        <div>
          <Label className="text-xs">Nombre</Label>
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre del trabajador" />
        </div>

        <div>
          <Label className="text-xs">Usuario de inventarios365 (abre caja con este usuario)</Label>
          <select value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)}
            className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="">Sin vincular</option>
            {usuariosSistema.map((u: any) => <option key={u.id} value={u.id}>{u.nombre}</option>)}
          </select>
          {usuariosSistema.length === 0 && <p className="text-[11px] text-orange-600 mt-1">No se pudieron cargar los usuarios del sistema.</p>}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label className="text-xs">Hora ingreso</Label>
            <Input type="time" value={horaIngreso} onChange={(e) => setHoraIngreso(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Horas/día</Label>
            <Input type="number" value={horasDia} onChange={(e) => setHorasDia(parseFloat(e.target.value) || 0)} step="0.5" />
          </div>
          <div>
            <Label className="text-xs">Días/mes</Label>
            <Input type="number" value={diasMes} onChange={(e) => setDiasMes(parseInt(e.target.value) || 0)} />
          </div>
        </div>

        <div>
          <Label className="text-xs">Sueldo mensual (Bs)</Label>
          <Input type="number" value={sueldo} onChange={(e) => setSueldo(parseFloat(e.target.value) || 0)} step="0.01" />
        </div>

        <div className="border border-foreground/10 rounded-lg p-3 space-y-3">
          <Label className="text-xs font-bold">Descuento por retraso</Label>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setTipoDescuento("proporcional")}
              className={`text-xs p-2 rounded border text-left ${tipoDescuento === "proporcional" ? "border-primary bg-primary/10 font-medium" : "border-foreground/15"}`}>
              Proporcional<br /><span className="text-[10px] text-muted-foreground">valor hora × tiempo de retraso</span>
            </button>
            <button onClick={() => setTipoDescuento("fijo")}
              className={`text-xs p-2 rounded border text-left ${tipoDescuento === "fijo" ? "border-primary bg-primary/10 font-medium" : "border-foreground/15"}`}>
              Monto fijo<br /><span className="text-[10px] text-muted-foreground">Bs por cada retraso</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {tipoDescuento === "fijo" && (
              <div>
                <Label className="text-xs">Monto por retraso (Bs)</Label>
                <Input type="number" value={montoFijo} onChange={(e) => setMontoFijo(parseFloat(e.target.value) || 0)} step="0.01" />
              </div>
            )}
            <div>
              <Label className="text-xs">Tolerancia (min)</Label>
              <Input type="number" value={tolerancia} onChange={(e) => setTolerancia(parseInt(e.target.value) || 0)} />
              <p className="text-[10px] text-muted-foreground mt-0.5">Retraso después de estos minutos</p>
            </div>
          </div>
        </div>

        <Button onClick={guardar} disabled={guardando} className="w-full gap-2">
          {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Guardar trabajador
        </Button>
      </div>
    </div>
  );
}
