import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, ArrowLeftRight, CheckCircle2, Loader2, Undo2 } from "lucide-react";
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
  const [detalleId, setDetalleId] = useState<number | null>(null);
  const [revertirId, setRevertirId] = useState<number | null>(null);
  const [motivoRevertir, setMotivoRevertir] = useState("");

  const { data: detalle, isFetching: cargandoDetalle } = trpc.transfers.detalle.useQuery(
    { id: detalleId! }, { enabled: detalleId !== null },
  );

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
                <div className="flex items-center justify-between gap-2">
                  <button className="flex items-center gap-4 text-left flex-1 min-w-0" onClick={() => setDetalleId(t.id)}>
                    <div className="h-10 w-10 bg-foreground/5 rounded flex items-center justify-center shrink-0">
                      <ArrowLeftRight className="h-5 w-5 text-foreground/60" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{t.referenceNumber || `Transferencia #${t.id}`}</p>
                      <p className="text-xs text-muted-foreground truncate">{t.fromBranchName} → {t.toBranchName}</p>
                      {t.itemCount > 0 && <p className="text-xs text-muted-foreground">{t.itemCount} producto{t.itemCount !== 1 ? "s" : ""}</p>}
                    </div>
                  </button>
                  <div className="flex items-center gap-3 shrink-0">
                    <p className="text-xs text-muted-foreground hidden sm:block">{new Date(t.createdAt).toLocaleDateString("es-BO")}</p>
                    <StatusBadge status={t.status} />
                    {(t.status === "draft" || t.status === "pending_sync" || t.status === "pending") && (
                      <Button size="sm" variant="outline" onClick={() => handleConfirm(t.id)} disabled={confirmingId === t.id}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-green-600 text-green-700 hover:bg-green-50">
                        {confirmingId === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                        Confirmar
                      </Button>
                    )}
                    {esAdmin && t.status === "completed" && (
                      <Button size="sm" variant="outline" onClick={() => setRevertirId(t.id)}
                        className="gap-1 text-xs uppercase tracking-wider font-semibold border-amber-500 text-amber-700 hover:bg-amber-50">
                        <Undo2 className="h-3 w-3" /> Revertir
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
          <p className="text-muted-foreground text-sm">No hay transferencias registradas</p>
          <Button onClick={() => setLocation("/transferencias/nueva")} variant="outline" className="mt-4 uppercase tracking-wider text-xs font-semibold">
            Registrar primera transferencia
          </Button>
        </div>
      )}

      <Dialog open={detalleId !== null} onOpenChange={(o) => { if (!o) setDetalleId(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detalle?.referenceNumber || `Transferencia #${detalleId}`}</DialogTitle>
            <DialogDescription>
              {cargandoDetalle ? "Cargando…" : detalle ? `${detalle.origen} → ${detalle.destino}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detalle && (
            <div className="space-y-4 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge status={detalle.status} />
                <span className="text-xs text-muted-foreground">{new Date(detalle.createdAt).toLocaleString("es-BO")}</span>
              </div>
              {detalle.revertedAt && (
                <div className="p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  Revertida el {new Date(detalle.revertedAt).toLocaleString("es-BO")}
                  {detalle.revertReason ? ` — ${detalle.revertReason}` : ""}
                </div>
              )}
              {detalle.notes && <p className="text-xs text-muted-foreground">Nota: {detalle.notes}</p>}
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Productos ({detalle.items.length})</p>
                <div className="border rounded divide-y">
                  {detalle.items.map((it, i) => (
                    <div key={i} className="flex justify-between px-3 py-1.5 text-xs">
                      <span className="truncate">{it.nombre}</span>
                      <span className="font-bold shrink-0 ml-2">{it.cantidad}</span>
                    </div>
                  ))}
                </div>
              </div>
              {detalle.historial.length > 0 && (
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1">Historial</p>
                  <div className="space-y-1">
                    {detalle.historial.map((h, i) => (
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
              {esAdmin && detalle.status === "completed" && (
                <Button variant="outline" className="w-full gap-2 border-amber-500 text-amber-700 hover:bg-amber-50"
                  onClick={() => { setRevertirId(detalle.id); setDetalleId(null); }}>
                  <Undo2 className="h-4 w-4" /> Revertir esta transferencia
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

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
