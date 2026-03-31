// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title SerialNumber — Génération de numéros de série pour lingots physiques
/// @notice Génère des numéros au format PREFIX-YYYY-NNNNNN (ex: GLD-2025-000001)
/// @dev Prévu pour être lié aux futurs tokens ERC-1155 (lingots)
/// @dev Seuls les émetteurs autorisés peuvent générer des numéros
contract SerialNumber is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    // ─── Types ───────────────────────────────────────────────────────────────

    struct Serial {
        uint256 id;          // identifiant séquentiel global
        string  serialCode;  // numéro lisible : GLD-2025-000001
        string  prefix;      // préfixe de la série (ex: GLD, KILO, TONNE)
        uint16  year;        // année d'émission
        uint256 counter;     // compteur dans la série (pour cette année)
        address issuedTo;    // adresse du détenteur initial
        uint256 issuedAt;    // timestamp d'émission
        bool    active;      // false si lingot retiré/fondu
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @dev Émetteurs autorisés à générer des numéros de série
    mapping(address => bool) public authorizedIssuers;

    /// @dev Compteur par préfixe + année : prefix => year => counter
    mapping(string => mapping(uint16 => uint256)) private _counters;

    /// @dev Tous les serials enregistrés : id => Serial
    mapping(uint256 => Serial) private _serials;

    /// @dev Index par code lisible pour vérifier l'unicité : serialCode => id
    mapping(string => uint256) private _codeToId;

    /// @dev Index par détenteur : address => ids[]
    mapping(address => uint256[]) private _holderSerials;

    /// @dev Compteur global d'ids (commence à 1)
    uint256 private _nextId;

    /// @dev Préfixe par défaut
    string public defaultPrefix;

    // ─── Events ──────────────────────────────────────────────────────────────

    event SerialGenerated(
        uint256 indexed id,
        string  serialCode,
        string  prefix,
        uint16  year,
        uint256 counter,
        address indexed issuedTo,
        address indexed issuer
    );
    event SerialDeactivated(uint256 indexed id, address indexed by);
    event SerialTransferred(uint256 indexed id, address indexed from, address indexed to);
    event IssuerAuthorized(address indexed issuer);
    event IssuerRevoked(address indexed issuer);
    event DefaultPrefixUpdated(string oldPrefix, string newPrefix);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error UnauthorizedIssuer(address caller);
    error ZeroAddress();
    error EmptyPrefix();
    error SerialNotFound(uint256 id);
    error SerialInactive(uint256 id);
    error SerialCodeExists(string code);
    error InvalidYear(uint16 year);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyIssuer() {
        if (!authorizedIssuers[msg.sender] && msg.sender != owner())
            revert UnauthorizedIssuer(msg.sender);
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialise le contrat
    /// @param initialOwner  Propriétaire
    /// @param initPrefix    Préfixe par défaut (ex: "GLD")
    function initialize(
        address initialOwner,
        string calldata initPrefix
    ) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (bytes(initPrefix).length == 0) revert EmptyPrefix();

        __Ownable_init(initialOwner);
        //_UUPSUpgradeable_init();

        defaultPrefix = initPrefix;
        _nextId = 1; // les ids commencent à 1 (0 = non existant)
    }

    // ─── Génération ──────────────────────────────────────────────────────────

    /// @notice Génère un numéro de série avec le préfixe par défaut
    /// @param issuedTo Adresse du détenteur initial du lingot
    /// @return id         Identifiant séquentiel global
    /// @return serialCode Numéro lisible (ex: GLD-2025-000001)
    function generate(address issuedTo)
        external
        onlyIssuer
        returns (uint256 id, string memory serialCode)
    {
        return _generate(defaultPrefix, issuedTo);
    }

    /// @notice Génère un numéro de série avec un préfixe personnalisé
    /// @param prefix   Préfixe de la série (ex: "KILO", "TONNE")
    /// @param issuedTo Adresse du détenteur initial
    function generateWithPrefix(string calldata prefix, address issuedTo)
        external
        onlyIssuer
        returns (uint256 id, string memory serialCode)
    {
        if (bytes(prefix).length == 0) revert EmptyPrefix();
        return _generate(prefix, issuedTo);
    }

    /// @notice Génère un numéro de série pour une année spécifique
    /// @dev Utile pour émettre des numéros antidatés (migration de stock physique)
    /// @param prefix   Préfixe
    /// @param year     Année (ex: 2025)
    /// @param issuedTo Adresse du détenteur
    function generateForYear(string calldata prefix, uint16 year, address issuedTo)
        external
        onlyOwner  // réservé au owner — action sensible
        returns (uint256 id, string memory serialCode)
    {
        if (bytes(prefix).length == 0) revert EmptyPrefix();
        if (year < 2020 || year > 2100) revert InvalidYear(year);
        return _generateForYear(prefix, year, issuedTo);
    }

    // ─── Gestion des serials ──────────────────────────────────────────────────

    /// @notice Désactive un numéro de série (lingot fondu ou retiré)
    function deactivate(uint256 id) external onlyIssuer {
        if (_serials[id].issuedAt == 0) revert SerialNotFound(id);
        if (!_serials[id].active) revert SerialInactive(id);
        _serials[id].active = false;
        emit SerialDeactivated(id, msg.sender);
    }

    /// @notice Transfère l'association d'un serial vers une nouvelle adresse
    function transfer(uint256 id, address to) external onlyIssuer {
        if (_serials[id].issuedAt == 0) revert SerialNotFound(id);
        if (!_serials[id].active) revert SerialInactive(id);
        if (to == address(0)) revert ZeroAddress();

        address from = _serials[id].issuedTo;
        _serials[id].issuedTo = to;
        _holderSerials[to].push(id);

        emit SerialTransferred(id, from, to);
    }

    // ─── Vues ─────────────────────────────────────────────────────────────────

    /// @notice Retourne un serial par son id
    function getSerial(uint256 id) external view returns (Serial memory) {
        if (_serials[id].issuedAt == 0) revert SerialNotFound(id);
        return _serials[id];
    }

    /// @notice Retourne un serial par son code lisible
    function getSerialByCode(string calldata code) external view returns (Serial memory) {
        uint256 id = _codeToId[code];
        if (id == 0) revert SerialNotFound(0);
        return _serials[id];
    }

    /// @notice Vérifie si un code de série existe déjà
    function exists(string calldata code) external view returns (bool) {
        return _codeToId[code] != 0;
    }

    /// @notice Retourne le nombre total de serials générés
    function totalGenerated() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @notice Retourne le prochain compteur pour un préfixe + année
    function nextCounter(string calldata prefix, uint16 year) external view returns (uint256) {
        return _counters[prefix][year] + 1;
    }

    /// @notice Retourne les ids des serials d'un détenteur
    function getSerialsOf(address holder) external view returns (uint256[] memory) {
        return _holderSerials[holder];
    }

    /// @notice Retourne l'année courante (depuis le timestamp du bloc)
    function currentYear() public view returns (uint16) {
        return _getYear(block.timestamp);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function authorizeIssuer(address issuer) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        authorizedIssuers[issuer] = true;
        emit IssuerAuthorized(issuer);
    }

    function revokeIssuer(address issuer) external onlyOwner {
        authorizedIssuers[issuer] = false;
        emit IssuerRevoked(issuer);
    }

    function setDefaultPrefix(string calldata newPrefix) external onlyOwner {
        if (bytes(newPrefix).length == 0) revert EmptyPrefix();
        emit DefaultPrefixUpdated(defaultPrefix, newPrefix);
        defaultPrefix = newPrefix;
    }

    // ─── Internes ────────────────────────────────────────────────────────────

    function _generate(string memory prefix, address issuedTo)
        internal
        returns (uint256, string memory)
    {
        uint16 year = _getYear(block.timestamp);
        return _generateForYear(prefix, year, issuedTo);
    }

    function _generateForYear(string memory prefix, uint16 year, address issuedTo)
        internal
        returns (uint256 id, string memory serialCode)
    {
        if (issuedTo == address(0)) revert ZeroAddress();

        // Incrémenter le compteur de cette série
        _counters[prefix][year]++;
        uint256 counter = _counters[prefix][year];

        // Construire le code lisible : PREFIX-YYYY-NNNNNN
        serialCode = _buildCode(prefix, year, counter);

        // Garantir l'unicité
        if (_codeToId[serialCode] != 0) revert SerialCodeExists(serialCode);

        // Enregistrer
        id = _nextId++;
        _serials[id] = Serial({
            id:         id,
            serialCode: serialCode,
            prefix:     prefix,
            year:       year,
            counter:    counter,
            issuedTo:   issuedTo,
            issuedAt:   block.timestamp,
            active:     true
        });

        _codeToId[serialCode] = id;
        _holderSerials[issuedTo].push(id);

        emit SerialGenerated(id, serialCode, prefix, year, counter, issuedTo, msg.sender);
    }

    /// @dev Construit le code lisible : PREFIX-YYYY-NNNNNN
    function _buildCode(string memory prefix, uint16 year, uint256 counter)
        internal
        pure
        returns (string memory)
    {
        return string(abi.encodePacked(
            prefix,
            "-",
            _uint16ToString(year),
            "-",
            _padLeft(counter, 6)
        ));
    }

    /// @dev Convertit un uint16 en string (pour l'année)
    function _uint16ToString(uint16 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint16 temp = value;
        uint8 digits = 0;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint8(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /// @dev Formate un uint256 avec zéros à gauche jusqu'à `width` chiffres
    function _padLeft(uint256 value, uint8 width) internal pure returns (string memory) {
        bytes memory buffer = new bytes(width);
        for (uint8 i = 0; i < width; i++) {
            buffer[width - 1 - i] = bytes1(uint8(48 + uint8(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /// @dev Extrait l'année depuis un timestamp Unix (approximation en secondes)
    function _getYear(uint256 timestamp) internal pure returns (uint16) {
        // Calcul simplifié : basé sur le nombre de secondes depuis 1970
        // Précision suffisante pour des numéros de série (±1 jour en fin d'année)
        uint256 secondsPerYear = 365 days;
        uint256 year = 1970 + timestamp / secondsPerYear;
        return uint16(year);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────

    /// @dev Variables : authorizedIssuers(1)+_counters(1)+_serials(1)+_codeToId(1)
    /// @dev   +_holderSerials(1)+_nextId(1)+defaultPrefix(1) = 7 slots
    uint256[43] private __gap;
}
