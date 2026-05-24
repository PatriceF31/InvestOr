import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Package, CheckCircle, XCircle, Clock, Plus, Trash2 } from "lucide-react";

// ── Constantes ────────────────────────────────────────────────────────────────

const LINGOT_TYPES = [
  { tokenId: 1000,    label: "1g",     weightG: 1      },
  { tokenId: 5000,    label: "5g",     weightG: 5      },
  { tokenId: 10000,   label: "10g",    weightG: 10     },
  { tokenId: 20000,   label: "20g",    weightG: 20     },
  { tokenId: 31103,   label: "1 once", weightG: 31.103 },
  { tokenId: 50000,   label: "50g",    weightG: 50     },
  { tokenId: 100000,  label: "100g",   weightG: 100    },
  { tokenId: 250000,  label: "250g",   weightG: 250    },
  { tokenId: 500000,  label: "500g",   weightG: 500    },
  { tokenId: 1000000, label: "1kg",    weightG: 1000   },
];

const BURN_REASONS = ["livraison physique", "non conforme", "refonte", "erreur de mint"];

const MINTER_ROLE    = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const VALIDATOR_ROLE = "0x21702c8af46127c7fa207f89d0b0a8441bb32959a0ac7df790e9ab1a25c98926";

// ── Types batch ───────────────────────────────────────────────────────────────

type BatchLine = {
  id:         string;  // uuid local pour la key React
  tokenId:    string;
  amount:     string;
  to:         string;
  serialCode: string;
};

const emptyLine = (to: string): BatchLine => ({
  id:         Math.random().toString(36).slice(2),
  tokenId:    "1000",
  amount:     "1",
  to,
  serialCode: "",
});

// ── Composants utilitaires ────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <h3 className="font-semibold text-base">{title}</h3>
      <Separator />
      {children}
    </div>
  );
}

function ProposalStatus({ executed, rejected }: { executed: boolean; rejected: boolean }) {
  if (executed) return <Badge variant="default"  className="gap-1"><CheckCircle className="h-3 w-3" />Approuvé</Badge>;
  if (rejected) return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Rejeté</Badge>;
  return <Badge variant="outline" className="gap-1"><Clock className="h-3 w-3" />En attente</Badge>;
}

function LingotSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      value={value} onChange={e => onChange(e.target.value)}>
      {LINGOT_TYPES.map(l => (
        <option key={l.tokenId} value={l.tokenId}>{l.label} ({l.weightG}g)</option>
      ))}
    </select>
  );
}

// ── Formulaire Propose Mint UNITAIRE ─────────────────────────────────────────

function ProposeMintForm({ lingotOr, address, isLoading, onTx }: {
  lingotOr: any; address: string; isLoading: boolean; onTx: (h: `0x${string}`) => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const [form, setForm] = useState({
    tokenId: "1000", amount: "1", to: address,
    serialCode: "", refiner: "", supplier: "", origin: "",
  });

  const handle = async () => {
    try {
      const tx = await writeContractAsync({
        ...lingotOr,
        functionName: "proposeMint",
        args: [
          BigInt(form.tokenId), BigInt(form.amount),
          form.to as `0x${string}`,
          form.serialCode, form.refiner, form.supplier, form.origin,
        ],
      });
      onTx(tx);
      setForm({ tokenId: "1000", amount: "1", to: address, serialCode: "", refiner: "", supplier: "", origin: "" });
    } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Type de lingot</Label>
          <LingotSelect value={form.tokenId} onChange={v => setForm(f => ({ ...f, tokenId: v }))} />
        </div>
        <div className="space-y-2">
          <Label>Quantité</Label>
          <Input type="number" min="1" value={form.amount}
            onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
        </div>
        <div className="space-y-2 col-span-2">
          <Label>Destinataire</Label>
          <Input placeholder="0x..." value={form.to}
            onChange={e => setForm(f => ({ ...f, to: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Numéro de série</Label>
          <Input placeholder="GLD-2026-000001" value={form.serialCode}
            onChange={e => setForm(f => ({ ...f, serialCode: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Raffineur</Label>
          <Input placeholder="Valcambi" value={form.refiner}
            onChange={e => setForm(f => ({ ...f, refiner: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Gardien / Fournisseur</Label>
          <Input placeholder="Brink's" value={form.supplier}
            onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Origine</Label>
          <Input placeholder="Suisse" value={form.origin}
            onChange={e => setForm(f => ({ ...f, origin: e.target.value }))} />
        </div>
      </div>
      <Button className="w-full" onClick={handle}
        disabled={isLoading || !form.serialCode || !form.to}>
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
          : "Proposer le mint"
        }
      </Button>
    </div>
  );
}

// ── Formulaire Propose Mint BATCH ─────────────────────────────────────────────

function ProposeMintBatchForm({ lingotOr, address, isLoading, onTx }: {
  lingotOr: any; address: string; isLoading: boolean; onTx: (h: `0x${string}`) => void;
}) {
  const { writeContractAsync } = useWriteContract();

  // Métadonnées communes à tous les lingots du batch
  const [meta, setMeta] = useState({ refiner: "", supplier: "", origin: "" });

  // Lignes du batch — initialisées avec address dès qu'il est disponible
  const [lines, setLines] = useState<BatchLine[]>([emptyLine("")]);

  // Mettre à jour le destinataire de la première ligne quand address arrive
  useEffect(() => {
    if (address) {
      setLines(l => l.map((line, i) => i === 0 && !line.to ? { ...line, to: address } : line));
    }
  }, [address]);

  const addLine    = () => setLines(l => [...l, emptyLine(address)]);
  const removeLine = (id: string) => setLines(l => l.filter(x => x.id !== id));
  const updateLine = (id: string, field: keyof BatchLine, value: string) =>
    setLines(l => l.map(x => x.id === id ? { ...x, [field]: value } : x));

  // Calcul du total en grammes
  const totalGrams = lines.reduce((acc, l) => {
    const t = LINGOT_TYPES.find(x => x.tokenId === Number(l.tokenId));
    return acc + (t?.weightG ?? 0) * Number(l.amount || 0);
  }, 0);

  const canSubmit = lines.length > 0 &&
    lines.every(l => l.serialCode && l.to) &&
    !!meta.refiner && !!meta.supplier && !!meta.origin;

  // Debug
  console.log("canSubmit:", canSubmit, "lines:", lines.map(l => ({ to: l.to, serial: l.serialCode })), "meta:", meta);

  const handle = async () => {
    try {
      const inputs = lines.map(l => ({
        tokenId:    BigInt(l.tokenId),
        amount:     BigInt(l.amount || "1"),
        to:         l.to as `0x${string}`,
        serialCode: l.serialCode,
      }));
      console.log("proposeMintBatch args:", inputs, meta.refiner, meta.supplier, meta.origin);
      const tx = await writeContractAsync({
        ...lingotOr,
        functionName: "proposeMintBatch",
        args: [inputs, meta.refiner, meta.supplier, meta.origin],
      });
      onTx(tx);
      setLines([emptyLine(address)]);
      setMeta({ refiner: "", supplier: "", origin: "" });
    } catch (e) { console.error("proposeMintBatch error:", e); }
  };

  return (
    <div className="space-y-6">
      {/* Métadonnées communes */}
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Raffineur (commun)</Label>
          <Input placeholder="Valcambi" value={meta.refiner}
            onChange={e => setMeta(m => ({ ...m, refiner: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Gardien (commun)</Label>
          <Input placeholder="Brink's" value={meta.supplier}
            onChange={e => setMeta(m => ({ ...m, supplier: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Origine (commune)</Label>
          <Input placeholder="Suisse" value={meta.origin}
            onChange={e => setMeta(m => ({ ...m, origin: e.target.value }))} />
        </div>
      </div>

      <Separator />

      {/* En-tête colonnes */}
      <div className="grid grid-cols-[2fr_1fr_2fr_2fr_auto] gap-2 text-xs font-medium text-muted-foreground px-1">
        <span>Type</span>
        <span>Qté</span>
        <span>Destinataire</span>
        <span>N° de série</span>
        <span></span>
      </div>

      {/* Lignes */}
      <div className="space-y-2">
        {lines.map((line, i) => (
          <div key={line.id} className="grid grid-cols-[2fr_1fr_2fr_2fr_auto] gap-2 items-center">
            <LingotSelect value={line.tokenId}
              onChange={v => updateLine(line.id, "tokenId", v)} />
            <Input type="number" min="1" value={line.amount}
              onChange={e => updateLine(line.id, "amount", e.target.value)} />
            <Input placeholder="0x..." value={line.to}
              onChange={e => updateLine(line.id, "to", e.target.value)} />
            <Input placeholder="GLD-2026-000001" value={line.serialCode}
              onChange={e => updateLine(line.id, "serialCode", e.target.value)} />
            <Button variant="ghost" size="icon" className="text-muted-foreground"
              disabled={lines.length === 1}
              onClick={() => removeLine(line.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={addLine}>
          <Plus className="h-4 w-4 mr-2" />Ajouter un lingot
        </Button>
        <div className="text-sm text-muted-foreground">
          {lines.length} lingot{lines.length > 1 ? "s" : ""} — {totalGrams.toFixed(3)}g total
        </div>
      </div>

      <Button className="w-full" onClick={handle} disabled={isLoading || !canSubmit}>
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
          : `Proposer le batch (${lines.length} lingot${lines.length > 1 ? "s" : ""})`
        }
      </Button>

      {!canSubmit && lines.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Complétez tous les numéros de série, destinataires et les métadonnées communes.
        </p>
      )}
    </div>
  );
}

// ── Propose Burn ──────────────────────────────────────────────────────────────

function ProposeBurnForm({ lingotOr, isLoading, onTx }: {
  lingotOr: any; isLoading: boolean; onTx: (h: `0x${string}`) => void;
}) {
  const { writeContractAsync } = useWriteContract();
  const [form, setBurnForm] = useState({
    tokenId: "1000", amount: "1", from: "", serialCode: "", reason: "livraison physique",
  });

  const handle = async () => {
    try {
      const tx = await writeContractAsync({
        ...lingotOr,
        functionName: "proposeBurn",
        args: [
          BigInt(form.tokenId), BigInt(form.amount),
          form.from as `0x${string}`,
          form.serialCode, form.reason,
        ],
      });
      onTx(tx);
      setBurnForm({ tokenId: "1000", amount: "1", from: "", serialCode: "", reason: "livraison physique" });
    } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Type de lingot</Label>
          <LingotSelect value={form.tokenId} onChange={v => setBurnForm(f => ({ ...f, tokenId: v }))} />
        </div>
        <div className="space-y-2">
          <Label>Quantité</Label>
          <Input type="number" min="1" value={form.amount}
            onChange={e => setBurnForm(f => ({ ...f, amount: e.target.value }))} />
        </div>
        <div className="space-y-2 col-span-2">
          <Label>Adresse du détenteur</Label>
          <Input placeholder="0x..." value={form.from}
            onChange={e => setBurnForm(f => ({ ...f, from: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Numéro de série</Label>
          <Input placeholder="GLD-2026-000001" value={form.serialCode}
            onChange={e => setBurnForm(f => ({ ...f, serialCode: e.target.value }))} />
        </div>
        <div className="space-y-2">
          <Label>Raison</Label>
          <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={form.reason} onChange={e => setBurnForm(f => ({ ...f, reason: e.target.value }))}>
            {BURN_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>
      <Button className="w-full" variant="outline" onClick={handle}
        disabled={isLoading || !form.serialCode || !form.from}>
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
          : "Proposer le burn"
        }
      </Button>
    </div>
  );
}

// ── Rows proposals ────────────────────────────────────────────────────────────

function MintProposalRow({ id, lingotOr, onApprove, onReject, isLoading }: {
  id: number; lingotOr: any;
  onApprove: () => void; onReject: () => void; isLoading: boolean;
}) {
  const { data: p } = useReadContract({
    ...lingotOr, functionName: "getMintProposal", args: [BigInt(id)],
  });
  if (!p) return null;
  const proposal = p as any;
  const lingot = LINGOT_TYPES.find(l => l.tokenId === Number(proposal.tokenId));
  return (
    <div className="rounded-lg border border-border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">
          #{id} — {lingot?.label ?? proposal.tokenId.toString()} × {proposal.amount.toString()}
        </span>
        <ProposalStatus executed={proposal.executed} rejected={proposal.rejected} />
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Série : {proposal.serialCode} | Raffineur : {proposal.refiner} | Origine : {proposal.origin}</p>
        <p>Destinataire : {proposal.to}</p>
      </div>
      {!proposal.executed && !proposal.rejected && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={onApprove} disabled={isLoading}>
            {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "✓ Approuver"}
          </Button>
          <Button size="sm" variant="destructive" onClick={onReject} disabled={isLoading}>
            ✕ Rejeter
          </Button>
        </div>
      )}
    </div>
  );
}

function BurnProposalRow({ id, lingotOr, onApprove, onReject, isLoading }: {
  id: number; lingotOr: any;
  onApprove: () => void; onReject: () => void; isLoading: boolean;
}) {
  const { data: p } = useReadContract({
    ...lingotOr, functionName: "getBurnProposal", args: [BigInt(id)],
  });
  if (!p) return null;
  const proposal = p as any;
  const lingot = LINGOT_TYPES.find(l => l.tokenId === Number(proposal.tokenId));
  return (
    <div className="rounded-lg border border-border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">
          #{id} — {lingot?.label ?? proposal.tokenId.toString()} × {proposal.amount.toString()}
        </span>
        <ProposalStatus executed={proposal.executed} rejected={proposal.rejected} />
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Série : {proposal.serialCode} | Raison : {proposal.reason}</p>
        <p>De : {proposal.from}</p>
      </div>
      {!proposal.executed && !proposal.rejected && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={onApprove} disabled={isLoading}>
            {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : "✓ Approuver"}
          </Button>
          <Button size="sm" variant="destructive" onClick={onReject} disabled={isLoading}>
            ✕ Rejeter
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Page principale ───────────────────────────────────────────────────────────

export default function LingotsPage() {
  const { address, isConnected } = useAccount();
  const { lingotOr } = useContracts();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: txConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });
  const [isPending, setIsPending] = useState(false);
  const isLoading = isPending || isConfirming;

  const handleTx = (h: `0x${string}`) => { setTxHash(h); setIsPending(false); };

  // Rôles
  const { data: isMinter }    = useReadContract({
    ...lingotOr, functionName: "hasRole",
    args: address ? [MINTER_ROLE as `0x${string}`, address] : undefined,
  });
  const { data: isValidator } = useReadContract({
    ...lingotOr, functionName: "hasRole",
    args: address ? [VALIDATOR_ROLE as `0x${string}`, address] : undefined,
  });
  const hasAccess = isMinter || isValidator;

  // Stock
  const { data: totalGrammes } = useReadContract({
    ...lingotOr, functionName: "totalGrammesEnCoffre",
  });

  // Proposals
  const { data: mintCount } = useReadContract({ ...lingotOr, functionName: "mintProposalCount" });
  const { data: burnCount } = useReadContract({ ...lingotOr, functionName: "burnProposalCount" });

  const lastMintIds = mintCount ? Array.from(
    { length: Math.min(5, Number(mintCount)) }, (_, i) => Number(mintCount) - i
  ) : [];
  const lastBurnIds = burnCount ? Array.from(
    { length: Math.min(5, Number(burnCount)) }, (_, i) => Number(burnCount) - i
  ) : [];

  // Approve / Reject
  const handleApproveMint = async (id: number) => {
    try {
      setIsPending(true);
      const tx = await writeContractAsync({ ...lingotOr, functionName: "approveMint", args: [BigInt(id)] });
      handleTx(tx);
    } catch { setIsPending(false); }
  };
  const handleRejectMint = async (id: number) => {
    try {
      setIsPending(true);
      const tx = await writeContractAsync({ ...lingotOr, functionName: "rejectMint", args: [BigInt(id)] });
      handleTx(tx);
    } catch { setIsPending(false); }
  };
  const handleApproveBurn = async (id: number) => {
    try {
      setIsPending(true);
      const tx = await writeContractAsync({ ...lingotOr, functionName: "approveBurn", args: [BigInt(id)] });
      handleTx(tx);
    } catch { setIsPending(false); }
  };
  const handleRejectBurn = async (id: number) => {
    try {
      setIsPending(true);
      const tx = await writeContractAsync({ ...lingotOr, functionName: "rejectBurn", args: [BigInt(id)] });
      handleTx(tx);
    } catch { setIsPending(false); }
  };

  if (!mounted) return null;

  if (!isConnected) return (
    <div className="max-w-2xl mx-auto text-center py-20">
      <Package className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
      <p className="text-muted-foreground">Connectez votre portefeuille pour accéder à cette page.</p>
    </div>
  );

  if (!hasAccess) return (
    <div className="max-w-2xl mx-auto text-center py-20">
      <XCircle className="h-12 w-12 mx-auto mb-4 text-destructive" />
      <p className="font-semibold">Accès restreint</p>
      <p className="text-muted-foreground text-sm mt-2">Cette page est réservée aux gardiens et validateurs.</p>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-6">

      {/* En-tête */}
      <div className="flex items-center gap-3">
        <Package className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-3xl font-bold">Gestion des lingots</h1>
          <p className="text-muted-foreground text-sm flex items-center gap-2 mt-1">
            {isMinter    && <Badge variant="outline">Gardien</Badge>}
            {isValidator && <Badge variant="outline">Validateur</Badge>}
            Total en coffre :{" "}
            <span className="font-semibold text-foreground">
              {totalGrammes !== undefined
                ? `${(Number(totalGrammes) / 1000000).toFixed(3)} kg`
                : "—"}
            </span>
          </p>
        </div>
      </div>

      {/* Statut tx */}
      {(isConfirming || txConfirmed) && (
        <div className={`rounded-lg p-4 flex items-center gap-3 text-sm ${
          txConfirmed ? "bg-green-500/10 border border-green-500/20" : "bg-primary/10 border border-primary/20"
        }`}>
          {isConfirming && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {txConfirmed  && <CheckCircle className="h-4 w-4 text-green-500" />}
          <span>{isConfirming ? "Transaction en cours..." : "Transaction confirmée ✓"}</span>
        </div>
      )}

      {/* ── Section Gardien : Proposer ─────────────────────────────────── */}
      {isMinter && (
        <Card title="Proposer un mint (réception de lingot)">
          <Tabs defaultValue="unitaire">
            <TabsList className="w-full mb-4">
              <TabsTrigger value="unitaire" className="flex-1">Lingot unique</TabsTrigger>
              <TabsTrigger value="batch"    className="flex-1">
                Batch
                <Badge variant="secondary" className="ml-2 text-xs">Nouveau</Badge>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="unitaire">
              <ProposeMintForm
                lingotOr={lingotOr}
                address={address ?? ""}
                isLoading={isLoading}
                onTx={handleTx}
              />
            </TabsContent>
            <TabsContent value="batch">
              <ProposeMintBatchForm
                lingotOr={lingotOr}
                address={address ?? ""}
                isLoading={isLoading}
                onTx={handleTx}
              />
            </TabsContent>
          </Tabs>
        </Card>
      )}

      {/* ── Section Gardien : Proposer Burn ────────────────────────────── */}
      {isMinter && (
        <Card title="Proposer un burn (sortie de lingot)">
          <ProposeBurnForm lingotOr={lingotOr} isLoading={isLoading} onTx={handleTx} />
        </Card>
      )}

      {/* ── Section Validateur : Proposals en attente ───────────────────── */}
      {isValidator && (
        <>
          <Card title={`Mint proposals (${mintCount ?? 0} total)`}>
            <div className="space-y-3">
              {lastMintIds.length === 0
                ? <p className="text-sm text-muted-foreground">Aucune proposal.</p>
                : lastMintIds.map(id => (
                    <MintProposalRow key={id} id={id} lingotOr={lingotOr}
                      onApprove={() => handleApproveMint(id)}
                      onReject={()  => handleRejectMint(id)}
                      isLoading={isLoading} />
                  ))
              }
            </div>
          </Card>

          <Card title={`Burn proposals (${burnCount ?? 0} total)`}>
            <div className="space-y-3">
              {lastBurnIds.length === 0
                ? <p className="text-sm text-muted-foreground">Aucune proposal.</p>
                : lastBurnIds.map(id => (
                    <BurnProposalRow key={id} id={id} lingotOr={lingotOr}
                      onApprove={() => handleApproveBurn(id)}
                      onReject={()  => handleRejectBurn(id)}
                      isLoading={isLoading} />
                  ))
              }
            </div>
          </Card>
        </>
      )}

    </div>
  );
}

export async function getStaticProps({ params }: GetStaticPropsContext) {
  const safeLocale = (params?.locale as string) ?? "fr";
  const messages = (await import(`@/messages/${safeLocale}.json`)).default;
  return { props: { locale: safeLocale, messages } };
}
export async function getStaticPaths() {
  return {
    paths: [{ params: { locale: "fr" } }, { params: { locale: "pt" } }],
    fallback: false,
  };
}
