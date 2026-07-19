import { useState, useCallback, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  Loader2,
  Trash2,
  Plus,
  Save,
  ArrowLeft,
  Sparkles,
  Check,
  CheckCircle2,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

interface ExtractedItem {
  productName: string;
  textoLeido?: string;
  candidatos?: { nombre: string; puntaje: number; confianza: string }[];
  confianza?: string;
  quantity: number;
}

export default function NuevaTransferencia() {
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: branchesData } = trpc.branches.list.useQuery();

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fromBranchId, setFromBranchId] = useState<string>("");
  const [toBranchId, setToBranchId] = useState<string>("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ExtractedItem[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [extracted, setExtracted] = useState(false);

  const utils = trpc.useUtils();
  const uploadAndExtract = trpc.transfers.uploadAndExtract.useMutation();
  const emparejar = trpc.transfers.emparejar.useMutation();
  const dictarLista = trpc.transfers.dictarLista.useMutation();
  const [buscandoFila, setBuscandoFila] = useState<number | null>(null);
  // BÚSQUEDA EN VIVO: se busca mientras se escribe (sin botón), con un respiro de
  // 300ms para no consultar en cada tecla. Muestra el stock del ORIGEN de una vez.
  const [filaActiva, setFilaActiva] = useState<number | null>(null);
  const [textoBusqueda, setTextoBusqueda] = useState("");
  const [textoDebounced, setTextoDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTextoDebounced(textoBusqueda), 300);
    return () => clearTimeout(t);
  }, [textoBusqueda]);
  const sucursalOrigenNombre = (branchesData || []).find((b: any) => String(b.id) === fromBranchId)?.name || "";
  const { data: sugerencias, isFetching: buscandoVivo } = trpc.transfers.buscarConStock.useQuery(
    { q: textoDebounced, sucursalOrigen: sucursalOrigenNombre || undefined },
    { enabled: textoDebounced.trim().length >= 2 && filaActiva !== null }
  );
  // Dictado por voz: grabar → Whisper → productos+cantidades → mismo emparejado
  const [grabando, setGrabando] = useState(false);
  const [procesandoVoz, setProcesandoVoz] = useState(false);
  const [textoDictado, setTextoDictado] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Empareja una lista de items leídos contra el catálogo real y devuelve
  // items con el nombre sugerido aplicado + candidatos para corregir a un toque.
  const emparejarItems = async (leidos: { productName: string; quantity: number }[]) => {
    try {
      const r = await emparejar.mutateAsync({ items: leidos.map(i => ({ productName: i.productName, quantity: i.quantity })) });
      return r.items.map((it: any) => ({
        productName: it.sugerido || it.textoLeido,
        quantity: it.quantity,
        textoLeido: it.textoLeido,
        candidatos: it.candidatos,
        confianza: it.sugerido ? it.candidatos?.[0]?.confianza : "sin_match",
      }));
    } catch {
      return leidos; // si falla el emparejado, seguimos con lo leído crudo
    }
  };

  // Buscar en el catálogo lo escrito en UNA fila (para listas armadas a mano en la app)
  const buscarEnCatalogo = async (idx: number) => {
    const texto = items[idx]?.productName?.trim();
    if (!texto || texto.length < 3) { toast.error("Escribe al menos 3 letras"); return; }
    setBuscandoFila(idx);
    try {
      const r = await emparejar.mutateAsync({ items: [{ productName: texto, quantity: items[idx].quantity || 1 }] });
      const it: any = r.items[0];
      setItems(prev => prev.map((p, i) => i === idx ? {
        ...p,
        textoLeido: texto,
        candidatos: it.candidatos,
        confianza: it.sugerido ? it.candidatos?.[0]?.confianza : "sin_match",
        productName: it.sugerido || p.productName,
      } : p));
      if (!it.candidatos?.length) toast.error("Sin coincidencias en el catálogo — revisa el nombre");
    } finally {
      setBuscandoFila(null);
    }
  };

  // Elegir un candidato para una fila (corrige a un toque)
  const elegirCandidato = (idx: number, nombre: string) => {
    setItems(prev => prev.map((p, i) => i === idx ? { ...p, productName: nombre, confianza: "elegido", candidatos: undefined } : p));
  };
  // STOCK DEL ORIGEN: se verifica ANTES de transferir. Si algún producto no
  // alcanza, 365 rechazaría la transferencia — mejor detectarlo aquí y ofrecer
  // ajustar el origen (caso real: el stock físico está, pero el sistema dice menos).
  const stockOrigen = trpc.transfers.stockDeProductos.useQuery(
    { sucursalOrigen: sucursalOrigenNombre, nombres: items.map((i) => i.productName).filter(Boolean) },
    { enabled: !!sucursalOrigenNombre && items.length > 0 && items.some((i) => i.productName?.trim()) }
  );
  const faltantes = (items || [])
    .map((it) => {
      const s = (stockOrigen.data?.stock || {})[it.productName];
      if (s == null) return null;
      const necesita = Number(it.quantity) || 0;
      return s < necesita ? { nombre: it.productName, hay: s, necesita, falta: necesita - s } : null;
    })
    .filter(Boolean) as any[];
  // Stock REAL que se declara por producto al ajustar (por defecto, lo necesario
  // para la transferencia; editable, porque si físicamente hay más hay que
  // declararlo — si no, el origen quedaría en 0 con mercadería en el estante).
  const [stockDeclarado, setStockDeclarado] = useState<Record<string, number>>({});
  const ajustarOrigen = trpc.transfers.ajustarStockOrigen.useMutation({
    onSuccess: (r: any) => {
      if (r.ok) toast.success(r.mensaje, { duration: 9000 });
      else toast.error(r.mensaje, { duration: 12000 });
      stockOrigen.refetch();
      setStockDeclarado({});
    },
    onError: (e) => toast.error(e.message),
  });

  const createTransfer = trpc.transfers.create.useMutation();

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0];
      if (!selected) return;
      
      const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
      if (!validTypes.includes(selected.type)) {
        toast.error('Solo JPG, PNG, WebP o PDF');
        return;
      }
      
      const maxSize = 10 * 1024 * 1024;
      if (selected.size > maxSize) {
        toast.error('Archivo muy grande (máx 10MB)');
        return;
      }
      
      setFile(selected);
      setExtracted(false);
      setItems([]);
      setPreviewUrl(URL.createObjectURL(selected));
    },
    []
  );

  // ── Dictado por voz ──
  const iniciarDictado = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 1000) { toast.error("Grabación muy corta"); return; }
        setProcesandoVoz(true);
        try {
          const b64 = await new Promise<string>((res, rej) => {
            const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob);
          });
          const r: any = await dictarLista.mutateAsync({ audioBase64: b64, mimeType: blob.type });
          if (r.textoDictado) setTextoDictado(r.textoDictado);
          if (r.error) { toast.error(r.error, { duration: 7000 }); return; }
          const emparejados = await emparejarItems(r.items);
          // El dictado SUMA a lo que ya haya en la lista (se puede dictar por tandas)
          setItems((prev) => [...prev, ...emparejados]);
          setExtracted(true);
          const conMatch = emparejados.filter((i: any) => i.confianza && i.confianza !== "sin_match").length;
          toast.success(`${r.items.length} producto(s) dictado(s) · ${conMatch} emparejado(s) con el catálogo`, { duration: 6000 });
        } catch (e: any) {
          toast.error("No se pudo procesar el dictado: " + (e?.message || ""));
        } finally { setProcesandoVoz(false); }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setGrabando(true);
    } catch {
      toast.error("No se pudo acceder al micrófono. Revisa los permisos del navegador.");
    }
  };
  const detenerDictado = () => {
    mediaRecorderRef.current?.stop();
    setGrabando(false);
  };

  const handleExtract = useCallback(async () => {
    if (!file) return;
    setIsExtracting(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];
        const result = await uploadAndExtract.mutateAsync({
          fileBase64: base64,
          fileName: file.name,
          mimeType: file.type,
        });
        if (result.items && result.items.length > 0) {
          const emparejados = await emparejarItems(result.items);
          setItems(emparejados);
          setExtracted(true);
          const conMatch = emparejados.filter((i: any) => i.confianza && i.confianza !== "sin_match").length;
          toast.success(
            `${result.items.length} productos leídos · ${conMatch} emparejados con el catálogo`
          );
        } else {
          toast.error("No se pudieron extraer productos de la imagen");
        }
        setIsExtracting(false);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      toast.error(err.message || "Error al procesar la imagen");
      setIsExtracting(false);
    }
  }, [file, uploadAndExtract]);

  const handleSubmit = useCallback(async (confirmDirectly: boolean) => {
    if (!fromBranchId || !toBranchId) {
      toast.error("Seleccione sucursal origen y destino");
      return;
    }
    if (fromBranchId === toBranchId) {
      toast.error("La sucursal origen y destino deben ser diferentes");
      return;
    }
    if (items.length === 0) {
      toast.error("Agregue al menos un producto");
      return;
    }
    setIsSubmitting(true);
    try {
      await createTransfer.mutateAsync({
        fromBranchId: parseInt(fromBranchId),
        toBranchId: parseInt(toBranchId),
        referenceNumber,
        notes,
        items,
        imageUrl: uploadAndExtract.data?.imageUrl || null,
        imageKey: uploadAndExtract.data?.imageKey || null,
        confirmDirectly,
      });
      // Invalidate caches so the list page shows the new transfer immediately
      await utils.transfers.list.invalidate();
      await utils.dashboard.stats.invalidate();
      if (confirmDirectly) {
        toast.success("Transferencia confirmada y completada exitosamente");
      } else {
        toast.success("Transferencia guardada como borrador");
      }
      setLocation("/transferencias");
    } catch (err: any) {
      toast.error(err.message || "Error al registrar la transferencia");
    }
    setIsSubmitting(false);
  }, [fromBranchId, toBranchId, items, referenceNumber, notes, createTransfer, setLocation, uploadAndExtract.data]);

  const updateItem = (index: number, field: keyof ExtractedItem, value: any) => {
    setItems((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const addEmptyItem = () => {
    setItems((prev) => [...prev, { productName: "", quantity: 1 }]);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 border-b border-foreground pb-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation("/transferencias")}
          className="gap-1"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-black tracking-tight uppercase">
            Nueva Transferencia
          </h1>
          <p className="text-sm text-muted-foreground mt-1 tracking-wide">
            Suba una foto de los medicamentos para extracción automática
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Upload & Info */}
        <div className="lg:col-span-1 space-y-4">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Foto de Medicamentos
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* DICTADO POR VOZ: alternativa rápida a la foto — dictar la lista */}
              <div className="mb-4 p-3 rounded-lg border border-dashed">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2">🎤 O dicta la lista por voz</p>
                <button
                  type="button"
                  onClick={grabando ? detenerDictado : iniciarDictado}
                  disabled={procesandoVoz}
                  className={`w-full h-12 rounded-xl font-black text-sm flex items-center justify-center gap-2 disabled:opacity-50 ${
                    grabando ? "bg-red-600 text-white animate-pulse" : "bg-primary text-primary-foreground"
                  }`}
                >
                  {procesandoVoz ? (<><Loader2 className="h-4 w-4 animate-spin" /> Entendiendo el dictado…</>)
                    : grabando ? (<>⏹ Detener y procesar</>)
                    : (<>🎤 Dictar lista</>)}
                </button>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  Di la cantidad y el producto: <b>"cinco paracetamol 500, tres amoxicilina 500, dos ibuprofeno 400"</b>. Puedes dictar por tandas — se van sumando.
                </p>
                {textoDictado && (
                  <p className="text-[10px] text-muted-foreground mt-1.5 italic border-t pt-1.5">Se escuchó: "{textoDictado}"</p>
                )}
              </div>
              {previewUrl ? (
                <div className="space-y-3">
                  <div className="border border-foreground/10 rounded overflow-hidden">
                    <img
                      src={previewUrl}
                      alt="Medicamentos"
                      className="w-full h-auto max-h-80 object-contain bg-muted"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={handleExtract}
                      disabled={isExtracting || extracted}
                      className="flex-1 gap-2 font-semibold uppercase tracking-wider text-xs"
                    >
                      {isExtracting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : extracted ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      {isExtracting
                        ? "Extrayendo..."
                        : extracted
                          ? "Extraído"
                          : "Extraer con IA"}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        setFile(null);
                        setPreviewUrl(null);
                        setExtracted(false);
                        setItems([]);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-foreground/20 rounded p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
                >
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">Haga clic para subir</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    JPG, PNG o PDF
                  </p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf"
                onChange={handleFileSelect}
                className="hidden"
              />
            </CardContent>
          </Card>

          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-bold uppercase tracking-wider">
                Datos de Transferencia
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  Sucursal Origen
                </Label>
                <Select value={fromBranchId} onValueChange={setFromBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar origen" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchesData?.map((b: any) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  Sucursal Destino
                </Label>
                <Select value={toBranchId} onValueChange={setToBranchId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccionar destino" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchesData
                      ?.filter((b: any) => String(b.id) !== fromBranchId)
                      .map((b: any) => (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  N° Referencia
                </Label>
                <Input
                  value={referenceNumber}
                  onChange={(e) => setReferenceNumber(e.target.value)}
                  placeholder="Opcional"
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-bold uppercase tracking-wider">
                  Notas
                </Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Observaciones adicionales"
                  rows={3}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Items */}
        <div className="lg:col-span-2">
          <Card className="border-foreground/10">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold uppercase tracking-wider">
                  Medicamentos ({items.length})
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addEmptyItem}
                  className="gap-1 text-xs uppercase tracking-wider font-semibold"
                >
                  <Plus className="h-3 w-3" />
                  Agregar
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {items.length > 0 ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-12 gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground pb-2 border-b border-foreground/10">
                    <div className="col-span-8">Producto</div>
                    <div className="col-span-3">Cantidad</div>
                    <div className="col-span-1" />
                  </div>
                  {items.map((item, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-12 gap-2 items-center py-1"
                    >
                      <div className="col-span-8">
                        <div className="flex gap-1.5 items-center relative">
                          <div className="flex-1 min-w-0">
                            <Input
                              value={item.productName}
                              onChange={(e) => {
                                updateItem(idx, "productName", e.target.value);
                                // Buscar EN VIVO: sin botón, como el resto de la app
                                setFilaActiva(idx);
                                setTextoBusqueda(e.target.value);
                              }}
                              onFocus={() => { setFilaActiva(idx); setTextoBusqueda(item.productName || ""); }}
                              className="text-sm h-9"
                              placeholder="Escribe el medicamento…"
                              autoComplete="off"
                            />
                          </div>
                          {buscandoVivo && filaActiva === idx && (
                            <Loader2 className="absolute right-12 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          <button
                            type="button"
                            onClick={() => buscarEnCatalogo(idx)}
                            disabled={buscandoFila === idx}
                            title="Emparejar esta fila con el catálogo"
                            className="shrink-0 h-9 w-9 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm disabled:opacity-50"
                          >
                            {buscandoFila === idx ? "…" : "🔍"}
                          </button>
                          {/* Sugerencias en vivo CON el stock del origen: se ve al
                              instante si alcanza para transferir. Mismo comportamiento
                              (ancho completo, texto sin recortar de más) que el resto
                              de buscadores de producto de la app. */}
                          {filaActiva === idx && (sugerencias?.productos?.length || 0) > 0 && item.productName?.trim().length >= 2 && (
                            <div className="absolute top-10 left-0 right-0 z-30 bg-white dark:bg-card border rounded-xl shadow-lg max-h-72 overflow-y-auto">
                              {sugerencias!.productos.map((p: any) => {
                                const falta = p.stockOrigen != null && p.stockOrigen < (item.quantity || 1);
                                return (
                                  <button key={p.nombre} type="button"
                                    onClick={() => { elegirCandidato(idx, p.nombre); setFilaActiva(null); setTextoBusqueda(""); }}
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-muted flex items-center justify-between gap-2">
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate leading-tight">{p.nombre}</span>
                                      {p.proveedor && (
                                        <span className="block truncate text-[10px] text-muted-foreground/70 leading-tight mt-0.5">{p.proveedor}</span>
                                      )}
                                    </span>
                                    {p.stockOrigen == null ? (
                                      <span className="text-[10px] text-muted-foreground shrink-0">sin dato</span>
                                    ) : (
                                      <span className={`text-[10px] font-bold shrink-0 ${falta ? "text-red-600" : "text-emerald-700"}`}>
                                        {p.stockOrigen} en origen
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                        {item.confianza && (
                          <div className="mt-1 space-y-1">
                            <p className="text-[10px] text-muted-foreground">
                              {item.textoLeido && item.textoLeido !== item.productName && <>Leído: "{item.textoLeido}" · </>}
                              {item.confianza === "alta" && <span className="text-emerald-700 font-bold">✓ coincidencia alta</span>}
                              {item.confianza === "media" && <span className="text-amber-700 font-bold">≈ coincidencia media — revisa</span>}
                              {item.confianza === "elegido" && <span className="text-emerald-700 font-bold">✓ elegido del catálogo</span>}
                              {item.confianza === "sin_match" && <span className="text-red-600 font-bold">✗ no está en el catálogo — corrige o busca 🔍</span>}
                            </p>
                            {item.candidatos && item.candidatos.length > 0 && item.confianza !== "elegido" && (
                              <div className="flex flex-wrap gap-1">
                                {item.candidatos.map((c, ci) => (
                                  <button
                                    key={ci}
                                    type="button"
                                    onClick={() => elegirCandidato(idx, c.nombre)}
                                    className={`text-[10px] px-2 py-1 rounded-full border font-bold active:scale-95 ${c.nombre === item.productName ? "bg-emerald-600 text-white border-emerald-600" : "bg-white text-gray-700 border-gray-300"}`}
                                  >
                                    {c.nombre.length > 34 ? c.nombre.slice(0, 34) + "…" : c.nombre}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="col-span-3">
                        <Input
                          type="number"
                          value={item.quantity}
                          onChange={(e) =>
                            updateItem(
                              idx,
                              "quantity",
                              parseInt(e.target.value) || 0
                            )
                          }
                          className="text-sm h-9"
                          min={0}
                        />
                      </div>
                      <div className="col-span-1 flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => removeItem(idx)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <div className="border-t-2 border-foreground pt-3 mt-3">
                    <p className="text-sm font-bold uppercase tracking-wider">
                      Total: {items.reduce((s, i) => s + i.quantity, 0)} unidades
                    </p>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 border border-dashed border-foreground/20 rounded">
                  <Sparkles className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Suba una foto y use la IA para extraer los medicamentos,
                    o agregue productos manualmente.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* STOCK INSUFICIENTE EN EL ORIGEN: 365 rechazaría la transferencia.
              Se avisa ANTES de confirmar y se ofrece ajustar el origen (el caso
              real es que el producto está físicamente pero el sistema dice menos). */}
          {faltantes.length > 0 && (
            <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-300">
              <p className="text-xs font-black text-red-800 dark:text-red-300 mb-1">
                ⚠ {faltantes.length} producto(s) sin stock suficiente en {sucursalOrigenNombre}
              </p>
              <p className="text-[10px] text-red-700 dark:text-red-400 mb-2">
                Declara cuánto hay <b>realmente</b> en la sucursal. Por defecto se propone lo justo para transferir, pero si en el estante hay más, ponlo — así el inventario queda con el dato verdadero y no en 0.
              </p>
              <div className="space-y-1.5 mb-2">
                {faltantes.map((f: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-[11px] text-red-700 dark:text-red-400">
                    <span className="min-w-0 truncate">
                      <b>{f.nombre}</b> · sistema: {f.hay} · necesitas: {f.necesita}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <span className="text-[10px]">hay realmente:</span>
                      <input
                        type="number"
                        min={f.necesita}
                        value={stockDeclarado[f.nombre] ?? f.necesita}
                        onChange={(e) => setStockDeclarado((prev) => ({ ...prev, [f.nombre]: Math.max(0, parseInt(e.target.value) || 0) }))}
                        className="w-16 h-7 px-1 text-center rounded border border-red-300 bg-white dark:bg-background font-bold"
                      />
                    </span>
                  </div>
                ))}
              </div>
              <Button
                onClick={() => {
                  const productos = faltantes.map((f: any) => ({
                    nombre: f.nombre,
                    stockReal: stockDeclarado[f.nombre] ?? f.necesita,
                    cantidadNecesaria: f.necesita,
                  }));
                  const detalle = productos.map((p: any) => `${p.nombre}: → ${p.stockReal}`).join("\n");
                  if (!window.confirm(`Se ajustará el inventario de ${sucursalOrigenNombre} en inventarios365:\n\n${detalle}\n\nHazlo solo si el producto SÍ está físicamente en la sucursal y el sistema está desactualizado.\n\n¿Confirmas?`)) return;
                  ajustarOrigen.mutate({ sucursalOrigen: sucursalOrigenNombre, productos });
                }}
                disabled={ajustarOrigen.isPending}
                className="w-full gap-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold uppercase tracking-wider"
              >
                {ajustarOrigen.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {ajustarOrigen.isPending ? "Ajustando inventario…" : `Ajustar inventario de ${sucursalOrigenNombre}`}
              </Button>
              <p className="text-[10px] text-red-600 dark:text-red-500 mt-1.5">
                Queda registrado como ajuste de inventario en 365. Si el producto NO está físicamente, corrige la cantidad a transferir en vez de ajustar.
              </p>
            </div>
          )}

          {items.length > 0 && (
            <div className="flex justify-end gap-3 mt-4">
              <Button
                variant="outline"
                onClick={() => setLocation("/transferencias")}
                className="uppercase tracking-wider text-xs font-semibold"
              >
                Cancelar
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSubmit(false)}
                disabled={isSubmitting}
                className="gap-2 uppercase tracking-wider text-xs font-semibold"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Guardar Borrador
              </Button>
              <Button
                onClick={() => handleSubmit(true)}
                disabled={isSubmitting}
                className="gap-2 uppercase tracking-wider text-xs font-semibold bg-green-700 hover:bg-green-800 text-white"
              >
                {isSubmitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Confirmar Transferencia
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
