// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title DomainToken
/// @notice Test-only fixture exposing `name()` and `version()` as on-chain,
///         queryable view functions -- exactly the two fields (together with
///         `chainid` and the contract's own address) a facilitator's
///         `/verify` must read from the token contract to build the correct
///         EIP-712 domain, per Task 7's spec ("the EIP-712 domain must be
///         read from the token contract on-chain ... not hardcoded").
///
///         Deliberately uses a NON-standard name/version pair (neither the
///         real "USD Coin"/"2" Base mainnet domain, nor a common guess like
///         version "1"). If a verifier under test hardcoded either field
///         instead of reading it from chain, every signature test against
///         this fixture would fail to recover the correct signer -- that
///         mismatch is the whole point of using an unusual pair here.
///
///         `mint`/`balanceOf` (final whole-branch review, C1) were added
///         alongside the original two domain fields, not in place of them:
///         `verifyPayment` now reads `balanceOf(authorization.from)` live
///         from `requirements.asset` on every call (the payer-balance check
///         that makes `/verify` predictive of settleability, not merely of
///         signature validity — see chains/base.ts's doc comment on that
///         check). `DomainToken` is still deliberately incapable of
///         executing a real EIP-3009 transfer (see `SettleToken.sol`'s doc
///         comment for why that gap exists and what fixture fills it for
///         settlement tests); this only adds enough ERC20-shape surface for
///         the balance check itself to have something real to call,
///         mirroring `SettleToken.sol`'s identical `mint`/`balanceOf` pair.
contract DomainToken {
    string public name;
    string public version;

    mapping(address => uint256) private _balances;

    constructor(string memory name_, string memory version_) {
        name = name_;
        version = version_;
    }

    /// @notice Test-only faucet. Deliberately unguarded, matching
    ///         SettleToken.sol/MockUSDC.sol's identical `mint`.
    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }
}
