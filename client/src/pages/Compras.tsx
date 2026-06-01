import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plus, CheckCircle2, Image as ImageIcon, Loader2,
  RefreshCw, AlertCircle, ExternalLink, Package, Zap, Trash2
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useState } from "react";

export default function Compras() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: purchases, isLoading } = trpc.purchases.list.useQuery();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [retryingAll, setRetryingAll] = useState(false);

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
        const result = await confirmMutation.mutateAsync({ id: p.id });
        if (result.syncSuccess) ok++;
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
                        {p.receiptNumber || `Compra #${p.id}`}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {p.supplier || "Sin proveedor"} — {p.branchName || "Central"}
                        {p.itemCount ? ` — ${p.itemCount} productos` : ""}
                      </p>
                      {/* Error de sincronización */}
                      {p.syncError && (
                        <p className="text-xs text-orange-700 mt-0.5 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate max-w-sm">{p.syncError}</span>
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
