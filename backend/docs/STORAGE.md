# Storage Slots — InvestOr Protocol

## Principe du __gap

Dans un contrat upgradeable UUPS, le storage est partagé entre le proxy et toutes les implémentations successives. Si une future implémentation ajoute une variable, elle doit écrire dans un slot libre — sinon elle écrase une variable existante.

**La solution : réserver des slots avec `uint256[N] private __gap`**

La règle est :  
`variables_actuelles + __gap = 50 slots`

Ainsi, on peut ajouter jusqu'à `__gap` nouvelles variables sans collision.

---

## GLD.sol

| Slot | Variable | Type | Taille |
|------|----------|------|--------|
| 0 | `_blacklisted` | mapping(address => bool) | 1 slot |
| 1 | `minter` | address | 1 slot |
| 2..49 | `__gap` | uint256[48] | 48 slots |
| **Total** | | | **50 slots** |

> Slots hérités d'OZ (ERC20, Pausable, Ownable, UUPS) : gérés par leurs propres __gap internes.

---

## Treasury.sol

| Slot | Variable | Type | Taille |
|------|----------|------|--------|
| 0 | `usdc` | IERC20 (address) | 1 slot |
| 1 | `_deposits` | mapping(address => uint256) | 1 slot |
| 2 | `_totalDeposited` | uint256 | 1 slot |
| 3 | `operator` | address | 1 slot |
| 4..49 | `__gap` | uint256[46] | 46 slots |
| **Total** | | | **50 slots** |

---

## Exchange.sol

| Slot | Variable | Type | Taille |
|------|----------|------|--------|
| 0 | `gld` | IGLD (address) | 1 slot |
| 1 | `treasury` | ITreasury (address) | 1 slot |
| 2 | `usdc` | IERC20 (address) | 1 slot |
| 3 | `priceOracle` | AggregatorV3Interface (address) | 1 slot |
| 4 | `fallbackPrice` | uint256 | 1 slot |
| 5 | `oracleMaxAge` | uint256 | 1 slot |
| 6 | `feeBps` | uint256 | 1 slot |
| 7 | `feeCollector` | address | 1 slot |
| 8..49 | `__gap` | uint256[42] | 42 slots |
| **Total** | | | **50 slots** |

---

## EventLogger.sol

| Slot | Variable | Type | Taille |
|------|----------|------|--------|
| 0 | `authorizedSources` | mapping(address => bool) | 1 slot |
| 1 | `_log` | LogEntry[] (dynamic array) | 1 slot |
| 2 | `_userEntries` | mapping(address => uint256[]) | 1 slot |
| 3..49 | `__gap` | uint256[47] | 47 slots |
| **Total** | | | **50 slots** |

---

## Règles pour les upgrades futurs

1. **Ne jamais supprimer** une variable existante
2. **Ne jamais changer l'ordre** des variables existantes  
3. **Ajouter uniquement en fin de liste**, avant `__gap`
4. **Réduire `__gap`** du nombre de slots ajoutés
5. **Exemple** : si on ajoute `uint256 public newVar` dans GLD, `__gap` passe de `uint256[48]` à `uint256[47]`

---

## Slot ERC-1967 (référence)

L'adresse de l'implémentation est stockée au slot pseudo-aléatoire :
```
keccak256("eip1967.proxy.implementation") - 1
= 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
```
Ce slot ne peut jamais entrer en collision avec les variables déclarées normalement.
