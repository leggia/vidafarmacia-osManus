import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Users, Plus, Clock, AlertTriangle, Calendar, DollarSign,
  Loader2, Save, ChevronLeft, Pencil, TrendingDown,
  CheckCircle2, ShieldCheck, Star,
} from "lucide-react";
import { toast } from "sonner";

type Vista = "resumen" | "trabajadores" | "form" | "pagos";

const mesActual = () => new Date().toISOString().slice(0, 7);

export default function Asistencia() {
  const [vista, setVista] = useState<Vista>("resumen");
  const [trabajadorSel, setTrabajadorSel] = useState<number | null>(null);
  const [anioMes, setAnioMes] = useState(mesActual());
  const [editando, setEditando] = useState<any>(null);

  const utils = trpc.useUtils();
  const { data: trabajadores, isLoading } = trpc.asistencia.listarTrabajadores.useQuery();
  const { data: usuariosSistema, isLoading: isLoadingUsuarios, error: errorUsuarios, refetch: refetchUsuarios } = trpc.asistencia.listarUsuariosSistema.useQuery(undefined, { retry: 1 });
  const guardarMut = trpc.asistencia.guardarTrabajador.useMutation({
    onSuccess: () => { utils.asistencia.listarTrabajadores.invalidate(); toast.success("Trabajador guardado"); setVista("trabajadores"); },
    onError: (e) => toast.error(e.message),
  });

  const resumen = trpc.asistencia.resumenMensual.useQuery(
    { trabajadorId: trabajadorSel || 0, anioMes },
    { enabled: !!trabajadorSel }
  );
  const marcarPagadoMut = trpc.asistencia.marcarPagado.useMutation({
    onSuccess: () => { utils.asistencia.resumenMensual.invalidate(); toast.success("Estado de pago actualizado"); },
    onError: (e) => toast.error(e.message),
  });
  const guardarAjusteMut = trpc.asistencia.guardarAjusteDia.useMutation({
    onSuccess: () => { utils.asistencia.resumenMensual.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const dashboardPagos = trpc.asistencia.dashboardPagos.useQuery(
    { anioMes },
    { enabled: vista === "pagos" }
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
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setVista("pagos")} className="gap-1 text-xs">
              <DollarSign className="h-3 w-3" /> Pagos
            </Button>
            <Button variant="outline" size="sm" onClick={() => setVista("trabajadores")} className="gap-1 text-xs">
              <Pencil className="h-3 w-3" /> Personal
            </Button>
          </div>
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
                <p className="text-2xl font-black">{resumen.data.diasTrabajados}{resumen.data.diasLaborablesMes ? <span className="text-base text-muted-foreground"> / {resumen.data.diasLaborablesMes}</span> : null}</p>
                {resumen.data.diasLaborablesMes ? <p className="text-[11px] text-muted-foreground">de {resumen.data.diasLaborablesMes} esperados este mes</p> : null}
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
            <Card className={`border-2 ${resumen.data.pagado ? "border-green-600" : "border-primary"}`}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-muted-foreground text-xs"><DollarSign className="h-4 w-4" /> Sueldo del mes</div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {resumen.data.sueldoBase.toFixed(2)} base − {resumen.data.descuento.toFixed(2)} descuento
                    </p>
                  </div>
                  <p className="text-3xl font-black text-primary">{resumen.data.sueldoFinal.toFixed(2)} <span className="text-base">Bs</span></p>
                </div>
                {/* Turnos extra: se pagan aparte (cada día) */}
                {resumen.data.turnosExtra > 0 && (
                  <div className="flex items-center justify-between bg-amber-50 dark:bg-amber-950/30 rounded px-3 py-2">
                    <span className="text-xs text-amber-700 dark:text-amber-300 flex items-center gap-1">
                      <Star className="h-3.5 w-3.5" /> {resumen.data.turnosExtra} turno(s) extra (se pagan aparte)
                    </span>
                    <span className="text-sm font-bold text-amber-700 dark:text-amber-300">{resumen.data.pagoTurnosExtra.toFixed(2)} Bs</span>
                  </div>
                )}
                {/* Marcar pagado */}
                {resumen.data.pagado ? (
                  <div className="flex items-center justify-between bg-green-50 dark:bg-green-950/40 rounded px-3 py-2">
                    <span className="text-xs text-green-700 dark:text-green-300 font-medium flex items-center gap-1">
                      <CheckCircle2 className="h-4 w-4" /> Pagado{resumen.data.fechaPago ? ` el ${new Date(resumen.data.fechaPago).toLocaleDateString("es-BO")}` : ""}
                    </span>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground"
                      onClick={() => marcarPagadoMut.mutate({ trabajadorId: trabajadorSel!, anioMes, montoPagado: resumen.data!.sueldoFinal, pagado: false })}>
                      Desmarcar
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" className="w-full gap-1 bg-green-700 hover:bg-green-800 text-white"
                    onClick={() => marcarPagadoMut.mutate({ trabajadorId: trabajadorSel!, anioMes, montoPagado: resumen.data!.sueldoFinal, pagado: true })}>
                    <CheckCircle2 className="h-4 w-4" /> Marcar como pagado
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Detalle de días */}
            {resumen.data.detalle.length > 0 ? (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Detalle por día</p>
                <div className="space-y-1.5">
                  {resumen.data.detalle.map((d: any, i: number) => (
                    <div key={i} className={`rounded-lg px-3 py-2 text-xs border ${
                      d.justificado ? "bg-blue-50 dark:bg-blue-950/30 border-blue-200"
                      : d.esTurnoExtra ? "bg-amber-50 dark:bg-amber-950/30 border-amber-200"
                      : d.tipoDia === "feriado" ? "bg-purple-50 dark:bg-purple-950/20 border-purple-200"
                      : d.tipoDia === "domingo" ? "bg-rose-50/60 dark:bg-rose-950/20 border-rose-100"
                      : "bg-muted/40 border-transparent"}`}>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-medium capitalize">
                          {d.fechaLarga}
                          {d.tipoDia === "feriado" && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-purple-200 dark:bg-purple-900 text-purple-800 dark:text-purple-200 align-middle">🎉 {d.nombreFeriado}</span>}
                          {d.tipoDia === "domingo" && <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-rose-200 dark:bg-rose-900 text-rose-800 dark:text-rose-200 align-middle">Domingo</span>}
                        </span>
                        <span className="text-muted-foreground">Entró {d.horaEntrada?.slice(0, 5) || "—"}{d.horaSalida ? ` · Salió ${d.horaSalida?.slice(0,5)}` : ""}</span>
                        <span className="font-medium">{d.horasTrabajadas}h</span>
                        {d.justificado ? <span className="text-blue-600 font-medium">Justificado</span>
                          : d.minutosRetraso > 0 ? <span className="text-orange-600 font-medium">+{d.minutosRetraso}min tarde</span>
                          : <span className="text-green-600">A tiempo</span>}
                        {d.minutosCierreTemprano > 0 && !d.justificado && <span className="text-red-600">−{d.minutosCierreTemprano}min cierre</span>}
                        {d.esTurnoExtra && <span className="text-amber-600 font-medium flex items-center gap-0.5"><Star className="h-3 w-3" />extra</span>}
                      </div>
                      {/* Acciones del día */}
                      <div className="flex gap-2 mt-1.5 items-center">
                        <button
                          disabled={guardarAjusteMut.isPending}
                          onClick={() => guardarAjusteMut.mutate({ trabajadorId: trabajadorSel!, fecha: d.fecha, justificado: !d.justificado, esTurnoExtra: d.esTurnoExtra, motivo: d.justificado ? null : "Justificado" })}
                          className={`text-[10px] px-2 py-0.5 rounded flex items-center gap-1 disabled:opacity-50 ${d.justificado ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground hover:bg-blue-100"}`}>
                          <ShieldCheck className="h-3 w-3" /> {d.justificado ? "Justificado" : "Justificar"}
                        </button>
                        <button
                          disabled={guardarAjusteMut.isPending}
                          onClick={() => guardarAjusteMut.mutate({ trabajadorId: trabajadorSel!, fecha: d.fecha, justificado: d.justificado, esTurnoExtra: !d.esTurnoExtra })}
                          className={`text-[10px] px-2 py-0.5 rounded flex items-center gap-1 disabled:opacity-50 ${d.esTurnoExtra ? "bg-amber-600 text-white" : "bg-muted text-muted-foreground hover:bg-amber-100"}`}>
                          <Star className="h-3 w-3" /> {d.esTurnoExtra ? "Turno extra" : "Marcar extra"}
                        </button>
                        {guardarAjusteMut.isPending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                      </div>
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
  if (vista === "pagos") {
    const d = dashboardPagos.data;
    return (
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between border-b border-foreground pb-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setVista("resumen")}><ChevronLeft className="h-5 w-5" /></Button>
            <h1 className="text-lg font-black uppercase tracking-tight">Pagos del mes</h1>
          </div>
          <Input type="month" value={anioMes} onChange={(e) => setAnioMes(e.target.value)} className="h-9 w-40" />
        </div>

        {dashboardPagos.isLoading ? (
          <div className="text-center py-12"><Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" /></div>
        ) : !d || d.trabajadores.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No hay trabajadores activos configurados.</p>
          </div>
        ) : (
          <>
            {/* Alerta de pendientes (después del día 15) */}
            {d.totales?.alertaActiva && (
              <Card className="border-2 border-red-500 bg-red-50 dark:bg-red-950/30">
                <CardContent className="p-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-bold text-sm text-red-700 dark:text-red-300">
                        Pagos pendientes ({d.totales.pendientes})
                      </p>
                      <p className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                        Faltan por pagar: {d.totales.nombresPendientes.join(", ")}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Totales */}
            <div className="grid grid-cols-2 gap-3">
              <Card><CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> Pagado</div>
                <p className="text-xl font-black">{d.totales?.totalPagado.toFixed(2)} <span className="text-sm">Bs</span></p>
                <p className="text-[11px] text-muted-foreground">{d.totales?.pagados} de {d.totales?.cantidad} trabajadores</p>
              </CardContent></Card>
              <Card className={d.totales && d.totales.totalPendiente > 0 ? "border-red-300" : ""}><CardContent className="p-3">
                <div className="flex items-center gap-1.5 text-muted-foreground text-xs mb-1"><Clock className="h-3.5 w-3.5 text-red-600" /> Por pagar</div>
                <p className="text-xl font-black">{d.totales?.totalPendiente.toFixed(2)} <span className="text-sm">Bs</span></p>
                <p className="text-[11px] text-muted-foreground">{d.totales?.pendientes} pendiente(s)</p>
              </CardContent></Card>
            </div>

            {/* Lista de trabajadores */}
            <div className="space-y-2">
              {d.trabajadores.map((t: any) => (
                <Card key={t.trabajadorId} className={t.pagado ? "border-green-200" : ""}>
                  <CardContent className="p-3 flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-bold text-sm">{t.nombre}</p>
                      {t.pagado ? (
                        <p className="text-[11px] text-green-600 flex items-center gap-1">
                          <CheckCircle2 className="h-3 w-3" /> Pagado{t.fechaPago ? ` el ${new Date(t.fechaPago).toLocaleDateString("es-BO")}` : ""}
                        </p>
                      ) : (
                        <p className="text-[11px] text-red-600">Pendiente de pago</p>
                      )}
                      {t.pagoTurnosExtra > 0 && (
                        <p className="text-[10px] text-amber-600 flex items-center gap-0.5"><Star className="h-2.5 w-2.5" /> +{t.pagoTurnosExtra.toFixed(2)} turnos extra (aparte)</p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-lg font-black ${t.pagado ? "text-green-600" : "text-primary"}`}>
                        {(t.pagado ? t.montoPagado : t.sueldoFinal).toFixed(2)}
                      </p>
                      <button
                        onClick={() => { setTrabajadorSel(t.trabajadorId); setVista("resumen"); }}
                        className="text-[10px] text-muted-foreground underline">Ver detalle</button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }


  if (vista === "trabajadores") {
    // Cruzar usuarios del sistema con trabajadores ya configurados
    const trabajadoresPorUsuario = new Map(
      (trabajadores || []).filter((t: any) => t.usuarioSistemaId).map((t: any) => [String(t.usuarioSistemaId), t])
    );
    const usuarios = usuariosSistema || [];
    const configurados = usuarios.filter((u: any) => trabajadoresPorUsuario.has(String(u.id)));
    const sinConfigurar = usuarios.filter((u: any) => !trabajadoresPorUsuario.has(String(u.id)));

    return (
      <div className="max-w-2xl mx-auto p-4 space-y-4">
        <div className="flex items-center justify-between border-b border-foreground pb-3">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setVista("resumen")}><ChevronLeft className="h-5 w-5" /></Button>
            <h1 className="text-lg font-black uppercase tracking-tight">Personal</h1>
          </div>
          <Button size="sm" variant="outline" onClick={() => { setEditando(null); setVista("form"); }} className="gap-1 text-xs">
            <Plus className="h-3 w-3" /> Manual
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Estos son los usuarios de inventarios365. Configura cada uno con su horario y sueldo para incluirlo en el control de asistencia.
        </p>

        {(isLoadingUsuarios || isLoading) ? (
          <div className="text-center py-12"><Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" /></div>
        ) : usuarios.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No se pudieron cargar los usuarios del sistema.</p>
            {errorUsuarios && <p className="text-[11px] text-red-600 mt-1 px-4">{errorUsuarios.message}</p>}
            <Button size="sm" variant="outline" onClick={() => refetchUsuarios()} className="mt-3 gap-1 text-xs">
              <Loader2 className="h-3 w-3" /> Reintentar
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Sin configurar */}
            {sinConfigurar.length > 0 && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                  Por configurar ({sinConfigurar.length})
                </p>
                <div className="space-y-2">
                  {sinConfigurar.map((u: any) => (
                    <Card key={u.id} className="border-dashed">
                      <CardContent className="p-3 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
                            {u.nombre.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-bold text-sm">{u.nombre}</p>
                            <p className="text-[11px] text-muted-foreground">Usuario del sistema · sin configurar</p>
                          </div>
                        </div>
                        <Button size="sm" onClick={() => { setEditando({ usuarioSistemaId: u.id, usuarioSistemaNombre: u.nombre, nombre: u.nombre }); setVista("form"); }} className="gap-1 text-xs">
                          <Plus className="h-3 w-3" /> Configurar
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Configurados */}
            {configurados.length > 0 && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
                  Configurados ({configurados.length})
                </p>
                <div className="space-y-2">
                  {configurados.map((u: any) => {
                    const t = trabajadoresPorUsuario.get(String(u.id));
                    return (
                      <Card key={u.id}>
                        <CardContent className="p-3 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="h-8 w-8 rounded-full bg-green-100 dark:bg-green-950 flex items-center justify-center text-xs font-bold text-green-700 dark:text-green-300">
                              {t.nombre.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="font-bold text-sm">{t.nombre}</p>
                              <p className="text-[11px] text-muted-foreground">
                                Entra {t.horaIngreso} · {t.horasDia}h/día · {parseFloat(t.sueldoMensual).toFixed(0)} Bs/mes
                              </p>
                            </div>
                          </div>
                          <Button variant="ghost" size="icon" onClick={() => { setEditando(t); setVista("form"); }}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Trabajadores manuales sin usuario del sistema */}
            {(trabajadores || []).filter((t: any) => !t.usuarioSistemaId).length > 0 && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Sin usuario vinculado</p>
                <div className="space-y-2">
                  {(trabajadores || []).filter((t: any) => !t.usuarioSistemaId).map((t: any) => (
                    <Card key={t.id} className="opacity-80">
                      <CardContent className="p-3 flex items-center justify-between">
                        <div>
                          <p className="font-bold text-sm">{t.nombre}</p>
                          <p className="text-[11px] text-orange-600">⚠️ Sin usuario del sistema (no se leerán aperturas de caja)</p>
                        </div>
                        <Button variant="ghost" size="icon" onClick={() => { setEditando(t); setVista("form"); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
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
  const [tipoTrabajador, setTipoTrabajador] = useState(editando?.tipoTrabajador || "fijo_mensual");
  const [horasMesFijas, setHorasMesFijas] = useState(editando?.horasMesFijas ?? 192);
  const [montoPorDia, setMontoPorDia] = useState(editando?.montoPorDia ? parseFloat(editando.montoPorDia) : 0);
  const [horaIngreso, setHoraIngreso] = useState(editando?.horaIngreso || "08:00");
  const [horaSalida, setHoraSalida] = useState(editando?.horaSalida && editando?.horaSalida !== "00:00" ? editando.horaSalida : "");
  const [montoTurnoExtra, setMontoTurnoExtra] = useState(editando?.montoTurnoExtra ? parseFloat(editando.montoTurnoExtra) : 0);
  const [horasDia, setHorasDia] = useState(editando?.horasDia ? parseFloat(editando.horasDia) : 8);
  const [diasMes, setDiasMes] = useState(editando?.diasMes || 26);
  // Días de la semana que trabaja (0=domingo..6=sábado), como Set
  const [diasSemana, setDiasSemana] = useState<Set<number>>(() => {
    const csv = editando?.diasSemana || "1,2,3,4,5,6";
    return new Set(csv.split(",").map(Number).filter((n: number) => !isNaN(n)));
  });
  const [sueldo, setSueldo] = useState(editando?.sueldoMensual ? parseFloat(editando.sueldoMensual) : 0);
  const [tipoDescuento, setTipoDescuento] = useState(editando?.tipoDescuento || "proporcional");
  const [montoFijo, setMontoFijo] = useState(editando?.montoDescuentoFijo ? parseFloat(editando.montoDescuentoFijo) : 10);
  const [tolerancia, setTolerancia] = useState(editando?.toleranciaMin ?? 5);
  // Si viene de un usuario del sistema sin configurar todavía, no tiene id de trabajador
  const esEdicionReal = !!editando?.id;

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
      diasMes: diasSemana.size > 0 ? diasSemana.size * 4 : Number(diasMes), // aproximado de respaldo
      diasSemana: Array.from(diasSemana).sort().join(","),
      tipoTrabajador,
      horasMesFijas: Number(horasMesFijas),
      montoPorDia: Number(montoPorDia),
      horaSalida: horaSalida || "00:00",
      montoTurnoExtra: Number(montoTurnoExtra),
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
        <h1 className="text-lg font-black uppercase tracking-tight">{esEdicionReal ? "Editar" : "Configurar"} trabajador</h1>
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

        {/* Tipo de trabajador */}
        <div className="border border-foreground/10 rounded-lg p-3 space-y-2">
          <Label className="text-xs font-bold">Tipo de pago</Label>
          <div className="grid grid-cols-1 gap-1.5">
            {[
              { v: "fijo_mensual", t: "Sueldo fijo mensual", d: "Lun-Sáb, 192h. Pago igual cada mes." },
              { v: "fijo_horas", t: "Fijo con horas personalizadas", d: "Sueldo fijo, pero defines las horas/mes." },
              { v: "por_dia", t: "Pago por día trabajado", d: "Domingos/feriados. Monto por cada día." },
              { v: "fijo_turnos", t: "Fijo por turnos", d: "Turnos de 24h. Pago fijo mensual." },
            ].map((opt) => (
              <button key={opt.v} type="button" onClick={() => setTipoTrabajador(opt.v)}
                className={`text-left p-2 rounded border text-xs ${tipoTrabajador === opt.v ? "border-primary bg-primary/10" : "border-foreground/15"}`}>
                <span className="font-medium">{opt.t}</span>
                <br /><span className="text-[10px] text-muted-foreground">{opt.d}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Hora ingreso</Label>
            <Input type="time" value={horaIngreso} onChange={(e) => setHoraIngreso(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Hora salida esperada</Label>
            <Input type="time" value={horaSalida} onChange={(e) => setHoraSalida(e.target.value)} />
            <p className="text-[10px] text-muted-foreground mt-0.5">Para detectar cierre temprano. Vacío = sin control.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Horas/día</Label>
            <Input type="number" value={horasDia} onChange={(e) => setHorasDia(parseFloat(e.target.value) || 0)} step="0.5" />
          </div>
          <div>
            <Label className="text-xs">Pago por turno extra (Bs)</Label>
            <Input type="number" value={montoTurnoExtra} onChange={(e) => setMontoTurnoExtra(parseFloat(e.target.value) || 0)} step="0.01" />
            <p className="text-[10px] text-muted-foreground mt-0.5">Si cubre domingos/feriados.</p>
          </div>
        </div>

        {/* Días de la semana que trabaja */}
        <div className="border border-foreground/10 rounded-lg p-3 space-y-2">
          <Label className="text-xs font-bold">Días que trabaja</Label>
          <div className="flex gap-1 flex-wrap">
            {[
              { n: 1, l: "L" }, { n: 2, l: "M" }, { n: 3, l: "Mi" }, { n: 4, l: "J" },
              { n: 5, l: "V" }, { n: 6, l: "S" }, { n: 0, l: "D" },
            ].map((d) => (
              <button key={d.n} type="button"
                onClick={() => setDiasSemana(prev => {
                  const s = new Set(prev);
                  if (s.has(d.n)) s.delete(d.n); else s.add(d.n);
                  return s;
                })}
                className={`w-9 h-9 rounded-full text-xs font-bold transition-colors ${diasSemana.has(d.n) ? "bg-primary text-white" : "bg-muted text-muted-foreground"}`}>
                {d.l}
              </button>
            ))}
          </div>
          {/* Presets rápidos */}
          <div className="flex gap-2 flex-wrap pt-1">
            <button type="button" onClick={() => setDiasSemana(new Set([1, 2, 3, 4, 5, 6]))}
              className="text-[11px] px-2 py-1 rounded bg-muted hover:bg-muted/70">Lun a Sáb</button>
            <button type="button" onClick={() => setDiasSemana(new Set([1, 2, 3, 4, 5]))}
              className="text-[11px] px-2 py-1 rounded bg-muted hover:bg-muted/70">Lun a Vie</button>
            <button type="button" onClick={() => setDiasSemana(new Set([0]))}
              className="text-[11px] px-2 py-1 rounded bg-muted hover:bg-muted/70">Solo domingos</button>
            <button type="button" onClick={() => setDiasSemana(new Set([0, 1, 2, 3, 4, 5, 6]))}
              className="text-[11px] px-2 py-1 rounded bg-muted hover:bg-muted/70">Todos</button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {diasSemana.size} día(s)/semana · ~{(diasSemana.size * Number(horasDia) * 4.33).toFixed(0)}h/mes aprox.
            El sistema cuenta los días reales de cada mes.
          </p>
        </div>

        {/* Campos según el tipo de pago */}
        {tipoTrabajador === "por_dia" ? (
          <div>
            <Label className="text-xs">Monto por día trabajado (Bs)</Label>
            <Input type="number" value={montoPorDia} onChange={(e) => setMontoPorDia(parseFloat(e.target.value) || 0)} step="0.01" />
            <p className="text-[11px] text-muted-foreground mt-0.5">Se paga este monto por cada día con caja abierta.</p>
          </div>
        ) : (
          <>
            <div>
              <Label className="text-xs">Sueldo mensual fijo (Bs)</Label>
              <Input type="number" value={sueldo} onChange={(e) => setSueldo(parseFloat(e.target.value) || 0)} step="0.01" />
            </div>
            <div>
              <Label className="text-xs">Horas base del mes</Label>
              <Input type="number" value={horasMesFijas} onChange={(e) => setHorasMesFijas(parseInt(e.target.value) || 0)} />
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Base para el valor hora y el descuento por retraso. Ej: 192 (Lun-Sáb), o las que definas.
              </p>
            </div>
          </>
        )}

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
