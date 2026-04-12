import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, ArrowLeftRight, Image as ImageIcon } from "lucide-react";
import { useLocation } from "wouter";

export default function Transferencias() {
  const [, setLocation] = useLocation();
  const { data: transfers, isLoading } = trpc.transfers.list.useQuery();

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
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-muted-foreground">
                      {new Date(t.createdAt).toLocaleDateString("es-BO")}
                    </p>
                    <StatusBadge status={t.status} />
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
  const config: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    draft: { label: "Borrador", variant: "secondary" },
    pending_sync: { label: "Pendiente", variant: "outline" },
    synced: { label: "Sincronizado", variant: "default" },
    error: { label: "Error", variant: "destructive" },
  };
  const c = config[status] || { label: status, variant: "secondary" as const };
  return (
    <Badge variant={c.variant} className="text-xs uppercase tracking-wider font-medium">
      {c.label}
    </Badge>
  );
}
