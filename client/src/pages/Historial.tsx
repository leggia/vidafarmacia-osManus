import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ShoppingCart,
  ArrowLeftRight,
  CheckCircle2,
  AlertTriangle,
  Info,
} from "lucide-react";

export default function Historial() {
  const { data: history, isLoading } = trpc.operationHistory.list.useQuery();

  return (
    <div className="space-y-6">
      <div className="border-b border-foreground pb-4">
        <h1 className="text-3xl font-black tracking-tight uppercase">
          Historial
        </h1>
        <p className="text-sm text-muted-foreground mt-1 tracking-wide">
          Registro completo de todas las operaciones procesadas
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-14 bg-muted animate-pulse rounded" />
          ))}
        </div>
      ) : history && history.length > 0 ? (
        <div className="space-y-1">
          {history.map((entry: any) => (
            <Card key={entry.id} className="border-foreground/5">
              <CardContent className="py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-8 w-8 rounded flex items-center justify-center ${
                        entry.status === "success"
                          ? "bg-green-500/10"
                          : entry.status === "error"
                            ? "bg-destructive/10"
                            : "bg-muted"
                      }`}
                    >
                      {entry.type === "purchase" ? (
                        <ShoppingCart className="h-4 w-4" />
                      ) : (
                        <ArrowLeftRight className="h-4 w-4" />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {entry.action} —{" "}
                        {entry.type === "purchase" ? "Compra" : "Transferencia"}{" "}
                        #{entry.referenceId}
                      </p>
                      {entry.details && (
                        <p className="text-xs text-muted-foreground">
                          {entry.details}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleString("es-BO")}
                    </span>
                    <HistoryStatusBadge status={entry.status} />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 border border-dashed border-foreground/20 rounded">
          <Info className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground text-sm">
            No hay operaciones en el historial
          </p>
        </div>
      )}
    </div>
  );
}

function HistoryStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    success: { label: "Exitoso", variant: "default" },
    error: { label: "Error", variant: "destructive" },
    info: { label: "Info", variant: "secondary" },
  };
  const c = config[status] || { label: status, variant: "secondary" as const };
  return (
    <Badge variant={c.variant} className="text-xs uppercase tracking-wider font-medium">
      {c.label}
    </Badge>
  );
}
