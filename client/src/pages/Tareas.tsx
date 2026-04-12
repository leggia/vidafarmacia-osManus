import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RotateCcw, Clock, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export default function Tareas() {
  const { data: tasks, isLoading, refetch } = trpc.taskQueue.list.useQuery();
  const retryTask = trpc.taskQueue.retry.useMutation({
    onSuccess: () => {
      toast.success("Tarea reencolada exitosamente");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div className="space-y-6">
      <div className="border-b border-foreground pb-4">
        <h1 className="text-3xl font-black tracking-tight uppercase">
          Tareas Pendientes
        </h1>
        <p className="text-sm text-muted-foreground mt-1 tracking-wide">
          Cola de sincronización con inventarios365.com
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded" />
          ))}
        </div>
      ) : tasks && tasks.length > 0 ? (
        <div className="space-y-2">
          {tasks.map((task: any) => (
            <Card
              key={task.id}
              className={`border-foreground/10 ${
                task.status === "failed"
                  ? "border-destructive/30"
                  : task.status === "completed"
                    ? "border-green-500/30"
                    : ""
              }`}
            >
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div
                      className={`h-10 w-10 rounded flex items-center justify-center ${
                        task.status === "failed"
                          ? "bg-destructive/10"
                          : task.status === "completed"
                            ? "bg-green-500/10"
                            : "bg-muted"
                      }`}
                    >
                      {task.status === "failed" ? (
                        <AlertTriangle className="h-5 w-5 text-destructive" />
                      ) : task.status === "completed" ? (
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                      ) : (
                        <Clock className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <p className="font-semibold text-sm">
                        {task.type === "purchase_sync"
                          ? "Sincronizar Compra"
                          : "Sincronizar Transferencia"}{" "}
                        #{task.referenceId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Intentos: {task.attempts}/{task.maxAttempts}
                        {task.lastError && (
                          <span className="text-destructive ml-2">
                            — {task.lastError}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <TaskStatusBadge status={task.status} />
                    {(task.status === "failed" || task.status === "pending") && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => retryTask.mutate({ id: task.id })}
                        disabled={retryTask.isPending}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Reintentar
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
          <CheckCircle2 className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground text-sm">
            No hay tareas pendientes en la cola
          </p>
        </div>
      )}
    </div>
  );
}

function TaskStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    pending: { label: "Pendiente", variant: "outline" },
    processing: { label: "Procesando", variant: "secondary" },
    completed: { label: "Completado", variant: "default" },
    failed: { label: "Fallido", variant: "destructive" },
  };
  const c = config[status] || { label: status, variant: "secondary" as const };
  return (
    <Badge variant={c.variant} className="text-xs uppercase tracking-wider font-medium">
      {c.label}
    </Badge>
  );
}
