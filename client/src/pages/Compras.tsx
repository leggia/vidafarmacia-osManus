import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plus, CheckCircle2, Image as ImageIcon, Loader2,
  RefreshCw, AlertCircle, ExternalLink, Package
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useState } from "react";

export default function Compras() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: purchases, isLoading } = trpc.purchases.list.useQuery();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

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
      {
        onSettled: () => toast.dismiss(`sync-${id}`),
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b border-foreground pb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">Compras</h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Extracción automática por IA · Sincronización con inventarios365.com
          </p>
        </div>
        <Button
          onClick={() => setLocation("/compras/nueva")}
          className="font-semibold uppercase tracking-wider text-sm gap-2"
        >
          <Plus className="h-4 w-4" />
          Nueva Compra
        </Button>
      </div>

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
                p.status === "error" || p.syncError ? "border-red-300 bg-red-50/30" : ""
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
                      </p>
                      {/* Mostrar error de sincronización si existe */}
                      {p.syncError && (
                        <p className="text-xs text-red-600 mt-0.5 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate max-w-xs">{p.syncError}</span>
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

                    {/* Botón Confirmar (borrador) */}
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

                    {/* Botón Reintentar sync (si hay error) */}
                    {p.status === "completed" && p.syncError && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleConfirm(p.id)}
                        disabled={confirmingId === p.id}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-red-300 text-red-600 hover:bg-red-50"
                      >
                        {confirmingId === p.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        Reintentar
                      </Button>
                    )}

                    {/* Link a inventarios365 si está completado y sincronizado */}
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
  // Si está completado pero con error de sync, mostrar advertencia
  if (status === "completed" && syncError) {
    return (
      <Badge variant="outline" className="text-xs uppercase tracking-wider font-medium bg-orange-50 text-orange-700 border-orange-300">
        Sin sync
      </Badge>
    );
  }
  const config: Record<string, { label: string; className: string }> = {
    draft:        { label: "Borrador",    className: "bg-gray-100 text-gray-600 border-gray-300" },
    pending_sync: { label: "Pendiente",   className: "bg-yellow-50 text-yellow-700 border-yellow-300" },
    synced:       { label: "Sincronizado",className: "bg-blue-50 text-blue-700 border-blue-300" },
    completed:    { label: "✓ Sincronizado", className: "bg-green-50 text-green-700 border-green-300" },
    error:        { label: "Error",       className: "bg-red-50 text-red-700 border-red-300" },
  };
  const c = config[status] || { label: status, className: "bg-gray-100 text-gray-600 border-gray-300" };
  return (
    <Badge variant="outline" className={`text-xs uppercase tracking-wider font-medium ${c.className}`}>
      {c.label}
    </Badge>
  );
}
