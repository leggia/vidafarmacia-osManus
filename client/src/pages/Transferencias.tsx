import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, ArrowLeftRight, CheckCircle2, Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useState } from "react";

export default function Transferencias() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: transfers, isLoading } = trpc.transfers.list.useQuery();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const confirmTransfer = trpc.transfers.confirm.useMutation({
    onSuccess: (r: any) => {
      if (r?.success === false) {
        toast.error(r.message || "No se pudo registrar en inventarios365", { duration: 9000 });
      } else if (r?.message && r.message.includes("OMITIDOS")) {
        toast.warning(r.message, { duration: 12000 });
      } else {
        toast.success(r?.message || "Transferencia registrada en inventarios365");
      }
      utils.transfers.list.invalidate();
      utils.dashboard.stats.invalidate();
      setConfirmingId(null);
    },
    onError: (err) => {
      toast.error(err.message || "Error al confirmar la transferencia");
      setConfirmingId(null);
    },
  });

  const handleConfirm = async (id: number) => {
    setConfirmingId(id);
    confirmTransfer.mutate({ id });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b border-foreground pb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">
            Transferencias
          </h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Movimiento de medicamentos entre sucursales
          </p>
        </div>
        <Button
          onClick={() => setLocation("/transferencias/nueva")}
          className="font-semibold uppercase tracking-wider text-sm gap-2"
        >
          <Plus className="h-4 w-4" />
          Nueva Transferencia
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded" />
          ))}
        </div>
      ) : transfers && transfers.length > 0 ? (
        <div className="space-y-2">
          {transfers.map((t: any) => (
            <Card key={t.id} className="border-foreground/10 hover:border-foreground/20 transition-colors">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 bg-foreground/5 rounded flex items-center justify-center">
                      <ArrowLeftRight className="h-5 w-5 text-foreground/60" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm">
                        {t.referenceNumber || `Transferencia #${t.id}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t.fromBranchName} → {t.toBranchName}
                      </p>
                      {t.itemCount > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t.itemCount} producto{t.itemCount !== 1 ? "s" : ""}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-muted-foreground">
                      {new Date(t.createdAt).toLocaleDateString("es-BO")}
                    </p>
                    <StatusBadge status={t.status} />
                    {(t.status === "draft" || t.status === "pending_sync") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleConfirm(t.id)}
                        disabled={confirmingId === t.id}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-green-600 text-green-700 hover:bg-green-50"
                      >
                        {confirmingId === t.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3 w-3" />
                        )}
                        Confirmar
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 border border-dashed border-foreground/20 rounded">
          <p className="text-muted-foreground text-sm">
            No hay transferencias registradas
          </p>
          <Button
            onClick={() => setLocation("/transferencias/nueva")}
            variant="outline"
            className="mt-4 uppercase tracking-wider text-xs font-semibold"
          >
            Registrar primera transferencia
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    draft: { label: "Borrador", className: "bg-gray-100 text-gray-600 border-gray-300" },
    pending_sync: { label: "Pendiente", className: "bg-yellow-50 text-yellow-700 border-yellow-300" },
    synced: { label: "Sincronizado", className: "bg-blue-50 text-blue-700 border-blue-300" },
    completed: { label: "Completado", className: "bg-green-50 text-green-700 border-green-300" },
    error: { label: "Error", className: "bg-red-50 text-red-700 border-red-300" },
  };
  const c = config[status] || { label: status, className: "bg-gray-100 text-gray-600 border-gray-300" };
  return (
    <Badge variant="outline" className={`text-xs uppercase tracking-wider font-medium ${c.className}`}>
      {c.label}
    </Badge>
  );
}
