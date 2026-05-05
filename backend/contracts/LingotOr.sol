// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// ─── Interface SerialNumber ───────────────────────────────────────────────────
interface ISerialNumber {
    function generate(address issuedTo) external returns (uint256 id, string memory code);
    function deactivate(uint256 id) external;
    function getSerialByCode(string calldata code) external view returns (
        uint256 id, string memory serialCode, address issuedTo, bool active, uint256 createdAt
    );
}

/**
 * @title LingotOr
 * @notice Tokenisation de lingots d'or physiques via ERC-1155
 * @dev UUPS upgradeable — workflow mint/burn en deux étapes (propose → approve)
 *
 * TokenIds (poids en milligrammes) :
 *   1000    = 1g
 *   5000    = 5g
 *   10000   = 10g
 *   20000   = 20g
 *   31103   = 1 once troy
 *   50000   = 50g
 *   100000  = 100g
 *   250000  = 250g
 *   500000  = 500g
 *   1000000 = 1kg
 */
contract LingotOr is
    Initializable,
    ERC1155Upgradeable,
    ERC1155SupplyUpgradeable,
    AccessControlUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuard
{
    // ─── Rôles ───────────────────────────────────────────────────────────────
    bytes32 public constant MINTER_ROLE    = keccak256("MINTER_ROLE");
    bytes32 public constant VALIDATOR_ROLE = keccak256("VALIDATOR_ROLE");

    // ─── Structs ──────────────────────────────────────────────────────────────
    struct MintProposal {
        uint256 tokenId;
        uint256 amount;
        address to;
        string  serialCode;
        string  refiner;
        string  supplier;
        string  origin;
        bool    executed;
        bool    rejected;
        address proposedBy;
        uint256 proposedAt;
    }

    struct BurnProposal {
        uint256 tokenId;
        uint256 amount;
        address from;
        string  serialCode;
        string  reason;
        bool    executed;
        bool    rejected;
        address proposedBy;
        uint256 proposedAt;
    }

    struct MintProposalInput {
        uint256 tokenId;
        uint256 amount;
        address to;
        string  serialCode;
    }

    struct BurnProposalInput {
        uint256 tokenId;
        uint256 amount;
        address from;
        string  serialCode;
    }

    // ─── State ────────────────────────────────────────────────────────────────
    ISerialNumber public serialNumber;
    string private _baseURI;

    mapping(uint256 => MintProposal) public mintProposals;
    mapping(uint256 => BurnProposal) public burnProposals;
    uint256 public mintProposalCount;
    uint256 public burnProposalCount;

    // TokenIds valides
    mapping(uint256 => bool) public validTokenIds;

    // ─── Erreurs ──────────────────────────────────────────────────────────────
    error InvalidTokenId(uint256 tokenId);
    error InvalidAmount();
    error InvalidAddress();
    error ProposalNotFound(uint256 proposalId);
    error ProposalAlreadyExecuted(uint256 proposalId);
    error ProposalAlreadyRejected(uint256 proposalId);
    error InsufficientBalance(address from, uint256 tokenId, uint256 amount);

    // ─── Events ───────────────────────────────────────────────────────────────
    event MintProposed(
        uint256 indexed proposalId, uint256 indexed tokenId,
        address indexed to, string serialCode, address proposedBy
    );
    event MintApproved(
        uint256 indexed proposalId, uint256 indexed tokenId,
        address indexed to, uint256 amount, string serialCode
    );
    event MintRejected(uint256 indexed proposalId, address rejectedBy);

    event BurnProposed(
        uint256 indexed proposalId, uint256 indexed tokenId,
        address indexed from, string reason, address proposedBy
    );
    event BurnApproved(
        uint256 indexed proposalId, uint256 indexed tokenId,
        address indexed from, uint256 amount, string serialCode
    );
    event BurnRejected(uint256 indexed proposalId, address rejectedBy);

    event SerialNumberUpdated(address indexed oldAddr, address indexed newAddr);
    event BaseURIUpdated(string newBaseURI);

    // ─── Constructor ──────────────────────────────────────────────────────────
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ─── Initializer ──────────────────────────────────────────────────────────
    function initialize(
        address initialOwner,
        address serialNumberAddr,
        string calldata baseURI_
    ) external initializer {
        __ERC1155_init(baseURI_);
        __ERC1155Supply_init();
        __AccessControl_init();
        __Ownable_init(initialOwner);
        __Pausable_init();

        serialNumber = ISerialNumber(serialNumberAddr);
        _baseURI = baseURI_;

        // Accorder les rôles au owner initial
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(VALIDATOR_ROLE, initialOwner);

        // Initialiser les tokenIds valides
        validTokenIds[1000]    = true; // 1g
        validTokenIds[5000]    = true; // 5g
        validTokenIds[10000]   = true; // 10g
        validTokenIds[20000]   = true; // 20g
        validTokenIds[31103]   = true; // 1 once troy
        validTokenIds[50000]   = true; // 50g
        validTokenIds[100000]  = true; // 100g
        validTokenIds[250000]  = true; // 250g
        validTokenIds[500000]  = true; // 500g
        validTokenIds[1000000] = true; // 1kg
    }

    // ─── Propose Mint ─────────────────────────────────────────────────────────
    /**
     * @notice Le gardien propose un mint après réception d'un lingot
     * @param tokenId   Poids en mg (ex: 1000 = 1g)
     * @param amount    Nombre de lingots du même type
     * @param to        Adresse destinataire (coffre ou client)
     * @param serialCode Numéro de série pré-attribué par le gardien
     * @param refiner   Nom du raffineur (ex: Valcambi)
     * @param supplier  Nom du gardien/fournisseur (ex: Brink's)
     * @param origin    Pays d'origine (ex: Suisse)
     */
    function proposeMint(
        uint256 tokenId,
        uint256 amount,
        address to,
        string calldata serialCode,
        string calldata refiner,
        string calldata supplier,
        string calldata origin
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256 proposalId) {
        if (!validTokenIds[tokenId]) revert InvalidTokenId(tokenId);
        if (amount == 0)             revert InvalidAmount();
        if (to == address(0))        revert InvalidAddress();

        proposalId = ++mintProposalCount;
        mintProposals[proposalId] = MintProposal({
            tokenId:    tokenId,
            amount:     amount,
            to:         to,
            serialCode: serialCode,
            refiner:    refiner,
            supplier:   supplier,
            origin:     origin,
            executed:   false,
            rejected:   false,
            proposedBy: msg.sender,
            proposedAt: block.timestamp
        });

        emit MintProposed(proposalId, tokenId, to, serialCode, msg.sender);
    }

    /**
    * @notice Le gardien propose plusieurs mints en une seule transaction
    * @dev Tous les lingots partagent le même raffineur, gardien et origine
    */
    function proposeMintBatch(
        MintProposalInput[] calldata inputs,
        string calldata refiner,
        string calldata supplier,
        string calldata origin
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256[] memory proposalIds) {
        uint256 len = inputs.length;
        require(len > 0, "Empty batch");

        proposalIds = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            if (!validTokenIds[inputs[i].tokenId]) revert InvalidTokenId(inputs[i].tokenId);
            if (inputs[i].amount == 0)             revert InvalidAmount();
            if (inputs[i].to == address(0))        revert InvalidAddress();

            uint256 proposalId = ++mintProposalCount;
            mintProposals[proposalId] = MintProposal({
                tokenId:    inputs[i].tokenId,
                amount:     inputs[i].amount,
                to:         inputs[i].to,
                serialCode: inputs[i].serialCode,
                refiner:    refiner,
                supplier:   supplier,
                origin:     origin,
                executed:   false,
                rejected:   false,
                proposedBy: msg.sender,
                proposedAt: block.timestamp
            });

            proposalIds[i] = proposalId;
            emit MintProposed(proposalId, inputs[i].tokenId, inputs[i].to, inputs[i].serialCode, msg.sender);
        }
    }

    // ─── Approve Mint ─────────────────────────────────────────────────────────
    /**
     * @notice InvestOr (Safe) valide le mint après rapprochement BL/facture
     */
    function approveMint(uint256 proposalId)
        external
        onlyRole(VALIDATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        MintProposal storage p = mintProposals[proposalId];
        if (p.proposedAt == 0)  revert ProposalNotFound(proposalId);
        if (p.executed)         revert ProposalAlreadyExecuted(proposalId);
        if (p.rejected)         revert ProposalAlreadyRejected(proposalId);

        p.executed = true;

        // Mint ERC-1155
        _mint(p.to, p.tokenId, p.amount, "");

        // Génération numéro de série on-chain
        serialNumber.generate(p.to);

        emit MintApproved(proposalId, p.tokenId, p.to, p.amount, p.serialCode);
    }

    /**
    * @notice InvestOr (Safe) valide plusieurs mints en une seule transaction
    */
    function approveMintBatch(uint256[] calldata proposalIds)
        external
        onlyRole(VALIDATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        for (uint256 i = 0; i < proposalIds.length; i++) {
            MintProposal storage p = mintProposals[proposalIds[i]];
            if (p.proposedAt == 0) revert ProposalNotFound(proposalIds[i]);
            if (p.executed)        revert ProposalAlreadyExecuted(proposalIds[i]);
            if (p.rejected)        revert ProposalAlreadyRejected(proposalIds[i]);

            p.executed = true;
            _mint(p.to, p.tokenId, p.amount, "");
            serialNumber.generate(p.to);

            emit MintApproved(proposalIds[i], p.tokenId, p.to, p.amount, p.serialCode);
        }
    }

    // ─── Reject Mint ──────────────────────────────────────────────────────────
    function rejectMint(uint256 proposalId)
        external
        onlyRole(VALIDATOR_ROLE)
    {
        MintProposal storage p = mintProposals[proposalId];
        if (p.proposedAt == 0) revert ProposalNotFound(proposalId);
        if (p.executed)        revert ProposalAlreadyExecuted(proposalId);
        if (p.rejected)        revert ProposalAlreadyRejected(proposalId);

        p.rejected = true;
        emit MintRejected(proposalId, msg.sender);
    }

    // ─── Propose Burn ─────────────────────────────────────────────────────────
    /**
     * @notice Le gardien propose un burn (expédition physique, non-conformité, refonte)
     * @param reason "livraison physique" | "non conforme" | "refonte" | autre
     */
    function proposeBurn(
        uint256 tokenId,
        uint256 amount,
        address from,
        string calldata serialCode,
        string calldata reason
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256 proposalId) {
        if (!validTokenIds[tokenId]) revert InvalidTokenId(tokenId);
        if (amount == 0)             revert InvalidAmount();
        if (from == address(0))      revert InvalidAddress();
        if (balanceOf(from, tokenId) < amount)
            revert InsufficientBalance(from, tokenId, amount);

        proposalId = ++burnProposalCount;
        burnProposals[proposalId] = BurnProposal({
            tokenId:    tokenId,
            amount:     amount,
            from:       from,
            serialCode: serialCode,
            reason:     reason,
            executed:   false,
            rejected:   false,
            proposedBy: msg.sender,
            proposedAt: block.timestamp
        });

        emit BurnProposed(proposalId, tokenId, from, reason, msg.sender);
    }

    function proposeBurnBatch(
        BurnProposalInput[] calldata inputs,
        string calldata reason
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256[] memory proposalIds) {
        uint256 len = inputs.length;
        require(len > 0, "Empty batch");

        proposalIds = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            if (!validTokenIds[inputs[i].tokenId]) revert InvalidTokenId(inputs[i].tokenId);
            if (inputs[i].amount == 0)             revert InvalidAmount();
            if (inputs[i].from == address(0))      revert InvalidAddress();
            if (balanceOf(inputs[i].from, inputs[i].tokenId) < inputs[i].amount)
                revert InsufficientBalance(inputs[i].from, inputs[i].tokenId, inputs[i].amount);

            uint256 proposalId = ++burnProposalCount;
            burnProposals[proposalId] = BurnProposal({
                tokenId:    inputs[i].tokenId,
                amount:     inputs[i].amount,
                from:       inputs[i].from,
                serialCode: inputs[i].serialCode,
                reason:     reason,
                executed:   false,
                rejected:   false,
                proposedBy: msg.sender,
                proposedAt: block.timestamp
            });

            proposalIds[i] = proposalId;
            emit BurnProposed(proposalId, inputs[i].tokenId, inputs[i].from, reason, msg.sender);
        }
    }

    // ─── Approve Burn ─────────────────────────────────────────────────────────
    function approveBurn(uint256 proposalId)
        external
        onlyRole(VALIDATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        BurnProposal storage p = burnProposals[proposalId];
        if (p.proposedAt == 0) revert ProposalNotFound(proposalId);
        if (p.executed)        revert ProposalAlreadyExecuted(proposalId);
        if (p.rejected)        revert ProposalAlreadyRejected(proposalId);

        p.executed = true;

        // Burn ERC-1155
        _burn(p.from, p.tokenId, p.amount);

        // Désactivation numéro de série — cherche l'id depuis le code
        try serialNumber.getSerialByCode(p.serialCode) returns (
            uint256 serialId, string memory, address, bool active, uint256
        ) {
            if (active) serialNumber.deactivate(serialId);
        } catch {}

        emit BurnApproved(proposalId, p.tokenId, p.from, p.amount, p.serialCode);
    }

    function approveBurnBatch(uint256[] calldata proposalIds)
        external
        onlyRole(VALIDATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        for (uint256 i = 0; i < proposalIds.length; i++) {
            BurnProposal storage p = burnProposals[proposalIds[i]];
            if (p.proposedAt == 0) revert ProposalNotFound(proposalIds[i]);
            if (p.executed)        revert ProposalAlreadyExecuted(proposalIds[i]);
            if (p.rejected)        revert ProposalAlreadyRejected(proposalIds[i]);

            p.executed = true;
            _burn(p.from, p.tokenId, p.amount);

            try serialNumber.getSerialByCode(p.serialCode) returns (
                uint256 serialId, string memory, address, bool active, uint256
            ) {
                if (active) serialNumber.deactivate(serialId);
            } catch {}

            emit BurnApproved(proposalIds[i], p.tokenId, p.from, p.amount, p.serialCode);
        }
    }

    // ─── Reject Burn ──────────────────────────────────────────────────────────
    function rejectBurn(uint256 proposalId)
        external
        onlyRole(VALIDATOR_ROLE)
    {
        BurnProposal storage p = burnProposals[proposalId];
        if (p.proposedAt == 0) revert ProposalNotFound(proposalId);
        if (p.executed)        revert ProposalAlreadyExecuted(proposalId);
        if (p.rejected)        revert ProposalAlreadyRejected(proposalId);

        p.rejected = true;
        emit BurnRejected(proposalId, msg.sender);
    }

    // ─── Proof of Reserve ─────────────────────────────────────────────────────
    /**
     * @notice Retourne le total de grammes d'or tokenisés en coffre
     * @dev Utilisé par Reserve.sol pour le Proof of Reserve V2
     */
    function totalGrammesEnCoffre() public view returns (uint256 total) {
        uint256[10] memory ids = [
            uint256(1000), uint256(5000), uint256(10000), uint256(20000),
            uint256(31103), uint256(50000), uint256(100000),
            uint256(250000), uint256(500000), uint256(1000000)
        ];
        for (uint256 i = 0; i < ids.length; i++) {
            // totalSupply(tokenId) * poids_mg / 1000 = grammes
            total += totalSupply(ids[i]) * ids[i];
            // 1 * 1000 = 1000 mg = 1g ✅
        }
    }

    // ─── Vues ────────────────────────────────────────────────────────────────
    function getMintProposal(uint256 proposalId)
        external view returns (MintProposal memory) {
        return mintProposals[proposalId];
    }

    function getBurnProposal(uint256 proposalId)
        external view returns (BurnProposal memory) {
        return burnProposals[proposalId];
    }

    // ─── URI ──────────────────────────────────────────────────────────────────
    function uri(uint256 tokenId) public view override returns (string memory) {
        if (tokenId == 1000)    return string.concat(_baseURI, "lingot-1g.json");
        if (tokenId == 5000)    return string.concat(_baseURI, "lingot-5g.json");
        if (tokenId == 10000)   return string.concat(_baseURI, "lingot-10g.json");
        if (tokenId == 20000)   return string.concat(_baseURI, "lingot-20g.json");
        if (tokenId == 31103)   return string.concat(_baseURI, "lingot-1once.json");
        if (tokenId == 50000)   return string.concat(_baseURI, "lingot-50g.json");
        if (tokenId == 100000)  return string.concat(_baseURI, "lingot-100g.json");
        if (tokenId == 250000)  return string.concat(_baseURI, "lingot-250g.json");
        if (tokenId == 500000)  return string.concat(_baseURI, "lingot-500g.json");
        if (tokenId == 1000000) return string.concat(_baseURI, "lingot-1kg.json");
        revert InvalidTokenId(tokenId);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────
    function setSerialNumber(address newAddr) external onlyOwner {
        if (newAddr == address(0)) revert InvalidAddress();
        emit SerialNumberUpdated(address(serialNumber), newAddr);
        serialNumber = ISerialNumber(newAddr);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        _baseURI = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── UUPS ─────────────────────────────────────────────────────────────────
    function _authorizeUpgrade(address newImplementation)
        internal override onlyOwner {}

    // ─── Overrides requis ─────────────────────────────────────────────────────
    function _update(
        address from, address to, uint256[] memory ids, uint256[] memory values
    ) internal override(ERC1155Upgradeable, ERC1155SupplyUpgradeable) {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ─── Storage gap ──────────────────────────────────────────────────────────
    uint256[46] private __gap;
}
