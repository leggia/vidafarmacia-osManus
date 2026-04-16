import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, CheckCircle2, Image as ImageIcon, Loader2 } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useState } from "react";

export default function Compras() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: purchases, isLoading } = trpc.purchases.list.useQuery();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  const confirmMutation = trpc.purchases.confirm.useMutation({
    onSuccess: (_data, variables) => {
      toast.success(`Compra #${variables.id} confirmada exitosamente`);
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
    confirmMutation.mutate({ id });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b border-foreground pb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">
            Compras
          </h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Registro de compras con extracción automática por IA
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
              className="border-foreground/10 hover:border-foreground/20 transition-colors"
            >
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="h-10 w-10 bg-primary/10 rounded flex items-center justify-center">
                      {p.imageUrl ? (
                        <ImageIcon className="h-5 w-5 text-primary" />
                      ) : (
                        <span className="text-xs font-bold text-primary">
                          #{p.id}
                        </span>
                      )}
                    </div>
                    <div>
                      <p className="font-semibold text-sm">
                        {p.receiptNumber || `Compra #${p.id}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {p.supplier || "Sin proveedor"} —{" "}
                        {p.branchName || "Central"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <p className="text-sm font-bold">
                        {p.totalAmount ? `${p.totalAmount} BS` : "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(p.createdAt).toLocaleDateString("es-BO")}
                      </p>
                    </div>
                    <StatusBadge status={p.status} />
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
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 border border-dashed border-foreground/20 rounded">
          <p className="text-muted-foreground text-sm">
            No hay compras registradas
          </p>
          <Button
            onClick={() => setLocation("/compras/nueva")}
            variant="outline"
            className="mt-4 uppercase tracking-wider text-xs font-semibold"
          >
            Registrar primera compra
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
