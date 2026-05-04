import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, Package, CheckCircle, XCircle, Clock } from "lucide-react";

// ── Types de lingots ────────────────────────────────────────────────────────
const LINGOT_TYPES = [
  { tokenId: 1000,    label: "1g",         weightG: 1      },
  { tokenId: 5000,    label: "5g",         weightG: 5      },
  { tokenId: 10000,   label: "10g",        weightG: 10     },
  { tokenId: 20000,   label: "20g",        weightG: 20     },
  { tokenId: 31103,   label: "1 once",     weightG: 31.103 },
  { tokenId: 50000,   label: "50g",        weightG: 50     },
  { tokenId: 100000,  label: "100g",       weightG: 100    },
  { tokenId: 250000,  label: "250g",       weightG: 250    },
  { tokenId: 500000,  label: "500g",       weightG: 500    },
  { tokenId: 1000000, label: "1kg",        weightG: 1000   },
];

const BURN_REASONS = [
  "livraison physique",
  "non conforme",
  "refonte",
  "erreur de mint",
];

// ── Rôles ───────────────────────────────────────────────────────────────────
const MINTER_ROLE    = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const VALIDATOR_ROLE = "0x21702c8af46127c7fa207f89d0b0a8441bb32959a0ac7df790e9ab1a25c98926";

// ── Card ────────────────────────────────────────────────────────────────────
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <h3 className="font-semibold text-base">{title}</h3>
      <Separator />
      {children}
    </div>
  );
}

// ── Badge statut proposal ────────────────────────────────────────────────────
function ProposalStatus({ executed, rejected }: { executed: boolean; rejected: boolean }) {
  if (executed) return <Badge variant="default" className="gap-1"><CheckCircle className="h-3 w-3" />Approuvé</Badge>;
  if (rejected) return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Rejeté</Badge>;
  return <Badge variant="outline" className="gap-1"><Clock className="h-3 w-3" />En attente</Badge>;
}

// ── Page principale ──────────────────────────────────────────────────────────
export default function LingotsPage() {
  const { address, isConnected } = useAccount();
  const { lingotOr } = useContracts();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { writeContractAsync, isPending } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });
  const isLoading = isPending || isConfirming;

  // ── Vérification des rôles ─────────────────────────────────────────────
  const { data: isMinter } = useReadContract({
    ...lingotOr,
    functionName: "hasRole",
    args: address ? [MINTER_ROLE as `0x${string}`, address] : undefined,
  });
  const { data: isValidator } = useReadContract({
    ...lingotOr,
    functionName: "hasRole",
    args: address ? [VALIDATOR_ROLE as `0x${string}`, address] : undefined,
  });

  const hasAccess = isMinter || isValidator;

  // ── Stock actuel ───────────────────────────────────────────────────────
  const { data: totalGrammes } = useReadContract({
    ...lingotOr,
    functionName: "totalGrammesEnCoffre",
  });

  // ── Proposals ─────────────────────────────────────────────────────────
  const { data: mintCount } = useReadContract({ ...lingotOr, functionName: "mintProposalCount" });
  const { data: burnCount } = useReadContract({ ...lingotOr, functionName: "burnProposalCount" });

  // Lire les 5 dernières mint proposals
  const lastMintIds = mintCount ? Array.from(
    { length: Math.min(5, Number(mintCount)) },
    (_, i) => Number(mintCount) - i
  ) : [];
  const lastBurnIds = burnCount ? Array.from(
    { length: Math.min(5, Number(burnCount)) },
    (_, i) => Number(burnCount) - i
  ) : [];

  // ── Formulaire proposeMint ─────────────────────────────────────────────
  const [mintForm, setMintForm] = useState({
    tokenId: "1000", amount: "1", to: address ?? "",
    serialCode: "", refiner: "", supplier: "", origin: "",
  });

  const handleProposeMint = async () => {
    try {
      const tx = await writeContractAsync({
        ...lingotOr,
        functionName: "proposeMint",
        args: [
          BigInt(mintForm.tokenId),
          BigInt(mintForm.amount),
          mintForm.to as `0x${string}`,
          mintForm.serialCode,
          mintForm.refiner,
          mintForm.supplier,
          mintForm.origin,
        ],
      });
      setTxHash(tx);
      setMintForm({ tokenId: "1000", amount: "1", to: address ?? "", serialCode: "", refiner: "", supplier: "", origin: "" });
    } catch {}
  };

  // ── Formulaire proposeBurn ─────────────────────────────────────────────
  const [burnForm, setBurnForm] = useState({
    tokenId: "1000", amount: "1", from: "",
    serialCode: "", reason: "livraison physique",
  });

  const handleProposeBurn = async () => {
    try {
      const tx = await writeContractAsync({
        ...lingotOr,
        functionName: "proposeBurn",
        args: [
          BigInt(burnForm.tokenId),
          BigInt(burnForm.amount),
          burnForm.from as `0x${string}`,
          burnForm.serialCode,
          burnForm.reason,
        ],
      });
      setTxHash(tx);
      setBurnForm({ tokenId: "1000", amount: "1", from: "", serialCode: "", reason: "livraison physique" });
    } catch {}
  };

  // ── Approve/Reject ─────────────────────────────────────────────────────
  const handleApproveMint = async (id: number) => {
    try {
      const tx = await writeContractAsync({ ...lingotOr, functionName: "approveMint", args: [BigInt(id)] });
      setTxHash(tx);
    } catch {}
  };
  const handleRejectMint = async (id: number) => {
    try {
      const tx = await writeContractAsync({ ...lingotOr, functionName: "rejectMint", args: [BigInt(id)] });
      setTxHash(tx);
    } catch {}
  };
  const handleApproveBurn = async (id: number) => {
    try {
      const tx = await writeContractAsync({ ...lingotOr, functionName: "approveBurn", args: [BigInt(id)] });
      setTxHash(tx);
    } catch {}
  };
  const handleRejectBurn = async (id: number) => {
    try {
      const tx = await writeContractAsync({ ...lingotOr, functionName: "rejectBurn", args: [BigInt(id)] });
      setTxHash(tx);
    } catch {}
  };

  if (!mounted) return null;

  // ── Accès refusé ───────────────────────────────────────────────────────
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
          <p className="text-muted-foreground text-sm">
            {isMinter && <Badge variant="outline" className="mr-2">Gardien</Badge>}
            {isValidator && <Badge variant="outline" className="mr-2">Validateur</Badge>}
            Total en coffre : {totalGrammes !== undefined ? `${(Number(totalGrammes) / 1000000).toFixed(3)} kg` : "—"}
          </p>
        </div>
      </div>

      {/* Propose Mint — gardien uniquement */}
      {isMinter && (
        <Card title="Proposer un mint (réception de lingot)">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type de lingot</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={mintForm.tokenId}
                onChange={e => setMintForm(f => ({ ...f, tokenId: e.target.value }))}>
                {LINGOT_TYPES.map(l => (
                  <option key={l.tokenId} value={l.tokenId}>{l.label} ({l.weightG}g)</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Quantité</Label>
              <Input type="number" min="1" value={mintForm.amount}
                onChange={e => setMintForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Destinataire (adresse)</Label>
              <Input placeholder="0x..." value={mintForm.to}
                onChange={e => setMintForm(f => ({ ...f, to: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Numéro de série</Label>
              <Input placeholder="GLD-2026-000001" value={mintForm.serialCode}
                onChange={e => setMintForm(f => ({ ...f, serialCode: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Raffineur</Label>
              <Input placeholder="Valcambi" value={mintForm.refiner}
                onChange={e => setMintForm(f => ({ ...f, refiner: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Gardien / Fournisseur</Label>
              <Input placeholder="Brink's" value={mintForm.supplier}
                onChange={e => setMintForm(f => ({ ...f, supplier: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Origine</Label>
              <Input placeholder="Suisse" value={mintForm.origin}
                onChange={e => setMintForm(f => ({ ...f, origin: e.target.value }))} />
            </div>
          </div>
          <Button className="w-full" onClick={handleProposeMint}
            disabled={isLoading || !mintForm.serialCode || !mintForm.to}>
            {isLoading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</> : "Proposer le mint"}
          </Button>
        </Card>
      )}

      {/* Propose Burn — gardien uniquement */}
      {isMinter && (
        <Card title="Proposer un burn (sortie de lingot)">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Type de lingot</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={burnForm.tokenId}
                onChange={e => setBurnForm(f => ({ ...f, tokenId: e.target.value }))}>
                {LINGOT_TYPES.map(l => (
                  <option key={l.tokenId} value={l.tokenId}>{l.label} ({l.weightG}g)</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Quantité</Label>
              <Input type="number" min="1" value={burnForm.amount}
                onChange={e => setBurnForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div className="space-y-2 col-span-2">
              <Label>Adresse du détenteur</Label>
              <Input placeholder="0x..." value={burnForm.from}
                onChange={e => setBurnForm(f => ({ ...f, from: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Numéro de série</Label>
              <Input placeholder="GLD-2026-000001" value={burnForm.serialCode}
                onChange={e => setBurnForm(f => ({ ...f, serialCode: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Raison</Label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={burnForm.reason}
                onChange={e => setBurnForm(f => ({ ...f, reason: e.target.value }))}>
                {BURN_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <Button className="w-full" variant="outline" onClick={handleProposeBurn}
            disabled={isLoading || !burnForm.serialCode || !burnForm.from}>
            {isLoading ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</> : "Proposer le burn"}
          </Button>
        </Card>
      )}

      {/* Proposals en attente — validateur */}
      {isValidator && (
        <>
          <Card title={`Mint proposals (${mintCount ?? 0} total)`}>
            <div className="space-y-3">
              {lastMintIds.length === 0 && <p className="text-sm text-muted-foreground">Aucune proposal.</p>}
              {lastMintIds.map(id => (
                <MintProposalRow key={id} id={id} lingotOr={lingotOr}
                  onApprove={() => handleApproveMint(id)}
                  onReject={() => handleRejectMint(id)}
                  isLoading={isLoading} />
              ))}
            </div>
          </Card>

          <Card title={`Burn proposals (${burnCount ?? 0} total)`}>
            <div className="space-y-3">
              {lastBurnIds.length === 0 && <p className="text-sm text-muted-foreground">Aucune proposal.</p>}
              {lastBurnIds.map(id => (
                <BurnProposalRow key={id} id={id} lingotOr={lingotOr}
                  onApprove={() => handleApproveBurn(id)}
                  onReject={() => handleRejectBurn(id)}
                  isLoading={isLoading} />
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ── MintProposalRow ──────────────────────────────────────────────────────────
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
        <span className="font-medium text-sm">#{id} — {lingot?.label ?? proposal.tokenId.toString()} × {proposal.amount.toString()}</span>
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

// ── BurnProposalRow ──────────────────────────────────────────────────────────
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
        <span className="font-medium text-sm">#{id} — {lingot?.label ?? proposal.tokenId.toString()} × {proposal.amount.toString()}</span>
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