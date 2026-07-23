/**
 * BANDEJA DE FACTURAS XML.
 * Lista las facturas XML en espera con su estado. Se alimenta subiendo XML
 * manualmente (por ahora) y, más adelante, por correo automático. Base para la
 * cámara-inteligente y la ingesta por correo.
 */
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Inbox, Upload, Loader2, Trash2, FileText, CheckCircle2, AlertTriangle } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useRef, useState } from "react";

const ESTADOS: Record<string, { label: string; className: string }> = {
  recibida: { label: "Recién llegada", className: "bg-yellow-50 text-yellow-700 border-yellow-300" },
  emparejada: { label: "Emparejada", className: "bg-blue-50 text-blue-700 border-blue-300" },
  vencimientos_pendientes: { label: "Faltan vencimientos", className: "bg-amber-50 text-amber-700 border-amber-300" },
  validada: { label: "Validada", className: "bg-green-50 text-green-700 border-green-300" },
};

export default function Bandeja() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const fileRef = useRef<HTMLInputElement>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [verValidadas, setVerValidadas] = useState(false);

  const { data: facturas, isLoading } = trpc.bandeja.listar.useQuery({ incluirValidadas: verValidadas });
  const eliminar = trpc.bandeja.eliminar.useMutation({
    onSuccess: () => { utils.bandeja.listar.invalidate(); toast.success("Factura descartada"); },
  });
  const ingresar = trpc.bandeja.ingresar.useMutation();

  const onArchivos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;
    setSubiendo(true);
    let ok = 0, dup = 0, err = 0;
    for (const f of files) {
      try {
        const base64: string = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res((r.result as string).split(",")[1]);
          r.onerror = () => rej(new Error("lectura"));
          r.readAsDataURL(f);
        });
        const r = await ingresar.mutateAsync({ fileBase64: base64, fileName: f.name });
        if (r.duplicada) dup++; else ok++;
      } catch {
        err++;
      }
    }
    setSubiendo(false);
    await utils.bandeja.listar.invalidate();
    const partes = [];
    if (ok) partes.push(`${ok} agregada(s)`);
    if (dup) partes.push(`${dup} ya estaban`);
    if (err) partes.push(`${err} con error`);
    toast[err && !ok ? "error" : "success"](partes.join(" · ") || "Sin cambios");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between border-b border-foreground pb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase flex items-center gap-2">
            <Inbox className="h-7 w-7" /> Bandeja de facturas
          </h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">Facturas XML en espera de emparejar y completar</p>
        </div>
        <Button onClick={() => fileRef.current?.click()} disabled={subiendo} className="gap-2 font-semibold uppercase tracking-wider text-sm">
          {subiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Subir XML
        </Button>
        <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" multiple onChange={onArchivos} className="hidden" />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant={!verValidadas ? "default" : "outline"} onClick={() => setVerValidadas(false)}>Pendientes</Button>
        <Button size="sm" variant={verValidadas ? "default" : "outline"} onClick={() => setVerValidadas(true)}>Todas</Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-20 bg-muted animate-pulse rounded" />)}</div>
      ) : facturas && facturas.length > 0 ? (
        <div className="space-y-2">
          {facturas.map((f: any) => {
            const est = ESTADOS[f.estado] || ESTADOS.recibida;
            return (
              <Card key={f.id} data-ajena={f.ajena ? "1" : "0"} className="border-foreground/10 hover:border-foreground/20 transition-colors">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between gap-2">
                    <button className="flex items-center gap-4 text-left flex-1 min-w-0" onClick={() => setLocation(`/bandeja/${f.id}`)}>
                      <div className={`h-10 w-10 rounded flex items-center justify-center shrink-0 ${f.ajena ? "bg-amber-100" : "bg-foreground/5"}`}>
                        {f.ajena
                          ? <AlertTriangle className="h-5 w-5 text-amber-600" />
                          : <FileText className="h-5 w-5 text-foreground/60" />}
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-sm truncate">{f.proveedor || "Proveedor desconocido"}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          Factura {f.numeroFactura || "?"} · Bs {Number(f.montoTotal).toFixed(2)} · {f.totalItems} productos
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {f.itemsEmparejados}/{f.totalItems} emparejados · {f.itemsConVencimiento}/{f.totalItems} con vencimiento
                          {f.origen === "correo" && " · llegó por correo"}
                        </p>
                        {f.ajena && (
                          <p className="text-[11px] text-amber-700 font-medium truncate">
                            ⚠ A nombre de {f.razonSocialCliente || "otro NIT"} — revisa si es de la farmacia
                          </p>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className={`text-xs uppercase tracking-wider font-medium ${est.className}`}>{est.label}</Badge>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-red-600"
                        onClick={() => eliminar.mutate({ id: f.id })} title="Descartar">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16 border border-dashed border-foreground/20 rounded">
          <CheckCircle2 className="h-10 w-10 mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-muted-foreground text-sm">
            {verValidadas ? "No hay facturas en la bandeja." : "No hay facturas pendientes. ¡Todo al día!"}
          </p>
          <Button onClick={() => fileRef.current?.click()} variant="outline" className="mt-4 uppercase tracking-wider text-xs font-semibold gap-2">
            <Upload className="h-4 w-4" /> Subir una factura XML
          </Button>
        </div>
      )}
    </div>
  );
}
