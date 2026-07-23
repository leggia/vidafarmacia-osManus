/**
 * KARDEX — historial de movimientos de stock.
 *
 * Dos vistas:
 *  · Producto: cada entrada y salida con su saldo corriente, como un extracto
 *    bancario del stock.
 *  · Auditoría (admin): quién movió qué y cuándo, con filtros por usuario,
 *    tipo de movimiento y fecha.
 *
 * Mantiene el patrón visual del resto de la app: tarjeta con ícono bg-primary/10,
 * subtítulo con separadores y filas con fondo suave.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  BookOpen, Search, Loader2, ArrowDownCircle, ArrowUpCircle,
  ShieldCheck, Package, Filter, DownloadCloud, Scale,
} from "lucide-react";

// Color e ícono por tipo de movimiento
const ESTILO_TIPO: Record<string, { clase: string }> = {
  venta: { clase: "bg-blue-50 text-blue-700 border-blue-200" },
  compra: { clase: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  transferencia_entrada: { clase: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  transferencia_salida: { clase: "bg-violet-50 text-violet-700 border-violet-200" },
  ajuste_inventario: { clase: "bg-amber-50 text-amber-700 border-amber-200" },
  anulacion_venta: { clase: "bg-red-50 text-red-700 border-red-200" },
  devolucion: { clase: "bg-teal-50 text-teal-700 border-teal-200" },
};

function fechaCorta(f: any): string {
  if (!f) return "";
  const d = new Date(f);
  return d.toLocaleString("es-BO", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function Kardex() {
  const [vista, setVista] = useState<"producto" | "auditoria" | "cuadre">("producto");
  const [almacenCuadre, setAlmacenCuadre] = useState(1);
  const [busqueda, setBusqueda] = useState("");
  const [productoSel, setProductoSel] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const estado = trpc.ventas.kardexEstado.useQuery();
  const importar = trpc.ventas.kardexImportar.useMutation({
    onSuccess: (r: any) => {
      if (r.total > 0) toast.success(r.mensaje, { duration: 9000 });
      else toast.info(r.mensaje, { duration: 6000 });
      utils.ventas.kardexEstado.invalidate();
      utils.ventas.kardexAuditoria.invalidate();
      utils.ventas.kardexProducto.invalidate();
    },
    onError: (e) => toast.error("No se pudo importar: " + e.message),
  });
  const sugerencias = trpc.ventas.kardexBuscar.useQuery(
    { texto: busqueda },
    { enabled: busqueda.trim().length >= 2 && !productoSel },
  );
  const kardex = trpc.ventas.kardexProducto.useQuery(
    { producto: productoSel ?? "" },
    { enabled: !!productoSel },
  );

  // Auditoría
  const [filtroUsuario, setFiltroUsuario] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  const cuadre = trpc.ventas.kardexReconciliar.useQuery(
    { almacenId: almacenCuadre },
    { enabled: vista === "cuadre" },
  );
  const auditoria = trpc.ventas.kardexAuditoria.useQuery(
    { usuario: filtroUsuario || undefined, tipo: filtroTipo || undefined, limite: 150 },
    { enabled: vista === "auditoria" },
  );

  return (
    <div className="p-4 space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-xl font-black tracking-tight flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-primary" /> Kardex
        </h1>
        <p className="text-xs text-muted-foreground">
          Historial de movimientos de stock
          {estado.data && estado.data.total > 0 && (
            <> · {estado.data.total.toLocaleString("es-BO")} movimientos de {estado.data.productos} productos</>
          )}
        </p>
      </div>

      {/* Selector de vista */}
      <div className="flex gap-2">
        <Button size="sm" variant={vista === "producto" ? "default" : "outline"}
          onClick={() => setVista("producto")} className="gap-1 text-xs">
          <Package className="h-3 w-3" /> Por producto
        </Button>
        <Button size="sm" variant={vista === "auditoria" ? "default" : "outline"}
          onClick={() => setVista("auditoria")} className="gap-1 text-xs">
          <ShieldCheck className="h-3 w-3" /> Auditoría
        </Button>
        <Button size="sm" variant={vista === "cuadre" ? "default" : "outline"}
          onClick={() => setVista("cuadre")} className="gap-1 text-xs">
          <Scale className="h-3 w-3" /> Cuadre
        </Button>
      </div>

      {/* Importación del histórico: reconstruye el libro con lo ya registrado */}
      {estado.data && (
        <div className={`rounded-lg border p-3 text-xs ${estado.data.total === 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-foreground/15 bg-muted/30"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {estado.data.total === 0 ? (
                <p>
                  El libro está vacío. Se llenará solo con cada movimiento nuevo, y
                  puedes traer el histórico que ya tiene el sistema.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  <b className="text-foreground">{estado.data.envivo?.toLocaleString("es-BO")}</b> registrados en vivo
                  {estado.data.importados ? <> · <b className="text-foreground">{estado.data.importados.toLocaleString("es-BO")}</b> importados del histórico</> : null}
                  {estado.data.desde ? <> · desde {new Date(estado.data.desde).toLocaleDateString("es-BO")}</> : null}
                </p>
              )}
            </div>
            <Button size="sm" variant="outline" className="gap-1 text-xs shrink-0"
              disabled={importar.isPending}
              onClick={() => importar.mutate({})}>
              {importar.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <DownloadCloud className="h-3 w-3" />}
              Importar histórico
            </Button>
          </div>
          {importar.data?.quedaMas && (
            <p className="mt-1.5 text-amber-700">
              Quedan más movimientos por traer: vuelve a tocar "Importar histórico" para continuar.
            </p>
          )}
        </div>
      )}

      {vista === "producto" ? (
        <>
          {/* Buscador */}
          <div className="relative">
            <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={productoSel ?? busqueda}
              onChange={(e) => { setProductoSel(null); setBusqueda(e.target.value); }}
              placeholder="Buscar producto…"
              className="pl-9 text-sm"
            />
          </div>

          {/* Sugerencias */}
          {!productoSel && busqueda.trim().length >= 2 && (
            <div className="space-y-1">
              {sugerencias.isFetching && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" /> Buscando…
                </p>
              )}
              {sugerencias.data?.map((p: any) => (
                <button key={p.articuloClave}
                  onClick={() => { setProductoSel(p.articuloNombre); setBusqueda(p.articuloNombre); }}
                  className="w-full text-left rounded-md border px-3 py-2 hover:border-primary/50 hover:bg-primary/5 transition">
                  <p className="text-sm font-medium truncate">{p.articuloNombre}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {p.movimientos} movimientos · último {fechaCorta(p.ultimoMovimiento)}
                  </p>
                </button>
              ))}
              {sugerencias.data?.length === 0 && !sugerencias.isFetching && (
                <p className="text-xs text-muted-foreground">Sin movimientos para esa búsqueda.</p>
              )}
            </div>
          )}

          {/* Kardex del producto */}
          {productoSel && kardex.isFetching && (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          )}
          {productoSel && kardex.data && (
            <Card>
              <CardContent className="py-4 space-y-3">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 flex-shrink-0 bg-primary/10 rounded flex items-center justify-center">
                    <Package className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{kardex.data.producto}</p>
                    <p className="text-xs text-muted-foreground">
                      {kardex.data.totalMovimientos} movimientos — entradas {kardex.data.entradas} — salidas {kardex.data.salidas}
                    </p>
                  </div>
                  <div className="ml-auto text-right shrink-0">
                    <p className="text-lg font-black tabular-nums">{kardex.data.saldoCalculado}</p>
                    <p className="text-[10px] text-muted-foreground">saldo del libro</p>
                  </div>
                </div>

                {kardex.data.movimientos.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-3">Sin movimientos registrados.</p>
                ) : (
                  <div className="space-y-1.5">
                    {kardex.data.movimientos.map((m: any) => (
                      <div key={m.id} className="flex items-start gap-2 text-xs bg-muted/30 rounded-md px-2.5 py-2">
                        <div className="shrink-0 mt-0.5">
                          {m.cantidad > 0
                            ? <ArrowDownCircle className="h-4 w-4 text-emerald-600" />
                            : <ArrowUpCircle className="h-4 w-4 text-red-500" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${ESTILO_TIPO[m.tipo]?.clase ?? ""}`}>
                              {m.tipoEtiqueta}
                            </Badge>
                            <span className="text-muted-foreground">{fechaCorta(m.fecha)}</span>
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate">
                            {m.usuario ? `${m.usuario}` : "sin usuario"}
                            {m.sucursal ? ` · ${m.sucursal}` : ""}
                            {m.detalle ? ` · ${m.detalle}` : ""}
                            {m.origen === "importado" ? " · histórico" : ""}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`font-bold tabular-nums ${m.cantidad > 0 ? "text-emerald-700" : "text-red-600"}`}>
                            {m.cantidad > 0 ? "+" : ""}{m.cantidad}
                          </p>
                          <p className="text-[10px] text-muted-foreground tabular-nums">saldo {m.saldo}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      ) : vista === "cuadre" ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Almacén</span>
            <select value={almacenCuadre} onChange={(e) => setAlmacenCuadre(Number(e.target.value))}
              className="h-9 rounded-md border bg-background px-2 text-xs">
              <option value={1}>Almacén Principal</option>
              <option value={2}>Almacén Petrolera</option>
              <option value={3}>Almacén Lanza</option>
              <option value={4}>Almacén Cobol</option>
            </select>
          </div>

          {cuadre.isFetching && (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          )}
          {cuadre.data && (
            <>
              <Card>
                <CardContent className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-black uppercase tracking-wider">Cuadre con 365</p>
                      <p className="text-[11px] text-muted-foreground">
                        {cuadre.data.comparados} productos comparados
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-lg font-black ${cuadre.data.conDiferencia === 0 ? "text-emerald-700" : "text-amber-700"}`}>
                        {cuadre.data.conDiferencia}
                      </p>
                      <p className="text-[10px] text-muted-foreground">con diferencia</p>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2">{cuadre.data.nota}</p>
                </CardContent>
              </Card>

              <div className="space-y-1.5">
                {cuadre.data.diferencias.map((d: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded-md px-2.5 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{d.producto}</p>
                      <p className="text-[11px] text-muted-foreground">
                        365: {d.stock365} · libro: {d.saldoLibro} · {d.movimientos} movimientos
                      </p>
                    </div>
                    <p className={`font-bold tabular-nums shrink-0 ${d.diferencia > 0 ? "text-emerald-700" : "text-red-600"}`}>
                      {d.diferencia > 0 ? "+" : ""}{d.diferencia}
                    </p>
                  </div>
                ))}
                {cuadre.data.conDiferencia === 0 && (
                  <p className="text-xs text-emerald-700 text-center py-4">
                    Todo cuadra: el libro coincide con el stock de 365.
                  </p>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <>
          {/* Filtros de auditoría */}
          <div className="flex gap-2 flex-wrap items-center">
            <div className="relative flex-1 min-w-[140px]">
              <Filter className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={filtroUsuario} onChange={(e) => setFiltroUsuario(e.target.value)}
                placeholder="Filtrar por usuario…" className="pl-8 h-9 text-xs" />
            </div>
            <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-xs">
              <option value="">Todos los tipos</option>
              <option value="ajuste_inventario">Ajustes de inventario</option>
              <option value="transferencia_salida">Transferencias enviadas</option>
              <option value="transferencia_entrada">Transferencias recibidas</option>
              <option value="compra">Compras</option>
              <option value="venta">Ventas</option>
            </select>
          </div>

          {/* Resumen por usuario */}
          {auditoria.data?.porUsuario && auditoria.data.porUsuario.length > 0 && (
            <Card>
              <CardContent className="py-3">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  Movimientos por persona
                </p>
                <div className="space-y-1">
                  {auditoria.data.porUsuario.slice(0, 8).map((u: any, i: number) => (
                    <div key={i} className="flex items-center justify-between text-xs gap-2">
                      <span className="truncate">
                        <b>{u.usuario}</b> <span className="text-muted-foreground">· {u.tipoEtiqueta}</span>
                      </span>
                      <span className="tabular-nums shrink-0 text-muted-foreground">
                        {u.movimientos} mov · {u.unidades} u.
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Movimientos */}
          {auditoria.isFetching && (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          )}
          <div className="space-y-1.5">
            {auditoria.data?.movimientos.map((m: any) => (
              <div key={m.id} className="flex items-start gap-2 text-xs bg-muted/30 rounded-md px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${ESTILO_TIPO[m.tipo]?.clase ?? ""}`}>
                      {m.tipoEtiqueta}
                    </Badge>
                    <span className="font-medium truncate">{m.usuario || "sin usuario"}</span>
                    <span className="text-muted-foreground">{fechaCorta(m.fecha)}</span>
                  </div>
                  <p className="text-[11px] truncate">{m.articuloNombre}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {m.sucursal ?? ""}{m.detalle ? ` · ${m.detalle}` : ""}
                  </p>
                </div>
                <p className={`font-bold tabular-nums shrink-0 ${m.cantidad > 0 ? "text-emerald-700" : "text-red-600"}`}>
                  {m.cantidad > 0 ? "+" : ""}{m.cantidad}
                </p>
              </div>
            ))}
            {auditoria.data?.movimientos.length === 0 && !auditoria.isFetching && (
              <p className="text-xs text-muted-foreground text-center py-4">
                No hay movimientos con esos filtros.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
