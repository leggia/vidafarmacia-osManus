import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plus, CheckCircle2, Image as ImageIcon, Loader2,
  RefreshCw, AlertCircle, ExternalLink, Package, Zap, Trash2, Pencil,
  Eye, ChevronDown, ChevronUp, Calendar
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useState, useEffect } from "react";

export default function Compras() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: purchases, isLoading } = trpc.purchases.list.useQuery();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);
  const [expandidaId, setExpandidaId] = useState<number | null>(null);

  // Al abrir la lista de compras, subir al inicio (evita quedar abajo tras registrar)
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, []);

  const confirmMutation = trpc.purchases.confirm.useMutation({
    onSuccess: (data, variables) => {
      if (data.syncSuccess) {
        toast.success(
          `✓ Compra #${variables.id} registrada en inventarios365.com` +
          (data.syncIngresoId ? ` (Ingreso ID: ${data.syncIngresoId})` : ""),
          { duration: 6000 }
        );
      } else {
        toast.warning(
          `Compra #${variables.id} confirmada, pero no se pudo sincronizar: ${data.syncMessage}`,
          { duration: 8000 }
        );
      }
      utils.purchases.list.invalidate();
      utils.dashboard.stats.invalidate();
      setConfirmingId(null);
    },
    onError: (err) => {
      toast.error(err.message || "Error al confirmar la compra");
      setConfirmingId(null);
    },
  });

  const handleConfirm = (id: number) => {
    setConfirmingId(id);
    toast.loading("Confirmando y sincronizando con inventarios365...", { id: `sync-${id}` });
    confirmMutation.mutate(
      { id },
      { onSettled: () => toast.dismiss(`sync-${id}`) }
    );
  };

  const deleteMutation = trpc.purchases.delete.useMutation({
    onSuccess: () => {
      toast.success("Compra eliminada de la lista");
      utils.purchases.list.invalidate();
      utils.dashboard.stats.invalidate();
    },
    onError: (err) => toast.error(err.message || "Error al eliminar"),
  });

  const handleDelete = (id: number, receiptNumber: string) => {
    if (confirm(`¿Eliminar la compra ${receiptNumber || "#" + id} de la lista? Esto NO la borra de inventarios365.com, solo de esta lista local.`)) {
      deleteMutation.mutate({ id });
    }
  };

  // APLICAR SOLO PRECIOS: corrige los precios de venta que 365 no aplicó, SIN
  // crear otro ingreso (re-sincronizar duplicaría la compra en 365).
  const aplicarPrecios = trpc.purchases.aplicarPreciosVenta.useMutation();
  const [aplicandoId, setAplicandoId] = useState<number | null>(null);
  const handleAplicarPrecios = async (p: any) => {
    setAplicandoId(p.id);
    try {
      const r: any = await aplicarPrecios.mutateAsync({ id: p.id });
      if (r.ok) toast.success(r.mensaje, { duration: 9000 });
      else toast.error(r.mensaje, { duration: 12000 });
      await utils.purchases.list.invalidate();
    } catch (e: any) {
      toast.error("No se pudo aplicar los precios: " + (e?.message || ""));
    } finally {
      setAplicandoId(null);
    }
  };

  // RE-SINCRONIZAR una compra usando sus datos ya guardados (con los precios
  // editados a mano). Si ya estaba sincronizada, el backend pide confirmación
  // porque 365 creará OTRO ingreso — el viejo hay que borrarlo allá a mano.
  const reintentarSync = trpc.purchases.reintentarSync.useMutation();
  const [reintentandoId, setReintentandoId] = useState<number | null>(null);
  const handleReintentar = async (p: any) => {
    setReintentandoId(p.id);
    try {
      let r: any = await reintentarSync.mutateAsync({ id: p.id });
      if (r.requiereConfirmacion) {
        const ok = window.confirm(
          `${r.mensaje}\n\n¿Ya borraste el Ingreso #${r.ingresoIdPrevio} en inventarios365 y quieres continuar?`
        );
        if (!ok) { setReintentandoId(null); return; }
        r = await reintentarSync.mutateAsync({ id: p.id, forzar: true });
      }
      if (r.ok) toast.success(r.mensaje, { duration: 9000 });
      else toast.error(r.mensaje, { duration: 9000 });
      await utils.purchases.list.invalidate();
    } catch (e: any) {
      toast.error("No se pudo re-sincronizar: " + (e?.message || ""));
    } finally {
      setReintentandoId(null);
    }
  };

  // Reintentar sincronización para todas las compras con error
  const handleRetryAll = async () => {
    const withErrors = (purchases || []).filter(
      (p: any) => p.status === "completed" && p.syncError
    );
    if (withErrors.length === 0) {
      toast.info("No hay compras pendientes de sincronización");
      return;
    }
    setRetryingAll(true);
    toast.loading(`Reintentando sincronización de ${withErrors.length} compra(s)...`, { id: "retry-all" });
    let ok = 0;
    let fail = 0;
    for (const p of withErrors) {
      try {
        // Usa reintentarSync (no confirm): recupera los precios de venta editados
        // que quedaron guardados. Estas ya fallaron, así que no hay ingreso previo
        // en 365 que pueda duplicarse — forzar es seguro aquí.
        const result: any = await reintentarSync.mutateAsync({ id: p.id, forzar: true });
        if (result.ok) ok++;
        else fail++;
      } catch {
        fail++;
      }
    }
    toast.dismiss("retry-all");
    toast.success(`Reintento completado: ${ok} sincronizadas, ${fail} con error`, { duration: 6000 });
    await utils.purchases.list.invalidate();
    await utils.dashboard.stats.invalidate();
    setRetryingAll(false);
  };

  const errorCount = (purchases || []).filter(
    (p: any) => p.status === "completed" && p.syncError
  ).length;
  const draftCount = (purchases || []).filter((p: any) => p.status === "draft").length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b border-foreground pb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">Compras</h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Extracción automática por IA · Sincronización con inventarios365.com
          </p>
        </div>
        <div className="flex gap-2">
          {errorCount > 0 && (
            <Button
              variant="outline"
              onClick={handleRetryAll}
              disabled={retryingAll}
              className="gap-2 text-xs uppercase tracking-wider font-semibold border-orange-300 text-orange-700 hover:bg-orange-50"
            >
              {retryingAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              Reintentar {errorCount} con error
            </Button>
          )}
          <Button
            onClick={() => setLocation("/compras/nueva")}
            className="font-semibold uppercase tracking-wider text-sm gap-2"
          >
            <Plus className="h-4 w-4" />
            Nueva Compra
          </Button>
        </div>
      </div>

      {/* Alertas de estado */}
      {!isLoading && draftCount > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded p-3 flex items-center gap-2 text-sm text-yellow-800">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>
            Tienes <strong>{draftCount}</strong> compra(s) en borrador sin confirmar. Confírmalas para sincronizarlas con inventarios365.com.
          </span>
        </div>
      )}
      {!isLoading && errorCount > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded p-3 flex items-center gap-2 text-sm text-orange-800">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>
            <strong>{errorCount}</strong> compra(s) no se sincronizaron con inventarios365.com. Usa el botón "Reintentar" para reenviarlas.
          </span>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded" />
          ))}
        </div>
      ) : purchases && purchases.length > 0 ? (
        <div className="space-y-2">
          {purchases.map((p: any) => (
            <Card
              key={p.id}
              className={`border-foreground/10 hover:border-foreground/20 transition-colors ${
                p.status === "error" || p.syncError ? "border-orange-300 bg-orange-50/20" : ""
              }`}
            >
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-3">
                  {/* Icono + Info */}
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="h-10 w-10 flex-shrink-0 bg-primary/10 rounded flex items-center justify-center">
                      {p.imageUrl ? (
                        <ImageIcon className="h-5 w-5 text-primary" />
                      ) : (
                        <Package className="h-5 w-5 text-primary" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">
                        {p.supplier || "Sin proveedor"}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {p.receiptNumber || `Compra #${p.id}`} — {p.branchName || "Central"}
                        {p.itemCount ? ` — ${p.itemCount} productos` : ""}
                      </p>
                      {/* Error de sincronización */}
                      {p.syncError && (
                        <p className="text-xs text-orange-700 mt-0.5 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate max-w-sm">{p.syncError}</span>
                        </p>
                      )}
                      {/* Precios que no quedaron aplicados en 365 (tras verificar y reintentar) */}
                      {p.preciosFallidos && (
                        <p className="text-xs text-red-700 mt-0.5 flex items-center gap-1 font-bold">
                          <AlertCircle className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate max-w-sm">Precio de venta sin aplicar: {p.preciosFallidos}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Acciones */}
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-sm font-bold">
                        {p.totalAmount ? `${parseFloat(p.totalAmount).toFixed(2)} BS` : "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(p.createdAt).toLocaleDateString("es-BO")}
                      </p>
                    </div>
                    <StatusBadge status={p.status} syncError={p.syncError} />

                    {/* Reparar precios: SOLO aparece si la sincronización dejó
                        algún precio sin aplicar. En el uso normal no se ve — la
                        compra sincroniza todo junto (ingreso + costos + precios
                        verificados) y este botón no hace falta. */}
                    {p.preciosFallidos && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleAplicarPrecios(p)}
                        disabled={aplicandoId === p.id}
                        title={`Precios que no quedaron en 365: ${p.preciosFallidos}. Los vuelve a aplicar (sin crear otro ingreso).`}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-red-300 text-red-700 hover:bg-red-50"
                      >
                        {aplicandoId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                        Corregir precios
                      </Button>
                    )}

                    {/* RE-SINCRONIZAR: usa los datos YA GUARDADOS (incluidos los
                        precios editados a mano) — no hay que volver a cargar la
                        factura ni re-editar. Para las ya sincronizadas avisa
                        primero, porque 365 crea OTRO ingreso (no permite borrar
                        por API) y el viejo hay que borrarlo allá. */}
                    {p.status !== "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleReintentar(p)}
                        disabled={reintentandoId === p.id}
                        title={p.syncIngresoId ? `Ya sincronizada (Ingreso #${p.syncIngresoId})` : "Reintentar sincronización con 365"}
                        className={`gap-1 text-xs uppercase tracking-wider font-semibold ${p.syncError ? "border-orange-400 text-orange-700 hover:bg-orange-50" : ""}`}
                      >
                        {reintentandoId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        {p.syncError ? "Reintentar" : "Re-sincronizar"}
                      </Button>
                    )}


                    {/* Continuar borrador (editar) */}
                    {p.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setLocation(`/compras/nueva?borrador=${p.id}`)}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-blue-300 text-blue-700 hover:bg-blue-50"
                      >
                        <Pencil className="h-3 w-3" />
                        Continuar
                      </Button>
                    )}

                    {/* Confirmar borrador */}
                    {p.status === "draft" && (
                      <Button
                        size="sm"
                        onClick={() => handleConfirm(p.id)}
                        disabled={confirmingId === p.id}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold bg-green-700 hover:bg-green-800 text-white"
                      >
                        {confirmingId === p.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                        Confirmar
                      </Button>
                    )}

                    {/* Reintentar sync */}
                    {p.status === "completed" && p.syncError && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleConfirm(p.id)}
                        disabled={confirmingId === p.id || retryingAll}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-orange-300 text-orange-700 hover:bg-orange-50"
                      >
                        {confirmingId === p.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Reintentar
                      </Button>
                    )}

                    {/* Link a inventarios365 si sincronizado */}
                    {p.status === "completed" && !p.syncError && (
                      <a
                        href="https://vidafarmacia.inventarios365.com/main#/ingreso"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 font-medium"
                        title="Ver en inventarios365.com"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span className="hidden sm:inline">Ver en inv365</span>
                      </a>
                    )}

                    {/* Ver detalle de la compra */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpandidaId(expandidaId === p.id ? null : p.id)}
                      className="gap-1 text-xs text-muted-foreground hover:text-foreground"
                      title="Ver detalle de productos"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {expandidaId === p.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </Button>

                    {/* Eliminar de la lista */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDelete(p.id, p.receiptNumber)}
                      disabled={deleteMutation.isPending}
                      className="gap-1 text-xs text-red-600 hover:text-red-800 hover:bg-red-50"
                      title="Eliminar de la lista (no afecta inventarios365)"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>

                {/* Detalle expandible de la compra */}
                {expandidaId === p.id && <DetalleCompra purchaseId={p.id} />}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 border border-dashed border-foreground/20 rounded">
          <Package className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground text-sm font-medium">No hay compras registradas</p>
          <p className="text-muted-foreground text-xs mt-1">
            Suba una factura PDF o imagen para comenzar
          </p>
          <Button
            onClick={() => setLocation("/compras/nueva")}
            className="mt-4 uppercase tracking-wider text-xs font-semibold"
          >
            <Plus className="h-4 w-4 mr-2" />
            Registrar primera compra
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, syncError }: { status: string; syncError?: string | null }) {
  if (status === "completed" && syncError) {
    return (
      <Badge variant="outline" className="text-xs uppercase tracking-wider font-medium bg-orange-50 text-orange-700 border-orange-300">
        Sin sync
      </Badge>
    );
  }
  const config: Record<string, { label: string; className: string }> = {
    draft:        { label: "Borrador",       className: "bg-gray-100 text-gray-600 border-gray-300" },
    pending_sync: { label: "Pendiente",      className: "bg-yellow-50 text-yellow-700 border-yellow-300" },
    synced:       { label: "Sincronizado",   className: "bg-blue-50 text-blue-700 border-blue-300" },
    completed:    { label: "✓ Sincronizado", className: "bg-green-50 text-green-700 border-green-300" },
    error:        { label: "Error",          className: "bg-red-50 text-red-700 border-red-300" },
  };
  const c = config[status] || { label: status, className: "bg-gray-100 text-gray-600 border-gray-300" };
  return (
    <Badge variant="outline" className={`text-xs uppercase tracking-wider font-medium ${c.className}`}>
      {c.label}
    </Badge>
  );
}

function DetalleCompra({ purchaseId }: { purchaseId: number }) {
  const { data, isLoading } = trpc.purchases.getById.useQuery({ id: purchaseId });

  if (isLoading) {
    return (
      <div className="mt-3 pt-3 border-t flex items-center justify-center py-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data || !data.items || data.items.length === 0) {
    return (
      <div className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center py-2">
        No hay detalle de productos para esta compra.
      </div>
    );
  }

  const fmt = (n: any) => Number(n || 0).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalCalc = data.items.reduce((s: number, it: any) => s + Number(it.subtotal || 0), 0);

  return (
    <div className="mt-3 pt-3 border-t">
      <p className="text-[11px] font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
        Detalle ({data.items.length} producto{data.items.length !== 1 ? "s" : ""})
      </p>
      <div className="space-y-1.5">
        {data.items.map((it: any, i: number) => (
          <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded-md px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{it.productName}</p>
              {it.expiryDate && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-2.5 w-2.5" />
                  Vence: {new Date(it.expiryDate).toLocaleDateString("es-BO")}
                </p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="tabular-nums">{fmt(it.quantity)} × {fmt(it.unitCost)} Bs</p>
              <p className="font-bold tabular-nums">{fmt(it.subtotal)} Bs</p>
              {it.precioVenta != null && Number(it.precioVenta) > 0 && (
                <p className="text-[10px] text-emerald-600 dark:text-emerald-400 tabular-nums">Venta: {fmt(it.precioVenta)} Bs</p>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between items-center mt-2 pt-2 border-t text-xs">
        <span className="font-semibold">Total</span>
        <span className="font-black tabular-nums">{fmt(totalCalc)} Bs</span>
      </div>
    </div>
  );
}
