import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, ArrowLeftRight, CheckCircle2, Loader2, Undo2, Eye, ChevronDown, ChevronUp } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useState } from "react";
import { useAuth } from "../_core/hooks/useAuth";

export default function Transferencias() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { user } = useAuth();
  const esAdmin = user?.role === "admin";
  const { data: transfers, isLoading } = trpc.transfers.list.useQuery();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [expandidaId, setExpandidaId] = useState<number | null>(null);
  const [revertirId, setRevertirId] = useState<number | null>(null);
  const [motivoRevertir, setMotivoRevertir] = useState("");

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
    onError: (err) => { toast.error(err.message || "Error al confirmar la transferencia"); setConfirmingId(null); },
  });

  const revertir = trpc.transfers.revertir.useMutation({
    onSuccess: (r: any) => {
      if (r?.success) toast.success(r.message, { duration: 8000 });
      else toast.error(r?.message || "No se pudo revertir", { duration: 10000 });
      utils.transfers.list.invalidate();
      utils.dashboard.stats.invalidate();
      setRevertirId(null); setMotivoRevertir("");
    },
    onError: (err) => { toast.error(err.message || "Error al revertir"); setRevertirId(null); },
  });

  const handleConfirm = (id: number) => { setConfirmingId(id); confirmTransfer.mutate({ id }); };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b border-foreground pb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">Transferencias</h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">Movimiento de medicamentos entre sucursales</p>
        </div>
        <Button onClick={() => setLocation("/transferencias/nueva")} className="font-semibold uppercase tracking-wider text-sm gap-2">
          <Plus className="h-4 w-4" /> Nueva Transferencia
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3, 4].map((i) => <div key={i} className="h-20 bg-muted animate-pulse rounded" />)}</div>
      ) : transfers && transfers.length > 0 ? (
        <div className="space-y-2">
          {transfers.map((t: any) => (
            <Card key={t.id} className="border-foreground/10 hover:border-foreground/20 transition-colors">
              <CardContent className="py-4">
                <div className="flex items-center justify-between gap-3">
                  {/* Icono + Info (mismo patrón que Compras) */}
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="h-10 w-10 flex-shrink-0 bg-primary/10 rounded flex items-center justify-center">
                      <ArrowLeftRight className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">
                        {t.referenceNumber || `Transferencia #${t.id}`}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {t.fromBranchName} → {t.toBranchName}
                        {t.itemCount ? ` — ${t.itemCount} producto${t.itemCount !== 1 ? "s" : ""}` : ""}
                        {t.unidades ? ` — ${t.unidades} unidades` : ""}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(t.createdAt).toLocaleDateString("es-BO")}
                      </p>
                    </div>
                  </div>

                  {/* Estado + acciones */}
                  <div className="flex items-center gap-2 shrink-0">
                    <StatusBadge status={t.status} />
                    {(t.status === "draft" || t.status === "pending_sync" || t.status === "pending") && (
                      <Button size="sm" variant="outline" onClick={() => handleConfirm(t.id)} disabled={confirmingId === t.id}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-green-600 text-green-700 hover:bg-green-50">
                        {confirmingId === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                        Confirmar
                      </Button>
                    )}
                    {esAdmin && t.status === "completed" && (
                      <Button size="sm" variant="ghost" onClick={() => setRevertirId(t.id)}
                        className="gap-1 text-xs text-amber-700 hover:text-amber-800 hover:bg-amber-50"
                        title="Revertir esta transferencia">
                        <Undo2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {/* Ver detalle de la transferencia */}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpandidaId(expandidaId === t.id ? null : t.id)}
                      className="gap-1 text-xs text-muted-foreground hover:text-foreground"
                      title="Ver detalle de productos"
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {expandidaId === t.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>

                {/* Detalle expandible de la transferencia */}
                {expandidaId === t.id && <DetalleTransferencia transferId={t.id} />}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 border border-dashed border-foreground/20 rounded">
          <p className="text-muted-foreground text-sm">No hay transferencias registradas</p>
          <Button onClick={() => setLocation("/transferencias/nueva")} variant="outline" className="mt-4 uppercase tracking-wider text-xs font-semibold">
            Registrar primera transferencia
          </Button>
        </div>
      )}


      <AlertDialog open={revertirId !== null} onOpenChange={(o) => { if (!o) { setRevertirId(null); setMotivoRevertir(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-amber-700">Revertir transferencia</AlertDialogTitle>
            <AlertDialogDescription>
              Se registrará el movimiento INVERSO en el sistema: el stock volverá del destino al origen por las mismas cantidades. Esta acción queda registrada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea placeholder="Motivo de la reversión (opcional)" value={motivoRevertir}
            onChange={(e) => setMotivoRevertir(e.target.value)} className="text-sm" rows={2} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revertir.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={revertir.isPending}
              className="bg-amber-600 hover:bg-amber-700"
              onClick={(e) => { e.preventDefault(); if (revertirId) revertir.mutate({ id: revertirId, motivo: motivoRevertir.trim() || undefined }); }}>
              {revertir.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Undo2 className="h-4 w-4 mr-1" />}
              Revertir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    draft: { label: "Borrador", className: "bg-gray-100 text-gray-600 border-gray-300" },
    pending_sync: { label: "Pendiente", className: "bg-yellow-50 text-yellow-700 border-yellow-300" },
    pending: { label: "Pendiente", className: "bg-yellow-50 text-yellow-700 border-yellow-300" },
    synced: { label: "Sincronizado", className: "bg-blue-50 text-blue-700 border-blue-300" },
    completed: { label: "Completado", className: "bg-green-50 text-green-700 border-green-300" },
    reverted: { label: "Revertida", className: "bg-amber-50 text-amber-700 border-amber-300" },
    error: { label: "Error", className: "bg-red-50 text-red-700 border-red-300" },
  };
  const c = config[status] || { label: status, className: "bg-gray-100 text-gray-600 border-gray-300" };
  return <Badge variant="outline" className={`text-xs uppercase tracking-wider font-medium ${c.className}`}>{c.label}</Badge>;
}

/**
 * Detalle desplegable de una transferencia — mismo patrón visual que DetalleCompra
 * en Compras.tsx (título, filas con fondo suave, totales al pie), para que la app
 * mantenga un solo diseño en todas las listas.
 */
function DetalleTransferencia({ transferId }: { transferId: number }) {
  const { data, isLoading } = trpc.transfers.detalle.useQuery({ id: transferId });

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
        No hay detalle de productos para esta transferencia.
      </div>
    );
  }

  const totalUnidades = data.items.reduce((s: number, it: any) => s + Number(it.cantidad || 0), 0);

  return (
    <div className="mt-3 pt-3 border-t">
      {/* Origen y destino: el dato clave de una transferencia */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="px-2 py-1 rounded-md bg-muted/50 font-medium truncate">{data.origen}</span>
        <ArrowLeftRight className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="px-2 py-1 rounded-md bg-emerald-50 text-emerald-800 font-medium truncate">{data.destino}</span>
      </div>

      {data.revertedAt && (
        <div className="mb-2 p-2 rounded-md bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
          Revertida el {new Date(data.revertedAt).toLocaleString("es-BO")}
          {data.revertReason ? ` — ${data.revertReason}` : ""}
        </div>
      )}
      {data.notes && <p className="text-[11px] text-muted-foreground mb-2">Nota: {data.notes}</p>}

      <p className="text-[11px] font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
        Detalle ({data.items.length} producto{data.items.length !== 1 ? "s" : ""})
      </p>
      <div className="space-y-1.5">
        {data.items.map((it: any, i: number) => (
          <div key={i} className="flex items-center gap-2 text-xs bg-muted/30 rounded-md px-2.5 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{it.nombre}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="font-bold tabular-nums">{Number(it.cantidad || 0)} u.</p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between items-center mt-2 pt-2 border-t text-xs">
        <span className="font-semibold">Total transferido</span>
        <span className="font-black tabular-nums">{totalUnidades} unidades</span>
      </div>

      {data.historial?.length > 0 && (
        <div className="mt-3 pt-2 border-t">
          <p className="text-[11px] font-semibold text-muted-foreground mb-1.5 uppercase tracking-wider">Historial</p>
          <div className="space-y-1">
            {data.historial.map((h: any, i: number) => (
              <div key={i} className="text-[11px] flex items-start gap-2">
                <span className={h.status === "error" ? "text-red-600" : h.status === "success" ? "text-emerald-700" : "text-muted-foreground"}>●</span>
                <span className="flex-1">
                  <b>{h.action}</b> — {h.details}
                  <span className="block text-muted-foreground">{new Date(h.fecha).toLocaleString("es-BO")}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
