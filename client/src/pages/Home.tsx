import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ShoppingCart,
  ArrowLeftRight,
  ListTodo,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Plus,
  ArrowRight,
} from "lucide-react";
import { useLocation } from "wouter";

export default function Home() {
  const [, setLocation] = useLocation();
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery();

  return (
    <div className="space-y-8">
      {/* Header — Swiss Style: bold, uppercase, thin rule */}
      <div className="border-b border-foreground pb-4">
        <h1 className="text-3xl font-black tracking-tight uppercase">
          Panel de Control
        </h1>
        <p className="text-sm text-muted-foreground mt-1 tracking-wide">
          Gestión centralizada de inventarios y transferencias
        </p>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Button
          onClick={() => setLocation("/compras/nueva")}
          className="h-14 justify-start gap-3 font-semibold uppercase tracking-wider text-sm"
        >
          <Plus className="h-5 w-5" />
          Nueva Compra
        </Button>
        <Button
          variant="outline"
          onClick={() => setLocation("/transferencias/nueva")}
          className="h-14 justify-start gap-3 font-semibold uppercase tracking-wider text-sm border-foreground text-foreground hover:bg-foreground hover:text-background"
        >
          <ArrowLeftRight className="h-5 w-5" />
          Nueva Transferencia
        </Button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Compras"
          value={isLoading ? "—" : String(stats?.totalPurchases ?? 0)}
          subtitle="Total registradas"
          icon={<ShoppingCart className="h-5 w-5" />}
        />
        <StatCard
          title="Transferencias"
          value={isLoading ? "—" : String(stats?.totalTransfers ?? 0)}
          subtitle="Total procesadas"
          icon={<ArrowLeftRight className="h-5 w-5" />}
        />
        <StatCard
          title="Pendientes"
          value={isLoading ? "—" : String(stats?.pendingTasks ?? 0)}
          subtitle="En cola de tareas"
          icon={<Clock className="h-5 w-5" />}
          accent={
            stats?.pendingTasks && stats.pendingTasks > 0 ? true : false
          }
        />
        <StatCard
          title="Errores"
          value={isLoading ? "—" : String(stats?.errorTasks ?? 0)}
          subtitle="Requieren atención"
          icon={<AlertTriangle className="h-5 w-5" />}
          destructive={
            stats?.errorTasks && stats.errorTasks > 0 ? true : false
          }
        />
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Purchases */}
        <Card className="border-foreground/10">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Compras Recientes
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation("/compras")}
                className="text-xs uppercase tracking-wider"
              >
                Ver todas
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-12 bg-muted animate-pulse rounded"
                  />
                ))}
              </div>
            ) : stats?.recentPurchases && stats.recentPurchases.length > 0 ? (
              <div className="space-y-2">
                {stats.recentPurchases.map((p: any) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-2 rounded-full bg-primary" />
                      <div>
                        <p className="text-sm font-medium">
                          {p.receiptNumber || `Compra #${p.id}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {p.supplier || "Sin proveedor"}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={p.status} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No hay compras registradas
              </p>
            )}
          </CardContent>
        </Card>

        {/* Recent Transfers */}
        <Card className="border-foreground/10">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Transferencias Recientes
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation("/transferencias")}
                className="text-xs uppercase tracking-wider"
              >
                Ver todas
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-12 bg-muted animate-pulse rounded"
                  />
                ))}
              </div>
            ) : stats?.recentTransfers && stats.recentTransfers.length > 0 ? (
              <div className="space-y-2">
                {stats.recentTransfers.map((t: any) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-2 rounded-full bg-foreground" />
                      <div>
                        <p className="text-sm font-medium">
                          {t.referenceNumber || `Transferencia #${t.id}`}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t.fromBranchName} → {t.toBranchName}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={t.status} />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No hay transferencias registradas
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  title,
  value,
  subtitle,
  icon,
  accent,
  destructive,
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: React.ReactNode;
  accent?: boolean;
  destructive?: boolean;
}) {
  return (
    <Card
      className={`border ${
        destructive
          ? "border-destructive/30 bg-destructive/5"
          : accent
            ? "border-primary/30 bg-primary/5"
            : "border-foreground/10"
      }`}
    >
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {title}
            </p>
            <p
              className={`text-3xl font-black mt-1 ${
                destructive
                  ? "text-destructive"
                  : accent
                    ? "text-primary"
                    : ""
              }`}
            >
              {value}
            </p>
            <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
          </div>
          <div
            className={`p-2 rounded ${
              destructive
                ? "bg-destructive/10 text-destructive"
                : accent
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {icon}
          </div>
        </div>
      </CardContent>
    </Card>
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
